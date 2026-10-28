/**
 * dsh-remote-console — DSH 右侧「远程控制终端」
 *
 * 设计要点（详见 remote_console_design.md）：
 *  - 不新增终端类型：在 `ctx.terminalController.shells()` 的返回列表里追加一个
 *    `dsh-ssh` 包装器，这样右侧栏「新建终端」的 shell 菜单里就多一项。
 *  - 包装器在终端里用键盘菜单选远端，然后执行
 *    `ssh -F <cfg> -M -S <sock> -t <host>`；密码只由 ssh 自己在其提示符里读取。
 *  - 插件包住 `ctx.subprocess.spawnTerminal`，对「包装器的 PTY」做无侵入 tee：
 *    控制器照常收到一个 PassThrough（侧栏渲染不变），插件留一份字节流。
 *  - 同一条字节流既有人敲的命令回显，也有 agent 写入的命令和两边输出（密码因
 *    echo 关闭不在其中），因此落成一份统一 JSONL 日志，agent 用 cursor 增量读。
 *  - agent 的写入直接进同一个 PTY（`handle.write`），窗口里就像人在打字。
 *  - 关终端标签 → 控制器杀进程树；关浏览器 → 最后一个 retain hold 消失后宽限
 *    8 秒（刷新会重连取消）再杀；DSH 崩溃 → PTY master 消失、ssh 自行退出。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { PassThrough } from 'node:stream';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-remote-console';
export const inject = ['subprocess', 'terminalController'];

/**
 * 只有 volatile 字段会出现在 DSH 设置面板的插件配置页里（客户端 plugins.row.config
 * 页面编辑的就是它）。这里只放「主机列表」一项：每行一个 ssh 配置别名或
 * user@host[:port]，保存后由宿主侧重新生成侧栏启动器。
 */
export const Config = z.object({
  hosts: z
    .string()
    .default('')
    .volatile()
    .description(
      'One host per line: an ssh-config alias, or user@host[:port]. Lines starting with # are ignored.',
    ),
});

const RC_DIR = process.env.DSH_REMOTE_CONSOLE_DIR ?? join(resolveDshHome(), 'remote-console');
const BIN_DIR = join(RC_DIR, 'bin');
const LOG_DIR = join(RC_DIR, 'logs');
const SESS_DIR = join(RC_DIR, 'sessions');
const SOCK_DIR = join(RC_DIR, 'socks');
const AUDIT_DIR = join(RC_DIR, 'audit');
const AUDIT_FILE = join(AUDIT_DIR, 'audit.jsonl');
/** 随包发布的菜单包装器（不往用户数据目录拷贝）。 */
const WRAPPER = fileURLToPath(new URL('../bin/dsh-ssh', import.meta.url));
/** 没有 bash 的平台（Windows）用 Node 版包装器；测试可用 DSH_RC_FORCE_NODE_LAUNCHERS=1 强制。 */
const WRAPPER_MJS = fileURLToPath(new URL('../bin/dsh-ssh.mjs', import.meta.url));
const SSH_CONFIG = process.env.DSH_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
let sshPrefixCache = null;
/**
 * 通用 ssh 配置前缀：正常情况下直接用系统默认配置；只有当默认配置不可读
 * （例如企业镜像把 /etc/ssh 属主改错导致 "Bad owner or permissions"）才退回
 * `-F ~/.ssh/config`。这样在别的机器上不会平白绕过系统 ssh 配置。
 */
function sshConfigPrefix() {
  // 显式指定了配置文件（DSH_SSH_CONFIG）就一路用它：终端包装器和 exec/传输通道
  // 必须解析到同一台主机、同一套密钥，不能一边用默认配置一边用覆盖配置。
  const override = process.env.DSH_SSH_CONFIG;
  if (typeof override === 'string' && override.length > 0) {
    return Promise.resolve(['-F', override]);
  }
  if (sshPrefixCache !== null) return sshPrefixCache;
  sshPrefixCache = new Promise((resolve) => {
    execFile('ssh', ['-G', 'localhost'], { timeout: 5000 }, (error, _stdout, stderr) => {
      const broken = error !== null && /bad owner or permissions/i.test(String(stderr ?? ''));
      if (!broken) return resolve([]);
      resolve(existsSync(SSH_CONFIG) ? ['-F', SSH_CONFIG] : ['-F', '/dev/null']);
    });
  });
  return sshPrefixCache;
}
const SELFTEST = process.env.DSH_RC_SELFTEST === '1';
const FORCE_SENTINEL = process.env.DSH_RC_FORCE_SENTINEL === '1';
const DEBUG_LOG = join(RC_DIR, 'plugin.log');

const MAX_TEXT_CHARS = 256 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const AUTH_TAIL_CHARS = 2048;
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_MS = 40;
const CLOSE_GRACE_MS = 8000;
/** 终端已经结束时的统一提示：这里的包装器是一次性的，ssh 退出后 console 不复活。 */
const ENDED_NOTE =
  '终端已结束（ssh 退出或窗口关闭），所有 remote_* 工具都会失败；请人工在右侧栏重新打开 SSH 终端并重新登录';
const STATE_KEY = Symbol.for('dsh.remote-console.state');

const ESC = '\x1b';
const BEL = '\x07';
const beginMarker = (nonce) => `${ESC}]1337;DSH;B;${nonce}${BEL}`;
const endMarker = (nonce) => `${ESC}]1337;DSH;E;${nonce}${BEL}`;
const END_RE = (nonce) => new RegExp(`${ESC}\\]1337;DSH;E;${nonce.replace(/[^a-z0-9]/gi, '')};(\\d+)${BEL}`);
const ANSI_RE = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`,
  'g',
);
const AUTH_RE =
  /(?:password|passphrase|passcode|密码|口令)[^\n\r]{0,60}:\s*$|are you sure you want to continue connecting|permission denied|host key verification failed/i;

function state() {
  if (globalThis[STATE_KEY] === undefined) {
    globalThis[STATE_KEY] = {
      installed: false,
      config: {},
      wrappers: {},
      consoles: new Map(),
      idToPid: new Map(),
      holders: new Map(),
      graceTimers: new Map(),
      // 端口转发子进程：console 结束、remote_close 或插件卸载时统一回收，
      // 避免留下还在监听的 `ssh -N -L` 进程。
      forwards: new Map(),
      forwardSeq: 0,
      log: [],
    };
  }
  return globalThis[STATE_KEY];
}

const S = state();

function debug(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  S.log.push(entry);
  if (S.log.length > 400) S.log.shift();
  try {
    appendFileSync(DEBUG_LOG, `${entry}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * 进程启动时清扫上一进程遗留的 rendezvous / socket 文件。
 * 新进程还没有任何 console，所以这些文件必然是陈旧的（DSH 重启不会执行旧进程的清理）。
 */
/** 设置页里允许的写法：ssh 别名、user@host、host:port、user@host:port（IPv6 用 []）。 */
const CONFIG_HOST_LINE = /^[A-Za-z0-9._@:/[\]-]+$/u;

/** 纯别名（交给 ssh 配置解析）还是直接目标（面板启动器用 --target）。 */
function isDirectTarget(spec) {
  return spec.includes('@') || spec.includes(':');
}

/**
 * 读设置页里的主机列表文本。volatile 字段在 cordis 里可能是 `{ get() }` 形式的引用
 * （schemastery 的 createVolatile），这里同时接受引用与普通字符串。
 */
function configHostsText() {
  const raw = S.config?.hosts;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    const value = raw.get();
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/** 把设置页的多行文本解析成主机列表：去空行/注释、去重、拒绝非法字符。 */
function configHostLines() {
  const raw = configHostsText();
  const lines = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    if (!CONFIG_HOST_LINE.test(text)) {
      debug(`config host skipped (invalid characters): ${text}`);
      continue;
    }
    if (!lines.includes(text)) lines.push(text);
  }
  return lines;
}

/** 读取 ~/.ssh/config、设置页主机列表与 hosts.tsv 里的远端主机（供面板/启动器使用）。 */
function discoverHosts() {
  const hosts = new Set();
  try {
    const text = readFileSync(SSH_CONFIG, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*Host\s+(.+)$/i.exec(line);
      if (match === null) continue;
      for (const token of match[1].trim().split(/\s+/)) {
        if (token.length === 0 || token.startsWith('!') || /[?*]/.test(token)) continue;
        hosts.add(token);
      }
    }
  } catch {
    /* 没有 ssh config 就没有别名主机 */
  }
  try {
    const text = readFileSync(join(RC_DIR, 'hosts.tsv'), 'utf8');
    for (const line of text.split('\n')) {
      const host = line.split('\t')[0]?.trim();
      if (host !== undefined && host.length > 0) hosts.add(host);
    }
  } catch {
    /* 没有自定义主机 */
  }
  // 设置页里配置的纯别名（user@host:port 这类直连目标由 ensureHostLaunchers 单独生成）
  for (const spec of configHostLines()) {
    if (!isDirectTarget(spec)) hosts.add(spec);
  }
  return [...hosts];
}

/** Windows 没有 bash：启动器直接是 `node dsh-ssh.mjs <flag> <spec>`。 */
function useNodeLaunchers() {
  return process.platform === 'win32' || process.env.DSH_RC_FORCE_NODE_LAUNCHERS === '1';
}

function nodeLauncher(spec, flag, name) {
  return { path: process.execPath, name: name ?? `SSH ${spec}`, args: [WRAPPER_MJS, flag, spec] };
}

/** 为每个主机生成一个启动器脚本（用参数传 host，避免符号链接被 realpath 解析掉）。 */
function ensureHostLaunchers(hosts, targets = []) {
  const created = [];
  if (useNodeLaunchers()) {
    for (const host of hosts) created.push(nodeLauncher(host, '--host'));
    for (const spec of targets) created.push(nodeLauncher(spec, '--target'));
    return created;
  }
  const live = new Set();
  for (const host of hosts) {
    const safe = host.replace(/[^A-Za-z0-9._-]/g, '_');
    const file = join(BIN_DIR, `dsh-ssh-${safe}`);
    live.add(file);
    const body = `#!/bin/sh\nexec ${JSON.stringify(WRAPPER)} --host ${JSON.stringify(host)} "$@"\n`;
    try {
      let current;
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = undefined;
      }
      if (current !== body) {
        writeFileSync(file, body, { mode: 0o755 });
        chmodSync(file, 0o755);
      }
      created.push({ host, path: file, name: `SSH ${host}` });
    } catch (error) {
      debug(`launcher failed for ${host}: ${String(error?.message ?? error)}`);
    }
  }
  // 设置页里的直连目标（user@host:port）：走包装器的 --target，跳过菜单。
  for (const spec of targets) {
    const safe = spec.replace(/[^A-Za-z0-9._-]/g, '_');
    const file = join(BIN_DIR, `dsh-ssh-t-${safe}`);
    live.add(file);
    const body = `#!/bin/sh\nexec ${JSON.stringify(WRAPPER)} --target ${JSON.stringify(spec)} "$@"\n`;
    try {
      let current;
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = undefined;
      }
      if (current !== body) {
        writeFileSync(file, body, { mode: 0o755 });
        chmodSync(file, 0o755);
      }
      created.push({ host: spec, path: file, name: `SSH ${spec}` });
    } catch (error) {
      debug(`target launcher failed for ${spec}: ${String(error?.message ?? error)}`);
    }
  }
  // 端口/别名从 ssh config 里删掉后，旧启动器不该继续出现在下拉里。
  try {
    for (const file of readdirSync(BIN_DIR)) {
      if (!file.startsWith('dsh-ssh-')) continue;
      const full = join(BIN_DIR, file);
      if (live.has(full)) continue;
      try {
        rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return created;
}

/**
 * 「新建会话」启动器：终端一开就问 user@host[:port]，然后直接进 ssh，不显示菜单。
 * 名字带 `SSH ` 前缀，客户端会把它从原生「新建终端」下拉里滤掉。
 */
function ensureNewSessionLauncher() {
  if (useNodeLaunchers()) return nodeLauncher('--ask-target', '--ask-target', 'SSH 新建会话');
  const file = join(BIN_DIR, 'dsh-ssh-new');
  const body = `#!/bin/sh\nexec ${JSON.stringify(WRAPPER)} --ask-target "$@"\n`;
  try {
    let current;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== body) {
      writeFileSync(file, body, { mode: 0o755 });
      chmodSync(file, 0o755);
    }
    return { path: file, name: 'SSH 新建会话' };
  } catch (error) {
    debug(`launcher failed for new-session: ${String(error?.message ?? error)}`);
    return undefined;
  }
}

function sweepStaleFiles() {
  for (const dir of [SESS_DIR, SOCK_DIR]) {
    try {
      for (const file of readdirSync(dir)) {
        try {
          rmSync(join(dir, file), { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  // 会话日志在 PTY 结束时删除；新进程启动时还留在磁盘上的，只可能是上一次
  // 进程崩溃/被 kill 的残留（里面可能有用户敲过的命令），启动即清掉。
  try {
    for (const file of readdirSync(LOG_DIR)) {
      if (!file.endsWith('.jsonl') && !/\.jsonl\.\d+$/u.test(file)) continue;
      try {
        rmSync(join(LOG_DIR, file), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  debug('startup sweep done');
}

function ensureDirs() {
  for (const dir of [RC_DIR, BIN_DIR, LOG_DIR, SESS_DIR, SOCK_DIR, AUDIT_DIR]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
  }
}

function sanitize(text) {
  const stripped = text.replace(ANSI_RE, '');
  return stripped
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = line.lastIndexOf('\r');
      return idx >= 0 ? line.slice(idx + 1) : line;
    })
    .join('\n');
}

/**
 * 定位终端回显的命令并返回应跳过的前缀长度。
 * readline 在重绘时可能插入空格/重复字符（实测 bash 4.2 + 窄终端），
 * 所以按"去掉所有空白后匹配"的方式找，而不是原文匹配。
 */
function echoSkipLength(captured, command) {
  const target = command.replace(/\s+/g, '');
  if (target.length === 0) return 0;
  let normalized = '';
  const positions = [];
  for (let i = 0; i < captured.length; i += 1) {
    const ch = captured[i];
    if (/\s/.test(ch)) continue;
    normalized += ch;
    positions.push(i);
  }
  const at = normalized.indexOf(target);
  if (at < 0) return 0;
  const endIndex = positions[at + target.length - 1] + 1;
  let cursor = endIndex;
  while (cursor < captured.length && captured[cursor] !== '\n') cursor += 1;
  return Math.min(cursor + 1, captured.length);
}

/** 把命令安全地包成单引号字符串，供 __dsh 函数用。 */
function singleQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * 写日志前脱敏：Bearer token、sk- 密钥、password/token/secret 赋值。
 * 日志只保留会话期间，但仍然不该把密钥落盘。
 */
const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  // 注意不要放 pwd：PWD= 是 shell 里最常见的变量，误脱敏会丢掉正常日志信息。
  /((?:password|passwd|token|secret|api[_-]?key|X-Monitor-Token)\s*[=:]\s*)[^\s'\";]+/gi,
];

function redact(text) {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

/* ─────────────── 危险命令守卫（远端命令绕过 DSH 沙箱，单独补一道审批） ─────────────── */

/**
 * 远端的 `remote_run` / `remote_exec` 完全绕过 DSH 的沙箱与审批（它们只是在
 * 用户已经登录的会话里敲字 / 复用 ControlMaster socket），所以这一层补一道
 * 闸门：命中高危模式时通过 `ctx.approval` 让用户当场确认，一次授权只对本次
 * 命令有效；没有审批服务（headless、未挂载 answerer）时 fail closed。
 *
 * `DSH_RC_DANGER_GUARD=off` 可以关闭（自担风险），但命中记录仍会写进会话日志。
 */
const DANGEROUS_PATTERNS = [
  { id: 'rm-recursive-force', re: /\brm\s+(?:-[A-Za-z]*[rR][A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*[rR][A-Za-z]*|--recursive\b[\s\S]*--force\b|--force\b[\s\S]*--recursive\b)/u },
  { id: 'mkfs', re: /\bmkfs(?:\.[A-Za-z0-9]+)?\b/u },
  { id: 'dd-to-device', re: /\bdd\b[^\n]*\bof=\/dev\//u },
  { id: 'shutdown-or-reboot', re: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff)\b/u },
  { id: 'fork-bomb', re: /:\s*\(\s*\)\s*\{/u },
  { id: 'chmod-777-root', re: /\bchmod\s+(?:-[A-Za-z]+\s+)*777\s+\/(?:\s|$)/u },
  { id: 'disk-overwrite', re: />\s*\/dev\/(?:sd|nvme|hd|vd|xvd)[A-Za-z0-9]/u },
  { id: 'pipe-to-shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/u },
  { id: 'destructive-sql', re: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/iu },
  { id: 'force-push', re: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/u },
  { id: 'delete-home-glob', re: /\brm\s+[^\n]*\s(?:~\/?\*?|\$HOME\/?\*?|\/\*?|\/\s*$)/u },
];

/** @returns {string[]} 命中的危险模式 id（空数组表示安全）。 */
function dangerousMatches(command) {
  const text = String(command ?? '');
  const hits = [];
  for (const { id, re } of DANGEROUS_PATTERNS) {
    if (re.test(text)) hits.push(id);
  }
  return hits;
}

/**
 * 会结束整个 console 的命令。主机侧包装器是"一次性"的：远端 shell 退出 →
 * `ssh` 退出 → PTY 结束，之后所有 `remote_*` 工具都会失效，必须人工重开终端
 * 并重新输密码。这类命令同样不能悄悄执行，走一次审批让用户决定。
 */
const TERMINATING_PATTERNS = [
  { id: 'shell-exit', re: /(?:^|[;&|]\s*)(?:exit|logout)(?:\s+\d+)?\s*;?\s*$/u },
  { id: 'kill-ssh', re: /(?:^|[;&|]\s*)(?:sudo\s+)?pkill\s+(?:-[A-Za-z]+\s+)*ssh\b/u },
];

/** @returns {string[]} 命中「会结束终端」模式的 id。 */
function terminatingMatches(command) {
  const text = String(command ?? '');
  const hits = [];
  for (const { id, re } of TERMINATING_PATTERNS) {
    if (re.test(text)) hits.push(id);
  }
  return hits;
}

/**
 * 命中危险模式时向用户要一次授权。用户拒绝、取消、没有 answerer 或没有
 * approval 服务，都抛错阻止执行。
 */
async function gateDangerousCommand(ctx, exec, command, toolName, cover, { checkTerminating = false } = {}) {
  const termHits = checkTerminating ? terminatingMatches(command) : [];
  const hits = [...dangerousMatches(command), ...termHits];
  if (hits.length === 0) return;
  const terminating = termHits.length > 0;
  const preview = String(command).slice(0, 240);
  const reason = terminating
    ? `这条远端命令会结束整个 SSH 终端（命中 ${hits.join(', ')}），之后所有 remote_* 工具都会失效，需要人工重新登录。命令：${preview}`
    : `远端命令命中危险模式 ${hits.join(', ')}：${preview}`;
  await requireApproval(ctx, exec, {
    toolName,
    cover,
    reason,
    hits,
    cmd: stripArgs(String(command)),
    bypassEnv: true,
  });
}

/**
 * 统一的一次性审批入口：用户拒绝、取消、部署里没有 approval 服务、或调用没有
 * agent 上下文，全部抛错（fail closed）。批准/拒绝都写进会话日志，事后在
 * remote_log 里能看到「何时、批准了什么」。
 */
async function requireApproval(ctx, exec, { toolName, cover, reason, hits, cmd, bypassEnv = false, kind = 'guard' }) {
  if (cover !== undefined) {
    writeEvent(cover, { t: Date.now(), k: kind, tool: toolName, hits, ...(cmd === undefined ? {} : { cmd }) });
  }
  if (bypassEnv && process.env.DSH_RC_DANGER_GUARD === 'off') {
    audit(cover, { tool: toolName, action: 'approval', outcome: 'bypassed', hits, reason, cmd });
    debug(`approval bypassed by env, allowing ${toolName} hits=${hits.join(',')}`);
    return;
  }
  const approval = ctx.get('approval');
  if (approval === undefined) {
    audit(cover, { tool: toolName, action: 'approval', outcome: 'unavailable', hits, reason, cmd });
    throw new Error(`DANGEROUS_BLOCKED: ${reason}。当前部署没有审批服务（ctx.approval），操作未执行。`);
  }
  if (exec?.agent === undefined) {
    audit(cover, { tool: toolName, action: 'approval', outcome: 'no-agent', hits, reason, cmd });
    throw new Error(`DANGEROUS_BLOCKED: ${reason}。此次调用没有 agent 上下文，无法请求审批，操作未执行。`);
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });
  audit(cover, {
    tool: toolName,
    action: 'approval',
    outcome,
    hits,
    reason,
    cmd,
  });
  if (outcome !== 'allowed-once') {
    throw new Error(`DANGEROUS_REJECTED: 用户未批准（${outcome}），操作未执行。`);
  }
  if (cover !== undefined) {
    writeEvent(cover, { t: Date.now(), k: `${kind}-approved`, tool: toolName, hits });
  }
}

/** 文件工具写入敏感路径（~/.ssh、/etc、sudoers…）时补一道审批。 */
async function gateSensitiveWrite(ctx, exec, cover, toolName, remotePath) {
  const hits = sensitiveWriteMatches(remotePath);
  if (hits.length === 0) return;
  const reason = `这条写入会改到敏感路径（${hits.join(', ')}）：${remotePath}。可能改变登录方式或系统配置，请确认。`;
  await requireApproval(ctx, exec, {
    toolName,
    cover,
    reason,
    hits,
    cmd: `write ${remotePath}`,
    kind: 'write-guard',
  });
}

function shortId(host, pid) {
  const safe = (host ?? 'local').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}.${pid}`;
}

function logFileFor(console) {
  return console.logPath;
}

function rotateLog(file) {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(`${file}.2`, `${file}.3`);
  } catch {
    /* ignore */
  }
  try {
    renameSync(`${file}.1`, `${file}.2`);
  } catch {
    /* ignore */
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

function writeEvent(console, event) {
  if (typeof event.s === 'string') event = { ...event, s: redact(event.s) };
  if (typeof event.cmd === 'string') event = { ...event, cmd: redact(event.cmd) };
  const line = `${JSON.stringify(event)}\n`;
  console.events.push(line);
  if (console.events.length > 2000) console.events.shift();
  try {
    const file = logFileFor(console);
    appendFileSync(file, line);
    if (console.logModeFixed !== true) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* ignore */
      }
      console.logModeFixed = true;
    }
    console.logWritesSinceRotate = (console.logWritesSinceRotate ?? 0) + 1;
    if (console.logWritesSinceRotate % 200 === 0) rotateLog(file);
  } catch {
    /* degrade to memory only */
  }
}

function stripArgs(text) {
  return text.length > 4000 ? `${text.slice(0, 4000)}…[truncated]` : text;
}

/* ───────────────────────── 审计日志（跨会话保留） ───────────────────────── */

/**
 * 两条日志是分开的：
 *  - logs/：现场回放，含屏幕输出和人敲的字，PTY 结束即删；
 *  - audit/：agent 做过什么（命令、审批、传输、转发、连接起止），不含屏幕内容，
 *    跨会话保留，用来事后核对「agent 在这台机器上干了什么」。
 * 命令文本沿用同一套脱敏规则；文件 0600、目录 0700。
 * DSH_RC_AUDIT=off 可以关闭写审计（读/导出仍然可用，导出的是已有内容）。
 */
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;
const AUDIT_KEEP_FILES = 5;
let auditWrites = 0;

const auditOff = () => process.env.DSH_RC_AUDIT === 'off';
const auditLimit = () => {
  const raw = Number(process.env.DSH_RC_AUDIT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 1024 ? Math.floor(raw) : AUDIT_MAX_BYTES;
};

/** 从旧到新的审计文件列表（audit.jsonl.4 … audit.jsonl.1，最后是当前文件）。 */
function auditFiles() {
  const files = [];
  for (let index = AUDIT_KEEP_FILES - 1; index >= 1; index -= 1) {
    const file = `${AUDIT_FILE}.${index}`;
    if (existsSync(file)) files.push(file);
  }
  files.push(AUDIT_FILE);
  return files;
}

function auditSize() {
  return auditFiles().reduce((sum, file) => {
    try {
      return sum + statSync(file).size;
    } catch {
      return sum;
    }
  }, 0);
}

function rotateAudit() {
  try {
    if (statSync(AUDIT_FILE).size < auditLimit()) return;
  } catch {
    return;
  }
  try {
    rmSync(`${AUDIT_FILE}.${AUDIT_KEEP_FILES}`, { force: true });
  } catch {
    /* ignore */
  }
  for (let index = AUDIT_KEEP_FILES - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${AUDIT_FILE}.${index}`, `${AUDIT_FILE}.${index + 1}`);
    } catch {
      /* 该文件不存在 */
    }
  }
  try {
    renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
  } catch {
    /* ignore */
  }
}

/** 记一条审计。cover 可以为空（例如审批发生在拿不到 console 的场景）。 */
function audit(cover, event) {
  if (auditOff()) return;
  const record = {
    at: new Date().toISOString(),
    t: Date.now(),
    ...(cover?.pid === undefined ? {} : { pid: String(cover.pid) }),
    ...(cover?.host === undefined || cover.host === '' ? {} : { host: cover.host }),
    ...event,
  };
  for (const key of ['cmd', 'path', 'target', 'reason']) {
    if (typeof record[key] === 'string') record[key] = redact(record[key]);
  }
  try {
    appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
    auditWrites += 1;
    if (auditWrites === 1) {
      try {
        chmodSync(AUDIT_FILE, 0o600);
      } catch {
        /* ignore */
      }
    }
    if (auditWrites % 100 === 0) rotateAudit();
  } catch (error) {
    debug(`audit write failed: ${String(error?.message ?? error)}`);
  }
}

function readAudit({ cursor = 0, maxBytes = 65536, tool } = {}) {
  const files = auditFiles();
  const chunks = [];
  let skip = Math.max(0, Math.floor(cursor));
  let read = 0;
  const total = auditSize();
  for (const file of files) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (skip >= size) {
      skip -= size;
      continue;
    }
    const from = skip;
    skip = 0;
    const want = Math.min(size - from, maxBytes - read);
    if (want <= 0) break;
    const buffer = Buffer.alloc(want);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, want, from);
    } finally {
      closeSync(fd);
    }
    chunks.push(buffer);
    read += want;
    if (read >= maxBytes) break;
  }
  const raw = Buffer.concat(chunks);
  const next = Math.min(total, Math.max(0, Math.floor(cursor)) + raw.length);
  const lines = raw.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  let selected = lines;
  let skipped = 0;
  if (tool !== undefined && tool !== '') {
    selected = lines.filter((line) => {
      try {
        return JSON.parse(line).tool === tool;
      } catch {
        return false;
      }
    });
    skipped = lines.length - selected.length;
  }
  return { cursor: next, total, data: selected.join('\n'), lines: lines.length, filtered: skipped, rotated: cursor > total };
}

const AUDIT_COLUMNS = [
  'at',
  'pid',
  'host',
  'tool',
  'action',
  'cmd',
  'path',
  'bytes',
  'exit',
  'status',
  'ms',
  'hits',
  'outcome',
  'id',
  'listen',
  'target',
  'verified',
];

/** 导出审计：jsonl 原文，或 csv（固定列，数组用 | 连接）。返回值里的 records 是解析成功的条数。 */
function exportAudit({ localPath, format = 'jsonl' }) {
  const parts = [];
  for (const file of auditFiles()) {
    try {
      parts.push(readFileSync(file, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  const jsonl = parts.join('');
  const records = jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((record) => record !== undefined);
  if (format === 'csv') {
    const escape = (value) => {
      if (value === undefined || value === null) return '';
      const text = Array.isArray(value) ? value.join('|') : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = [AUDIT_COLUMNS.join(','), ...records.map((record) => AUDIT_COLUMNS.map((column) => escape(record[column])).join(','))].join('\n') + '\n';
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, csv, { mode: 0o600 });
    return { records: records.length, bytes: Buffer.byteLength(csv), format };
  }
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, jsonl, { mode: 0o600 });
  return { records: records.length, bytes: Buffer.byteLength(jsonl), format };
}

class Console {
  constructor(pid, handle, tee, spec) {
    this.pid = pid;
    this.handle = handle;
    this.tee = tee;
    this.spec = spec;
    this.createdAt = Date.now();
    this.decoder = new TextDecoder();
    this.text = '';
    this.capture = null;
    this.events = [];
    this.bytes = 0;
    this.host = undefined;
    this.socket = undefined;
    this.terminalId = undefined;
    this.ended = false;
    this.exit = undefined;
    this.pending = null;
    // 日志路径在 spawn 时锁定：识别出主机后只改名，不改写事件去向
    this.logPath = join(LOG_DIR, `local.${pid}.jsonl`);
    // 命令框架方式：unknown → osc（PROMPT_COMMAND 钩子）/ sentinel（__dsh 包一层）
    this.framing = 'unknown';
    this.dEvents = [];
    this.dCarry = '';
    this.dSeq = 0;
    this.initPromise = null;
    this.autoInitTimer = null;
    this.autoInitAttempts = 0;
  }

  /**
   * 首次执行前注入一次 shell 函数，之后每条命令只写 `__dsh <nonce> '<cmd>'`，
   * 窗口里看到的是这行短命令，而不是一长串 printf 哨兵。
   * 注入失败（远端不是 bash 之类）时退回 inline 拼串。
   */
  async ensureFraming() {
    if (this.framing !== 'unknown') return this.framing;
    if (this.initPromise !== null) return this.initPromise;
    this.initPromise = this.doEnsureFraming();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async doEnsureFraming() {
    if (this.framing !== 'unknown') return this.framing;
    if (FORCE_SENTINEL) {
      debug(`console pid=${this.pid} sentinel forced by env`);
      return this.ensureSentinelFraming();
    }
    // 包装器可能已经把钩子通过 PROMPT_COMMAND 环境变量带进远端 shell 了：
    // 登录时钩子会先发一个 D 标记，看到它就不用再注入，窗口里没有任何噪音。
    if (this.dEvents.length >= 1) {
      this.framing = 'osc';
      debug(`console pid=${this.pid} framing=osc (preinstalled hook)`);
      return this.framing;
    }
    // 先试 OSC 133 路线：把命令结束/退出码交给 shell 的 PROMPT_COMMAND 钩子。
    // 注入期间用 stty -echo 关掉输入回显，窗口里只看到一行 stty -echo，其余全部隐藏。
    try {
      this.capture = '';
      this.dEvents.length = 0;
      this.dCarry = '';
      this.framing = 'sentinel';
      // 初始化：关回显 → 注入钩子 → 清屏 + 恢复回显。
      // 关回显期间命令之间没有换行、提示符会堆叠，但最后的 clear 会把它们全部抹掉，
      // 所以不需要逐行擦除（那种做法在窄终端会错位）。
      const initLine =
        ' HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace"; ' +
        " __dsh_pc(){ r=$?; printf '\\033]1337;DSH;D;%d\\007' \"$r\"; }; " +
        ' PROMPT_COMMAND="__dsh_pc${PROMPT_COMMAND:+; $PROMPT_COMMAND}"';
      const hide = process.env.DSH_RC_NO_CLEAR !== '1';
      this.capture = '';
      this.dEvents.length = 0;
      this.dCarry = '';
      if (hide) {
        await this.write('stty -echo\r');
        await new Promise((resolve) => setTimeout(resolve, 150));
        await this.write(`${initLine}\r`);
        // 清屏（含 scrollback）+ 恢复回显 + 校准命令
        await this.write(" printf '\\033[2J\\033[3J\\033[H'; stty echo; :\r");
      } else {
        await this.write(`${initLine}\r`);
        await this.write(' :\r');
      }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (this.ended) break;
        if (this.dEvents.length >= 1) {
          this.framing = 'osc';
          debug(`console pid=${this.pid} framing=osc (hidden=${String(hide)})`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      this.capture = null;
      if (this.framing === 'osc') return this.framing;
      // 恢复失败保护：确保回显是开的，否则用户输入会看不见
      debug(`console pid=${this.pid} osc calibration failed, restoring echo then trying sentinel`);
      try {
        await this.write('stty echo\r');
      } catch {
        /* ignore */
      }
    } catch (error) {
      debug(`osc calibration error pid=${this.pid}: ${String(error?.message ?? error)}`);
      this.capture = null;
      try {
        await this.write('stty echo\r');
      } catch {
        /* ignore */
      }
    }
    if (this.framing !== 'unknown') return this.framing;
    return this.ensureSentinelFraming();
  }

  async ensureSentinelFraming() {
    if (this.framing !== 'unknown') return this.framing;
    const nonce = Math.random().toString(16).slice(2, 10);
    const init =
      "__dsh(){ n=$1; shift; printf '\\033]1337;DSH;B;%s\\007' \"$n\"; eval \"$*\"; r=$?; " +
      "printf '\\033]1337;DSH;E;%s;%d\\007' \"$n\" \"$r\"; return $r; }";
    this.framing = 'inline';
    try {
      this.capture = '';
      await this.write(`${init}\r`);
      await this.write(`__dsh ${nonce} 'echo __DSH_PROBE_OK'\r`);
      const deadline = Date.now() + 4000;
      const re = END_RE(nonce);
      while (Date.now() < deadline) {
        if (this.ended) break;
        if (this.capture !== null && re.test(this.capture)) {
          this.framing = 'function';
          debug(`console pid=${this.pid} framing=function`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (this.framing !== 'function') debug(`console pid=${this.pid} framing falls back to inline`);
    } catch (error) {
      debug(`framing probe failed pid=${this.pid}: ${String(error?.message ?? error)}`);
    } finally {
      this.capture = null;
    }
    return this.framing;
  }

  feed(buffer) {
    this.bytes += buffer.length;
    let chunk = this.decoder.decode(buffer, { stream: true });
    // 跨 chunk 的 "\r\n"：先把孤立的尾部 \r 挂起，避免被当成"行内覆盖"
    if (this.holdCr === true) {
      chunk = `\r${chunk}`;
      this.holdCr = false;
    }
    if (chunk.endsWith('\r')) {
      this.holdCr = true;
      chunk = chunk.slice(0, -1);
    }
    if (chunk.length === 0) return;
    // 扫描 shell 钩子（PROMPT_COMMAND）发出的命令结束标记 D;<code>
    {
      const scan = this.dCarry + chunk;
      const prevLen = this.dCarry.length;
      const dRe = /\x1b\]1337;DSH;D;(\d+)\x07/g;
      let match;
      while ((match = dRe.exec(scan)) !== null) {
        if (match.index < prevLen) continue;
        this.dSeq = (this.dSeq ?? 0) + 1;
        this.dEvents.push({ code: Number(match[1]), at: Date.now(), seq: this.dSeq });
        writeEvent(this, { t: Date.now(), k: 'shell-exit', code: Number(match[1]), via: 'osc' });
      }
      if (this.dEvents.length > 200) this.dEvents.splice(0, this.dEvents.length - 200);
      this.dCarry = scan.slice(-64);
    }
    const clean = sanitize(chunk);
    this.text += clean;
    if (this.text.length > MAX_TEXT_CHARS) this.text = this.text.slice(-MAX_TEXT_CHARS);
    if (this.capture !== null) {
      // 哨兵本身是 OSC 序列，必须用原始字节匹配，不能用剥过 ANSI 的文本
      this.capture += chunk;
      if (this.capture.length > MAX_TEXT_CHARS) this.capture = this.capture.slice(-MAX_TEXT_CHARS);
    }
    writeEvent(this, { t: Date.now(), k: 'out', s: clean });
    this.maybeAutoInit();
  }

  /** 登录后一旦看到稳定的 shell 提示符，就自动注入钩子并清屏（不用等 agent 第一条命令）。 */
  maybeAutoInit() {
    if (this.framing !== 'unknown' || this.ended || this.pending !== null) return;
    if (this.autoInitTimer !== null) clearTimeout(this.autoInitTimer);
    this.autoInitTimer = setTimeout(() => {
      this.autoInitTimer = null;
      void this.autoInitialize();
    }, 700);
    this.autoInitTimer.unref?.();
  }

  async autoInitialize() {
    if (this.framing !== 'unknown' || this.ended || this.pending !== null) return;
    if (this.autoInitAttempts >= 3) return; // 连续失败就别再往终端里写初始化命令了
    if (this.authBlocked()) return; // 还停在密码/指纹确认，绝不写入
    const last = this.lastLine();
    if (!/[#$>] ?$/u.test(last)) return; // 不像 shell 提示符
    hydrate(this);
    if (this.host === undefined || this.socket === undefined) return;
    this.autoInitAttempts += 1;
    debug(`auto-init on prompt pid=${this.pid} attempt=${this.autoInitAttempts}`);
    rememberHost(this);
    try {
      await this.ensureFraming();
    } catch (error) {
      debug(`auto-init failed pid=${this.pid}: ${String(error?.message ?? error)}`);
    }
  }

  /** 清屏 + 清 scrollback，让初始化噪音不留在窗口里。 */
  async clearScreen() {
    if (process.env.DSH_RC_NO_CLEAR === '1') return;
    if (this.clearedOnce === true) return;
    this.clearedOnce = true;
    try {
      await this.write("printf '\\033[2J\\033[3J\\033[H'\r");
    } catch {
      /* ignore */
    }
  }

  /** 最后一行（用于认证护栏与状态摘要） */
  lastLine() {
    const tail = this.text.slice(-AUTH_TAIL_CHARS);
    const lines = tail.split('\n');
    return (lines[lines.length - 1] ?? '').trim();
  }

  authBlocked() {
    const tail = this.text.slice(-AUTH_TAIL_CHARS);
    const last = tail.split('\n').slice(-1)[0] ?? '';
    return AUTH_RE.test(last) || AUTH_RE.test(tail.slice(-120));
  }

  async write(text) {
    if (this.ended) throw new Error('CONSOLE_CLOSED: 终端已结束，请在右侧栏新建 ssh 终端');
    writeEvent(this, { t: Date.now(), k: 'agent', s: text });
    await this.handle.write(text);
  }

  async run(command, timeoutMs) {
    if (this.ended) throw new Error('CONSOLE_CLOSED: 终端已结束，请在右侧栏新建 ssh 终端');
    if (this.authBlocked()) {
      throw new Error('AUTH_REQUIRED: 终端当前在等待你本人完成 ssh 认证/主机指纹确认，agent 不允许写入');
    }
    if (this.pending !== null) throw new Error('SEND_ACTIVE: 上一条命令还没结束');
    const framing = await this.ensureFraming();
    const nonce = Math.random().toString(16).slice(2, 10);
    if (framing === 'osc') {
      const started = Date.now();
      this.capture = '';
      this.pending = { nonce, started };
      const fromSeq = (this.dSeq ?? 0) + 1;
      try {
        await this.write(` ${command}\r`);
        const deadline = started + timeoutMs;
        while (Date.now() < deadline) {
          if (this.ended) break;
          // 按单调序号找命令结束后产生的第一个 D 事件：dEvents 有上限，用下标
          // 会在数组被裁剪时错位（甚至拿到 undefined），序号不会。
          const event = this.dEvents.find((entry) => entry.seq >= fromSeq);
          if (event !== undefined) {
            const captured = this.capture ?? '';
            const dIndex = captured.lastIndexOf('\x1b]1337;DSH;D;');
            const end = dIndex >= 0 ? dIndex : captured.length;
            const from = echoSkipLength(captured.slice(0, end), command);
            const body = captured.slice(from, end).replace(/^\r?\n/, '').replace(/\r/g, '');
            writeEvent(this, {
              t: Date.now(),
              k: 'exec',
              code: event.code,
              ms: Date.now() - started,
              cmd: stripArgs(command),
              via: 'osc',
            });
            return { status: 'done', stdout: sanitize(body), exitCode: event.code, ms: Date.now() - started };
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        return {
          status: this.ended ? 'closed' : 'timeout',
          stdout: sanitize((this.capture ?? '').replace(/\r/g, '')).slice(-8000),
          exitCode: null,
          ms: Date.now() - started,
          note: this.ended ? ENDED_NOTE : `超过 ${timeoutMs} ms 未结束；可用 remote_log 继续看增量`,
        };
      } finally {
        this.capture = null;
        this.pending = null;
      }
    }
    const framed =
      framing === 'function'
        ? `__dsh ${nonce} ${singleQuote(command)}`
        : `printf '\\033]1337;DSH;B;${nonce}\\007'; ${command}; printf '\\033]1337;DSH;E;${nonce};%d\\007' $?`;
    const started = Date.now();
    this.capture = '';
    this.pending = { nonce, started };
    try {
      await this.write(`${framed}\r`);
      const deadline = started + timeoutMs;
      const re = END_RE(nonce);
      while (Date.now() < deadline) {
        if (this.ended) break;
        if (this.capture !== null) {
          const match = this.capture.match(re);
          if (match !== null) {
            const bMarker = beginMarker(nonce);
            const bIndex = this.capture.indexOf(bMarker);
            const body =
              bIndex >= 0
                ? this.capture.slice(bIndex + bMarker.length, match.index)
                : this.capture.slice(0, match.index);
            writeEvent(this, {
              t: Date.now(),
              k: 'exec',
              nonce,
              code: Number(match[1]),
              ms: Date.now() - started,
              cmd: stripArgs(command),
            });
            return {
              status: 'done',
              stdout: sanitize(body).replace(/^\r?\n/, '').replace(/\r/g, ''),
              exitCode: Number(match[1]),
              ms: Date.now() - started,
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return {
        status: this.ended ? 'closed' : 'timeout',
        stdout: sanitize(this.capture ?? '').replace(/\r/g, '').slice(-8000),
        exitCode: null,
        ms: Date.now() - started,
        note: this.ended ? ENDED_NOTE : `超过 ${timeoutMs} ms 未结束；可用 remote_log 继续看增量`,
      };
    } finally {
      this.capture = null;
      this.pending = null;
    }
  }

  /** 会话结束即删除磁盘日志；保留内存事件供当场 remote_log 回看。 */
  deleteLog() {
    for (const file of [this.logPath, `${this.logPath}.1`, `${this.logPath}.2`, `${this.logPath}.3`]) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
    debug(`log removed pid=${this.pid}`);
  }

  screen(lines) {
    const all = this.text.replace(/\s+$/u, '').split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  }
}

function attachHandle(cover) {
  const { handle, tee } = cover;
  handle.output.pipe(tee);
  handle.output.on('data', (chunk) => {
    try {
      cover.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    } catch (error) {
      debug(`feed failed: ${String(error?.message ?? error)}`);
    }
  });
  handle.output.on('end', () => settle(cover, { exitCode: null }));
  handle.output.on('error', (error) => {
    debug(`output error pid=${cover.pid}: ${String(error?.message ?? error)}`);
    settle(cover, { exitCode: null });
  });
  handle.done?.then(
    (outcome) => settle(cover, outcome ?? {}),
    (error) => settle(cover, { error: String(error?.message ?? error) }),
  );
}

function settle(cover, outcome) {
  if (cover.ended) return;
  cover.ended = true;
  cover.exit = outcome;
  writeEvent(cover, {
    t: Date.now(),
    k: 'mk',
    kind: 'pty-end',
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
  });
  audit(cover, {
    tool: 'session',
    action: 'end',
    exit: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
  });
  debug(`PTY ended pid=${cover.pid} ${JSON.stringify(outcome ?? {})}`);
  killForwardsFor(cover);
  cleanupRendezvous(cover);
  cover.deleteLog();
  const timer = S.graceTimers.get(cover.pid);
  if (timer !== undefined) {
    clearTimeout(timer);
    S.graceTimers.delete(cover.pid);
  }
}

/* ─────────────── 文件传输与端口转发（复用已认证的 ControlMaster socket） ─────────────── */

/**
 * 传输与转发都走用户已经完成认证的那个 ControlMaster socket：插件不接触凭据、
 * 不重新认证。socket 一旦消失（终端关闭 / 远端 shell 退出），这些调用立刻失败
 * （BatchMode=yes），不会退回交互式提示，也不会悄悄建立第二条非认证连接。
 */
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_WRITE_BYTES = 256 * 1024;
const TRANSFER_TIMEOUT_MS = 120000;
const FORWARD_READY_TIMEOUT_MS = 8000;

const transferTimeout = (value) =>
  Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 600000) : TRANSFER_TIMEOUT_MS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 远端路径里出现 `..` 会让敏感路径判定失效，直接拒绝（请用绝对路径或相对 HOME 的路径）。 */
function normalizeRemotePath(path) {
  const text = String(path ?? '').trim();
  if (text.length === 0) throw new Error('BAD_PATH: 远端路径为空');
  if (text.includes('\0')) throw new Error('BAD_PATH: 远端路径包含 NUL 字符');
  if (text.split('/').includes('..')) {
    throw new Error('REMOTE_PATH_UNSAFE: 远端路径不允许出现 `..`（请用绝对路径或相对 HOME 的路径）');
  }
  return text;
}

/**
 * 写入这些路径会改变登录方式或系统配置——写错一次就可能把自己锁在门外，
 * 所以即使是常规写文件，也要求一次人工审批。
 */
const SENSITIVE_WRITE_PATTERNS = [
  { id: 'ssh-dir', re: /(?:^|\/)\.ssh\//u },
  { id: 'authorized-keys', re: /authorized_keys2?$/u },
  { id: 'etc', re: /^\/etc\//u },
  { id: 'root', re: /^\/root\//u },
  { id: 'boot', re: /^\/boot\//u },
  { id: 'sudoers', re: /(?:^|\/)sudoers(?:\.d\/|$)/u },
  { id: 'shell-profile', re: /(?:^|\/)(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.zshenv)$/u },
  { id: 'systemd-unit', re: /^\/etc\/systemd\//u },
];

/** @returns {string[]} 命中的敏感写入类别（空数组表示普通路径）。 */
function sensitiveWriteMatches(path) {
  const text = String(path ?? '');
  const hits = [];
  for (const { id, re } of SENSITIVE_WRITE_PATTERNS) {
    if (re.test(text)) hits.push(id);
  }
  return hits;
}

/** 复用 master socket 的 ssh 参数；`--` 之后的 host 只用于配置解析，连接走已认证的 master。 */
function sshSocketArgv(prefix, cover, extra = []) {
  return [
    ...prefix,
    '-S',
    cover.socket,
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'LogLevel=ERROR',
    ...extra,
    '--',
    cover.host,
  ];
}

/** 工具入口：终端必须在，但允许没有 socket（Windows 等没有 ControlMaster 的平台）。 */
function liveConsole(args) {
  const cover = requireConsole(args);
  hydrate(cover);
  if (cover.ended) throw new Error('CONSOLE_CLOSED: 终端已结束，请在右侧栏新建 ssh 终端后重新登录');
  return cover;
}

function hasSocket(cover) {
  return cover.socket !== undefined && cover.socket.length > 0;
}

/** 需要 ControlMaster 的工具入口：没有 socket 时说清楚原因与替代方案。 */
function socketConsole(args) {
  const cover = liveConsole(args);
  if (!hasSocket(cover)) {
    throw new Error(
      'CONSOLE_NOT_CONNECTED: 该终端没有可用的控制 socket（Windows 版 OpenSSH 不支持 ControlMaster）。' +
        '带外执行/传输/端口转发不可用；请改用 remote_run 等走 PTY 的工具。',
    );
  }
  return cover;
}

/** 远端 sha256：有 sha256sum 用 sha256sum，macOS 退回 shasum -a 256。 */
function remoteHashScript(path) {
  const quoted = singleQuote(path);
  return (
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${quoted} | cut -d' ' -f1; ` +
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- ${quoted} | cut -d' ' -f1; ` +
    'else echo UNAVAILABLE; fi'
  );
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ─────────────── PTY 回退通道（Windows 等没有 ControlMaster 的平台） ─────────────── */

/**
 * Windows 版 OpenSSH 不支持 ControlMaster，拿不到可复用的 socket。这时工具退回
 * 「往同一个 PTY 里写字」：
 *  - 命令会出现在用户窗口里（和 remote_run 一样），输出靠 OSC 哨兵拿退出码；
 *  - 文件走 base64 分块（终端一次输入行有长度上限，分块是必须的），上限 1 MiB；
 *  - 端口转发不可用（没有可复用的已认证连接），直接明确报错。
 * 代价写进工具输出里，不假装和 socket 通道一样。
 */
const PTY_TRANSFER_LIMIT = 1024 * 1024;
const PTY_CHUNK = 2048;
const PTY_PROBE_TIMEOUT_MS = 15000;

function transportOf(cover) {
  return hasSocket(cover) ? 'socket' : 'pty';
}

const base64FlagCache = new Map();

/** GNU base64 用 -d、BSD/macOS 用 -D；每个终端探测一次。 */
async function base64DecodeFlag(cover) {
  const key = String(cover.pid);
  const cached = base64FlagCache.get(key);
  if (cached !== undefined) return cached;
  const probe = await cover.run("printf 'AAAA' | base64 -d >/dev/null 2>&1 && printf DSH-GNU || printf DSH-BSD", PTY_PROBE_TIMEOUT_MS);
  const flag = probe.stdout.includes('DSH-GNU') ? '-d' : '-D';
  base64FlagCache.set(key, flag);
  if (base64FlagCache.size > 32) base64FlagCache.delete(base64FlagCache.keys().next().value);
  return flag;
}

function stripBase64Noise(text) {
  const raw = String(text).replace(/[^A-Za-z0-9+/=]/gu, '');
  const usable = raw.length - (raw.length % 4);
  return raw.slice(0, usable);
}

/** 把一段 buffer 分块 base64 写进远端文件；first 块覆盖、其余追加。 */
async function ptyWriteFile(cover, remotePath, buffer, { append = false } = {}) {
  if (buffer.length > PTY_TRANSFER_LIMIT) {
    throw new Error(
      `TRANSFER_TOO_LARGE: PTY 通道上限 ${PTY_TRANSFER_LIMIT} 字节（当前传输没有 ControlMaster）。` +
        '大文件请在支持 ControlMaster 的平台上传，或用 remote_run 里自己分块处理。',
    );
  }
  const flag = await base64DecodeFlag(cover);
  const quoted = singleQuote(remotePath);
  const data = buffer.toString('base64');
  let first = !append;
  for (let index = 0; index < data.length; index += PTY_CHUNK) {
    const chunk = data.slice(index, index + PTY_CHUNK);
    const redirect = first ? '>' : '>>';
    first = false;
    const result = await cover.run(`printf '%s' '${chunk}' | base64 ${flag} ${redirect} ${quoted}`, PTY_PROBE_TIMEOUT_MS);
    if (result.status !== 'done' || result.exitCode !== 0) {
      throw new Error(
        `PTY_WRITE_FAILED: 分块写入失败（status ${result.status}，exit ${String(result.exitCode)}）；远端文件可能只写了一部分。`,
      );
    }
  }
  return buffer.length;
}

/** 读远端文件：先 base64 编码成文本，再在本地解码（避免终端乱码/控制字符）。 */
async function ptyReadFile(cover, remotePath, maxBytes) {
  if (maxBytes > PTY_TRANSFER_LIMIT) maxBytes = PTY_TRANSFER_LIMIT;
  const encodedLimit = Math.ceil((maxBytes * 4) / 3) + 8;
  const result = await cover.run(`base64 < ${singleQuote(remotePath)} | head -c ${encodedLimit}`, PTY_PROBE_TIMEOUT_MS);
  if (result.status !== 'done') {
    throw new Error(`PTY_READ_FAILED: 读取没有结束（status ${result.status}）`);
  }
  const decoded = Buffer.from(stripBase64Noise(result.stdout), 'base64');
  return {
    buffer: decoded.subarray(0, maxBytes),
    truncated: decoded.length > maxBytes || result.stdout.length >= encodedLimit,
    exitCode: result.exitCode,
  };
}

/** 在 PTY 里算远端 sha256（和 socket 通道用同一套脚本）。 */
async function ptyRemoteHash(cover, remotePath) {
  const result = await cover.run(remoteHashScript(remotePath), PTY_PROBE_TIMEOUT_MS);
  const match = /\b[0-9a-f]{64}\b/u.exec(result.stdout);
  return match === null ? 'UNAVAILABLE' : match[0];
}

/** 在 PTY 里执行一条命令，语义与 remote_exec 一致（只是窗口里看得见）。 */
async function ptyExec(cover, script, timeoutMs) {
  return await cover.run(script, timeoutMs);
}

/* —— 工具在 PTY 通道下的实现：行为一致，但命令/数据会经过用户窗口 —— */

const PTY_NOTE = 'transport: pty（没有 ControlMaster，命令与数据会出现在用户窗口里；单文件上限 1 MiB）';

async function ptyUploadTool(ctx, cover, args, exec) {
  const localPath = String(args.local_path ?? '').trim();
  if (localPath.length === 0) throw new Error('BAD_PATH: local_path 为空');
  const remotePath = normalizeRemotePath(args.remote_path);
  let localStat;
  try {
    localStat = statSync(localPath);
  } catch (error) {
    throw new Error(`LOCAL_NOT_FOUND: 读不到本地文件（${String(error?.message ?? error)}）`);
  }
  if (!localStat.isFile()) throw new Error(`LOCAL_NOT_FILE: ${localPath} 不是普通文件`);
  if (localStat.size > PTY_TRANSFER_LIMIT) {
    throw new Error(`TRANSFER_TOO_LARGE: PTY 通道上限 ${PTY_TRANSFER_LIMIT} 字节（当前传输没有 ControlMaster）`);
  }
  await gateSensitiveWrite(ctx, exec, cover, 'remote_upload', remotePath);
  if (args.overwrite !== true) {
    const check = await cover.run(`test -e ${singleQuote(remotePath)} && printf EXISTS`, PTY_PROBE_TIMEOUT_MS);
    if (check.stdout.includes('EXISTS')) throw new Error(`FILE_EXISTS: 远端已存在 ${remotePath}；确认覆盖请传 overwrite: true`);
  }
  const started = Date.now();
  const buffer = readFileSync(localPath);
  await ptyWriteFile(cover, remotePath, buffer);
  const localHash = await sha256File(localPath);
  const remoteHash = await ptyRemoteHash(cover, remotePath);
  if (typeof args.mode === 'string' && args.mode.trim().length > 0) {
    const mode = args.mode.trim();
    if (!/^[0-7]{3,4}$/u.test(mode)) throw new Error('BAD_MODE: mode 必须是 3-4 位八进制，例如 0644');
    await cover.run(`chmod ${mode} ${singleQuote(remotePath)}`, PTY_PROBE_TIMEOUT_MS);
  }
  audit(cover, { tool: 'remote_upload', action: 'upload', path: remotePath, bytes: buffer.length, verified: remoteHash === localHash, transport: 'pty' });
  if (remoteHash !== 'UNAVAILABLE' && remoteHash !== localHash) {
    throw new Error(`UPLOAD_HASH_MISMATCH: 上传后远端 sha256 与本地不一致\nlocal: ${localHash}\nremote: ${remoteHash}`);
  }
  return {
    text: [
      'status: done',
      PTY_NOTE,
      `local: ${localPath}`,
      `remote: ${remotePath}`,
      `bytes: ${buffer.length}`,
      `sha256: ${localHash}`,
      `verified: ${remoteHash === 'UNAVAILABLE' ? 'unavailable（远端没有 sha256sum/shasum）' : 'yes'}`,
      `elapsed_ms: ${Date.now() - started}`,
    ].join('\n'),
  };
}

async function ptyDownloadTool(ctx, cover, args) {
  const remotePath = normalizeRemotePath(args.remote_path);
  const localPath = String(args.local_path ?? '').trim();
  if (localPath.length === 0) throw new Error('BAD_PATH: local_path 为空');
  const quoted = singleQuote(remotePath);
  const info = await cover.run(
    `if [ -d ${quoted} ]; then printf DIR; elif [ -f ${quoted} ]; then wc -c < ${quoted}; else printf MISSING; fi`,
    PTY_PROBE_TIMEOUT_MS,
  );
  const probe = info.stdout.trim();
  if (probe === 'MISSING') throw new Error(`REMOTE_NOT_FOUND: 远端没有 ${remotePath}`);
  if (probe === 'DIR') throw new Error(`REMOTE_IS_DIR: ${remotePath} 是目录，remote_download 只支持单个文件`);
  const size = Number(probe);
  if (Number.isFinite(size) && size > PTY_TRANSFER_LIMIT) {
    throw new Error(`TRANSFER_TOO_LARGE: ${size} 字节，PTY 通道上限 ${PTY_TRANSFER_LIMIT} 字节`);
  }
  if (existsSync(localPath) && args.overwrite !== true) {
    throw new Error(`FILE_EXISTS: 本地已存在 ${localPath}；确认覆盖请传 overwrite: true`);
  }
  mkdirSync(dirname(localPath), { recursive: true });
  const started = Date.now();
  const read = await ptyReadFile(cover, remotePath, PTY_TRANSFER_LIMIT);
  if (read.exitCode !== 0) throw new Error(`DOWNLOAD_FAILED: 读取 ${remotePath} 失败（exit ${String(read.exitCode)}）`);
  const tempPath = `${localPath}.dsh-download-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tempPath, read.buffer, { mode: 0o600 });
  const localHash = await sha256File(tempPath);
  const remoteHash = await ptyRemoteHash(cover, remotePath);
  audit(cover, { tool: 'remote_download', action: 'download', path: remotePath, bytes: read.buffer.length, verified: remoteHash === localHash, transport: 'pty' });
  if (remoteHash !== 'UNAVAILABLE' && remoteHash !== localHash) {
    rmSync(tempPath, { force: true });
    throw new Error(`DOWNLOAD_HASH_MISMATCH: 下载后本地 sha256 与远端不一致\nlocal: ${localHash}\nremote: ${remoteHash}`);
  }
  renameSync(tempPath, localPath);
  return {
    text: [
      'status: done',
      PTY_NOTE,
      `remote: ${remotePath}`,
      `local: ${localPath}`,
      `bytes: ${read.buffer.length}`,
      `sha256: ${localHash}`,
      `verified: ${remoteHash === 'UNAVAILABLE' ? 'unavailable（远端没有 sha256sum/shasum）' : 'yes'}`,
      `elapsed_ms: ${Date.now() - started}`,
    ].join('\n'),
  };
}

async function ptyReadFileTool(cover, args) {
  const remotePath = normalizeRemotePath(args.path);
  const limit =
    Number.isFinite(args.max_bytes) && args.max_bytes > 0 ? Math.min(Math.floor(args.max_bytes), 262144) : 131072;
  const read = await ptyReadFile(cover, remotePath, limit);
  if (read.exitCode !== 0 && !read.truncated) {
    throw new Error(`READ_FAILED: 读取 ${remotePath} 失败（exit ${String(read.exitCode)}）`);
  }
  const text = read.buffer.toString('utf8');
  if (text.includes('\0')) {
    return {
      text: [`path: ${remotePath}`, `bytes: ${read.buffer.length}`, 'binary: yes', PTY_NOTE, 'note: 二进制文件请用 remote_download 取回后本地处理。'].join('\n'),
    };
  }
  return {
    text: [
      `path: ${remotePath}`,
      PTY_NOTE,
      `bytes: ${read.buffer.length}`,
      `truncated: ${read.truncated ? 'yes' : 'no'}`,
      'content:',
      text.length === 0 ? '  (空文件)' : text.split('\n').map((line) => `  ${line}`).join('\n'),
    ].join('\n'),
  };
}

async function ptyWriteFileTool(ctx, cover, args, exec) {
  const remotePath = normalizeRemotePath(args.path);
  const content = typeof args.content === 'string' ? args.content : '';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TEXT_WRITE_BYTES) {
    throw new Error(`CONTENT_TOO_LARGE: ${bytes} 字节，上限 ${MAX_TEXT_WRITE_BYTES} 字节`);
  }
  await gateSensitiveWrite(ctx, exec, cover, 'remote_write_file', remotePath);
  const append = args.append === true;
  await ptyWriteFile(cover, remotePath, Buffer.from(content, 'utf8'), { append });
  if (typeof args.mode === 'string' && args.mode.trim().length > 0) {
    const mode = args.mode.trim();
    if (!/^[0-7]{3,4}$/u.test(mode)) throw new Error('BAD_MODE: mode 必须是 3-4 位八进制，例如 0644');
    await cover.run(`chmod ${mode} ${singleQuote(remotePath)}`, PTY_PROBE_TIMEOUT_MS);
  }
  audit(cover, { tool: 'remote_write_file', action: 'write', path: remotePath, bytes, append, transport: 'pty' });
  return { text: ['status: done', PTY_NOTE, `path: ${remotePath}`, `bytes: ${bytes}`, `append: ${append ? 'yes' : 'no'}`].join('\n') };
}

async function ptyExecTool(ctx, cover, args, exec) {
  await gateDangerousCommand(ctx, exec, args.command, 'remote_exec', cover, { checkTerminating: true });
  const timeout =
    Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? Math.min(args.timeout_ms, 600000) : DEFAULT_TIMEOUT_MS;
  const script =
    typeof args.cwd === 'string' && args.cwd.length > 0 ? `cd ${singleQuote(args.cwd)} && ${args.command}` : args.command;
  const started = Date.now();
  const result = await ptyExec(cover, script, timeout);
  audit(cover, { tool: 'remote_exec', action: 'exec', cmd: script, exit: result.exitCode, status: result.status, ms: result.ms, transport: 'pty' });
  const clip = (value) => (value.length > 262144 ? `${value.slice(0, 262144)}\n[output truncated]` : value);
  return {
    text: [
      `status: ${result.status}`,
      PTY_NOTE,
      `exit_code: ${result.exitCode === null ? 'unknown' : result.exitCode}`,
      `elapsed_ms: ${result.ms}`,
      result.note === undefined ? '' : `note: ${result.note}`,
      'output (PTY, stdout+stderr merged):',
      clip(result.stdout).length === 0 ? '  (空)' : clip(result.stdout).split('\n').map((line) => `  ${line}`).join('\n'),
    ]
      .filter((line) => line !== '')
      .join('\n'),
  };
}

/**
 * 在同一个 socket 上执行一条远端命令：stdout 可以落本地文件（下载）或收进内存
 * （读文件 / 算哈希），stdin 可以来自本地文件（上传）。用 spawn 而不是 execFile，
 * 这样传输不设 maxBuffer 上限，也不会把整个文件读进插件内存。
 */
function execOverSocket(cover, script, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : TRANSFER_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : 0;
  return new Promise((resolve, reject) => {
    sshConfigPrefix().then((prefix) => {
      const argv = sshSocketArgv(prefix, cover, options.extra ?? []);
      const child = spawn('ssh', [...argv, `sh -c ${singleQuote(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      const errChunks = [];
      const outStream = options.stdoutPath === undefined ? undefined : createWriteStream(options.stdoutPath);
      let bytes = 0;
      let truncated = false;
      let settled = false;
      let childDone = false;
      let outDone = outStream === undefined;
      let exitCode = null;
      let exitSignal = null;
      let inputStream;
      const timer = setTimeout(() => fail(new Error(`TRANSFER_TIMEOUT: 超过 ${timeoutMs} ms 未完成`)), timeoutMs);

      function finish() {
        if (settled || !childDone || !outDone) return;
        settled = true;
        clearTimeout(timer);
        if (inputStream !== undefined) inputStream.destroy();
        resolve({
          code: exitCode,
          signal: exitSignal,
          bytes,
          truncated,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (inputStream !== undefined) inputStream.destroy();
        try {
          child.kill('SIGKILL');
        } catch {
          /* 进程可能已经退出 */
        }
        if (outStream !== undefined) outStream.destroy();
        reject(error);
      }

      child.on('error', (error) => {
        fail(new Error(`SSH_CLIENT_FAILED: 无法执行 ssh（${String(error?.message ?? error)}）`));
      });
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        // 落文件时由 pipe 负责写盘（带背压），这里只计数
        if (outStream !== undefined) return;
        if (maxBytes > 0 && bytes > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (bytes - chunk.length))));
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已经退出 */
          }
          return;
        }
        chunks.push(chunk);
      });
      if (outStream !== undefined) {
        outStream.on('error', (error) => fail(new Error(`LOCAL_WRITE_FAILED: ${String(error?.message ?? error)}`)));
        outStream.on('close', () => {
          outDone = true;
          finish();
        });
        child.stdout.pipe(outStream, { end: true });
      }
      child.stderr.on('data', (chunk) => {
        if (errChunks.reduce((sum, part) => sum + part.length, 0) > 16384) return;
        errChunks.push(chunk);
      });
      child.on('close', (code, signal) => {
        exitCode = typeof code === 'number' ? code : null;
        exitSignal = signal ?? null;
        childDone = true;
        finish();
      });
      child.stdin.on('error', () => {
        /* 远端提前退出时写 stdin 会 EPIPE，结果由退出码说明 */
      });
      if (options.stdinPath !== undefined) {
        inputStream = createReadStream(options.stdinPath);
        inputStream.on('error', (error) => fail(new Error(`LOCAL_READ_FAILED: ${String(error?.message ?? error)}`)));
        inputStream.pipe(child.stdin);
      } else {
        child.stdin.end(options.stdinText === undefined ? '' : String(options.stdinText));
      }
    }, reject);
  });
}

/** 先占一个空闲端口再让 ssh 监听：ssh 不会告诉我们它选了哪个端口。 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function portAccepts(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 向 master 请求取消一条转发（`-O cancel`）。master 已退出时静默失败：
 * 那种情况下隧道已经随连接一起消失，不需要再清理。
 */
async function cancelForward(cover, spec) {
  const prefix = await sshConfigPrefix();
  const argv = sshSocketArgv(prefix, cover, ['-O', 'cancel', '-L', spec]);
  await new Promise((resolve) => {
    execFile('ssh', argv, { timeout: 8000 }, () => resolve());
  });
}

/**
 * `ssh -N -L 127.0.0.1:<local>:<remoteHost>:<remotePort>`，绑定只到回环地址：
 * 转发端口不出本机，局域网里其他机器连不上。
 *
 * 注意多路复用语义：-S 指向已有 master 时，ssh 客户端只是向 master 发一个
 * forwarding 请求，请求成功后**客户端就以 0 退出**，隧道由 master 持有。
 * 所以成败只能看「端口是否开始监听」，不能看子进程还活着；停止要用
 * `-O cancel`（只 kill 客户端不会关掉 master 上的监听）。
 */
async function startForward(cover, { localPort, remoteHost, remotePort }) {
  const listenPort = Number.isFinite(localPort) && localPort > 0 ? Math.floor(localPort) : await reserveFreePort();
  if (listenPort > 65535) throw new Error('BAD_PORT: local_port 超出 1-65535');
  const prefix = await sshConfigPrefix();
  const spec = `127.0.0.1:${listenPort}:${remoteHost}:${remotePort}`;
  const argv = sshSocketArgv(prefix, cover, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', spec]);
  const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const errChunks = [];
  child.stderr.on('data', (chunk) => {
    if (errChunks.length < 40) errChunks.push(chunk);
  });
  let exit = null;
  const exitPromise = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  child.once('error', (error) => {
    exit = { code: null, signal: null, message: String(error?.message ?? error) };
  });
  const deadline = Date.now() + FORWARD_READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (await portAccepts(listenPort)) {
      ready = true;
      break;
    }
    // 非零退出说明请求被拒（端口占用、隧道禁止等），不必再等
    if (exit !== null && exit.code !== 0) break;
    await sleep(50);
  }
  if (!ready) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
    await cancelForward(cover, spec);
    const detail = Buffer.concat(errChunks).toString('utf8').trim();
    const suffix = detail.length === 0 ? '' : ` ssh 输出：${detail.slice(0, 800)}`;
    if (exit !== null && exit.code !== 0) {
      throw new Error(
        `FORWARD_FAILED: ssh 拒绝了转发请求（退出码 ${String(exit.code)}${exit.message === undefined ? '' : `，${exit.message}`}）。${suffix}`,
      );
    }
    throw new Error(`FORWARD_TIMEOUT: ${FORWARD_READY_TIMEOUT_MS} ms 内转发端口 ${listenPort} 没有开始监听。${suffix}`);
  }
  S.forwardSeq += 1;
  const id = `fwd-${S.forwardSeq}`;
  const info = {
    id,
    listenPort,
    remoteHost,
    remotePort,
    spec,
    pid: child.pid,
    cover,
    coverPid: cover.pid,
    host: cover.host,
    child,
    exitPromise,
    createdAt: Date.now(),
  };
  S.forwards.set(id, info);
  child.once('close', () => {
    // 客户端退出不代表隧道没了（mux 模式下隧道在 master 上），登记表由 stop 维护
    if (S.forwards.get(id) === info) info.clientExited = true;
  });
  return info;
}

/** 停止一条转发：先让 master 取消监听，再回收可能还活着的客户端进程。 */
async function stopForward(info) {
  await cancelForward(info.cover, info.spec);
  try {
    if (info.child.exitCode === null) info.child.kill('SIGTERM');
  } catch {
    /* 已经退出 */
  }
  await Promise.race([info.exitPromise, sleep(1500)]);
  try {
    if (info.child.exitCode === null) info.child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
  if (S.forwards.get(info.id) === info) S.forwards.delete(info.id);
  return { closed: !(await portAccepts(info.listenPort, 300)) };
}

/** 终端结束/关闭时把它名下的转发全部停掉，避免留下还在监听的本机端口。 */
function killForwardsFor(cover) {
  const mine = [...S.forwards.values()].filter((info) => cover === undefined || info.coverPid === cover.pid);
  for (const info of mine) {
    S.forwards.delete(info.id);
    try {
      if (info.child.exitCode === null) info.child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
    void cancelForward(info.cover, info.spec);
    debug(`forward stopped with console ${String(info.coverPid)}: ${info.id} 127.0.0.1:${info.listenPort}`);
  }
}

function cleanupRendezvous(cover) {
  try {
    for (const file of readdirSync(SESS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const full = join(SESS_DIR, file);
      try {
        const data = JSON.parse(readFileSync(full, 'utf8'));
        if (String(data.pid) === String(cover.pid)) rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  if (cover.socket !== undefined) {
    try {
      rmSync(cover.socket, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 从包装器写的 rendezvous 文件里补齐 host / socket。 */
function hydrate(cover) {
  try {
    for (const file of readdirSync(SESS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const full = join(SESS_DIR, file);
      try {
        const data = JSON.parse(readFileSync(full, 'utf8'));
        if (String(data.pid) !== String(cover.pid)) continue;
        cover.host = String(data.host ?? '');
        cover.socket = String(data.socket ?? '');
        cover.user = String(data.user ?? '');
        cover.port = String(data.port ?? '');
        // 识别出主机后把日志改成可读名（内容连续，不拆文件）
        const target = join(LOG_DIR, `${shortId(cover.host, cover.pid)}.jsonl`);
        if (target !== cover.logPath) {
          try {
            if (existsSync(cover.logPath) && !existsSync(target)) renameSync(cover.logPath, target);
          } catch {
            /* 改名失败就继续用旧名，事件不会丢 */
          }
          cover.logPath = target;
        }
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

const HOSTS_FILE = join(RC_DIR, 'hosts.tsv');

/**
 * 登录成功时把远端记进 hosts.tsv，供「SSH 远程」下拉下次直接列出。
 * 不能只靠包装器退出时保存：关标签会直接杀掉进程树，包装器来不及执行。
 */
function rememberHost(cover) {
  const host = String(cover.host ?? '').trim();
  if (host.length === 0) return;
  const user = String(cover.user ?? '').trim();
  const port = String(cover.port ?? '').trim();
  const line = `${host}\t${user}\t${port}`;
  let text = '';
  try {
    text = readFileSync(HOSTS_FILE, 'utf8');
  } catch {
    text = '';
  }
  const rows = text.split('\n').filter((row) => row.trim().length > 0);
  let found = false;
  let changed = false;
  for (let index = 0; index < rows.length; index += 1) {
    const fields = rows[index].split('\t');
    if (fields[0] !== host) continue;
    found = true;
    if (fields[1] === undefined || fields[1].length === 0) {
      if (user.length > 0) {
        rows[index] = line;
        changed = true;
      }
    }
    break;
  }
  if (!found) {
    rows.push(line);
    changed = true;
  }
  if (!changed) return;
  try {
    writeFileSync(HOSTS_FILE, `${rows.join('\n')}\n`, { mode: 0o600 });
    debug(`remembered host ${host}${user ? ` user=${user}` : ''}${port ? ` port=${port}` : ''}`);
  } catch (error) {
    debug(`remember host failed for ${host}: ${String(error?.message ?? error)}`);
  }
}

function newestConsole(sessionIdFilter) {
  let best;
  for (const cover of S.consoles.values()) {
    if (cover.ended) continue;
    if (sessionIdFilter !== undefined && cover.sessionId !== sessionIdFilter) continue;
    if (best === undefined || cover.createdAt > best.createdAt) best = cover;
  }
  return best;
}

function findConsole(pid) {
  return S.consoles.get(String(pid));
}

function killConsole(cover, reason) {
  try {
    debug(`kill console pid=${cover.pid} reason=${reason}`);
    void cover.handle.terminate().catch(() => {});
  } catch (error) {
    debug(`terminate failed pid=${cover.pid}: ${String(error?.message ?? error)}`);
  }
  if (cover.socket !== undefined && cover.socket.length > 0) {
    const host = cover.host;
    const socket = cover.socket;
    void sshConfigPrefix()
      .then((prefix) => {
        const args = [...prefix, '-O', 'exit', '-S', socket];
        if (host !== undefined && host.length > 0) args.push(host);
        execFile('ssh', args, { timeout: 5000 }, () => {});
      })
      .catch(() => {});
  }
  setTimeout(() => cleanupRendezvous(cover), 300).unref?.();
  writeEvent(cover, { t: Date.now(), k: 'mk', kind: 'closed', reason });
  // settled 可能先于这条 closed 事件执行，这里再删一次，确保会话结束后不残留
  setTimeout(() => cover.deleteLog(), 800).unref?.();
}

/* ───────────────────────── 服务包装 ───────────────────────── */

function wrapSpawnTerminal(ctx) {
  const subprocess = ctx.subprocess;
  if (subprocess.spawnTerminal?.__dshRc === true) {
    debug('spawnTerminal already wrapped, reuse');
    S.wrappers.spawnTerminal = subprocess.spawnTerminal;
    return;
  }
  const original = subprocess.spawnTerminal;
  const patched = async function spawnTerminalRc(spec) {
    const handle = await original.call(this, spec);
    const argv = Array.isArray(spec.argv) ? spec.argv : [];
    const base = basename(String(argv[0] ?? ''));
    // Windows 下启动器是 `node dsh-ssh.mjs ...`，靠 argv 里的脚本路径识别
    const isConsole =
      base === 'dsh-ssh' ||
      base.startsWith('dsh-ssh-') ||
      argv.some((part) => typeof part === 'string' && /[\\/]dsh-ssh\.mjs$/u.test(part));
    if (!isConsole) return handle;
    const cover = new Console(String(handle.pid), handle, new PassThrough(), spec);
    cover.sessionId = spec.env?.DSH_SESSION_ID;
    S.consoles.set(cover.pid, cover);
    writeEvent(cover, { t: Date.now(), k: 'mk', kind: 'spawn', argv: spec.argv, cwd: spec.cwd });
    audit(cover, { tool: 'session', action: 'spawn' });
    debug(`console spawned pid=${cover.pid} session=${String(cover.sessionId)}`);
    try {
      attachHandle(cover);
    } catch (error) {
      debug(`attach failed: ${String(error?.message ?? error)}`);
      return handle;
    }
    void bindTerminalId(ctx, cover);
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'output') return cover.tee;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  patched.__dshRc = true;
  subprocess.spawnTerminal = patched;
  S.wrappers.spawnTerminal = patched;
  debug('spawnTerminal wrapped');
}

/** 终端 controller 的 shell 列表里追加我们的包装器（无需改 profile 配置）。 */
function wrapShells(ctx) {
  const controller = ctx.terminalController;
  if (controller.shells?.__dshRc === true) {
    debug('shells already wrapped, reuse');
    S.wrappers.shells = controller.shells;
    return;
  }
  const original = controller.shells.bind(controller);
  const patched = async function shellsRc(agent, signal) {
    const list = await original(agent, signal);
    if (!existsSync(WRAPPER)) return list;
    const extras = [];
    const targets = configHostLines().filter(isDirectTarget);
    const launchers = ensureHostLaunchers(discoverHosts(), targets);
    for (const launcher of launchers) {
      if (list.some((entry) => entry.path === launcher.path)) continue;
      extras.push({ path: launcher.path, name: launcher.name, args: launcher.args ?? [] });
    }
    const fresh = ensureNewSessionLauncher();
    if (fresh !== undefined && !list.some((entry) => entry.path === fresh.path)) {
      extras.push({ path: fresh.path, name: fresh.name, args: fresh.args ?? [] });
    }
    return [...list, ...extras];
  };
  patched.__dshRc = true;
  controller.shells = patched;
  S.wrappers.shells = patched;
  debug('shells wrapped');
}

/** 跟踪窗口持有关系：最后一个 hold 消失后宽限，然后杀 console。 */
function wrapRetain(ctx) {
  const controller = ctx.terminalController;
  if (controller.retain?.__dshRc === true) {
    debug('retain already wrapped, reuse');
    S.wrappers.retain = controller.retain;
    return;
  }
  const original = controller.retain.bind(controller);
  const patched = function retainRc(sessionId, id, signal) {
    if (signal !== undefined) addHolder(id, signal);
    return original(sessionId, id, signal);
  };
  patched.__dshRc = true;
  controller.retain = patched;
  S.wrappers.retain = patched;
  debug('retain wrapped');
}

function addHolder(terminalId, signal) {
  const key = String(terminalId);
  let set = S.holders.get(key);
  if (set === undefined) {
    set = new Set();
    S.holders.set(key, set);
  }
  set.add(signal);
  const clearGrace = () => {
    const timer = S.graceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      S.graceTimers.delete(key);
      debug(`grace cancelled for terminal ${key}`);
    }
  };
  clearGrace();
  signal.addEventListener(
    'abort',
    () => {
      set.delete(signal);
      if (set.size > 0) return;
      debug(`last holder gone for terminal ${key}, grace ${CLOSE_GRACE_MS}ms`);
      const timer = setTimeout(() => {
        S.graceTimers.delete(key);
        const pid = S.idToPid.get(key);
        const cover = pid === undefined ? undefined : findConsole(pid);
        if (cover === undefined || cover.ended) {
          debug(`grace fired but console gone: ${key}`);
          return;
        }
        debug(`grace fired, closing pid=${cover.pid} (all windows gone)`);
        killConsole(cover, 'no-window');
      }, CLOSE_GRACE_MS);
      timer.unref?.();
      S.graceTimers.set(key, timer);
    },
    { once: true },
  );
}

async function bindTerminalId(ctx, cover) {
  if (cover.sessionId === undefined) return;
  for (let attempt = 0; attempt < 40 && !cover.ended; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const list = ctx.terminalController.list(cover.sessionId);
      for (const info of list) {
        const shellPath = String(info.shell?.path ?? '');
        const isOurs = shellPath === WRAPPER || basename(shellPath).startsWith('dsh-ssh-');
        if (!isOurs) continue;
        if (S.idToPid.has(String(info.id))) continue;
        S.idToPid.set(String(info.id), cover.pid);
        cover.terminalId = info.id;
        debug(`bound terminal ${String(info.id)} -> pid ${cover.pid}`);
        return;
      }
    } catch (error) {
      debug(`list failed: ${String(error?.message ?? error)}`);
      return;
    }
  }
}

/* ───────────────────────── 工具 ───────────────────────── */

function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  };
}

function requireConsole(args) {
  if (args.console_pid !== undefined && args.console_pid !== '') {
    const cover = findConsole(args.console_pid);
    if (cover === undefined) throw new Error(`CONSOLE_NOT_FOUND: pid ${args.console_pid} 不存在`);
    return cover;
  }
  const cover = newestConsole();
  if (cover === undefined) {
    throw new Error('NO_CONSOLE: 还没有 ssh 终端。请在右侧栏「新建终端」里选择「dsh-ssh 远程」');
  }
  return cover;
}

function forwardLines(cover) {
  const mine = [...S.forwards.values()].filter((info) => info.coverPid === cover.pid);
  if (mine.length === 0) return ['forwards: 0'];
  return [
    `forwards: ${mine.length}`,
    ...mine.map((info) => `  ${info.id}: 127.0.0.1:${info.listenPort} -> ${info.remoteHost}:${info.remotePort}`),
  ];
}

function statusOf(cover) {
  hydrate(cover);
  const tail = cover.screen(6);
  return [
    `pid: ${cover.pid}`,
    `host: ${cover.host ?? '(未连接)'}`,
    `socket: ${cover.socket ?? '-'}`,
    `transport: ${transportOf(cover)}`,
    `state: ${cover.ended ? 'exited' : cover.pending !== null ? 'running' : 'idle'}`,
    `bytes: ${cover.bytes}`,
    `log: ${logFileFor(cover)}`,
    `audit: ${AUDIT_FILE} (${auditSize()} bytes，跨会话保留)`,
    ...forwardLines(cover),
    `last:`,
    tail.length === 0 ? '  (无输出)' : tail.split('\n').map((line) => `  ${line}`).join('\n'),
  ].join('\n');
}

function applyTools(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined) {
    debug('tools service missing, skip tool registration');
    return;
  }
  const defs = [
    {
      name: 'remote_status',
      description:
        'List remote-control consoles captured by this plugin: pid, host, socket, state, byte count, log path and the last screen lines. Use it first to learn whether a console exists and whether the user has finished logging in.',
      parameters: {
        console_pid: { type: 'string', description: 'Optional console pid; omit to show every live console.' },
        all: { type: 'boolean', description: 'Include terminals that already exited (default false).' },
      },
      async execute(args) {
        const every = [...S.consoles.values()];
        const covers = args.all === true ? every : every.filter((cover) => !cover.ended);
        if (covers.length === 0) {
          return {
            text:
              every.length > 0
                ? `NO_LIVE_CONSOLE: 没有存活的 ssh 终端（历史 ${every.length} 个已退出）。请在右侧栏「新建终端」里选择「dsh-ssh 远程」重新登录。`
                : 'NO_CONSOLE: 还没有 ssh 终端。请在右侧栏「新建终端」里选择「dsh-ssh 远程」，选远端并完成登录。',
          };
        }
        const selected =
          args.console_pid !== undefined && args.console_pid !== ''
            ? covers.filter((cover) => cover.pid === String(args.console_pid))
            : covers;
        return { text: selected.map(statusOf).join('\n\n---\n\n') };
      },
    },
    {
      name: 'remote_run',
      description:
        "Run one command inside the user's remote console PTY: it appears in the sidebar like human typing, and its output is visible to the user. Returns bounded output plus the exit code the shell reports. Use this when the user should watch it, when the command needs a tty (sudo, vim, nested ssh), or when shell state (cd/export) must persist between calls. Prefer remote_exec for pure data collection or when you must judge success by exit code. Refuses to write while the terminal is waiting for the user's ssh password or host-key confirmation. Never end the command with `exit`/`logout`: that closes the remote shell and the whole console (the tools stop working and the user must log in again); such commands need approval anyway. The PTY merges stderr into stdout. On timeout the command may still be running: use remote_log to read more.",
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
        timeout_ms: { type: 'number', description: `Wait bound in ms (default ${DEFAULT_TIMEOUT_MS}).` },
        console_pid: { type: 'string', description: 'Optional console pid when several terminals are open.' },
      },
      async execute(args, exec) {
        const cover = requireConsole(args);
        await gateDangerousCommand(ctx, exec, args.command, 'remote_run', cover, { checkTerminating: true });
        const timeout = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
        const result = await cover.run(args.command, Math.min(timeout, 600000));
        audit(cover, {
          tool: 'remote_run',
          action: 'run',
          cmd: args.command,
          exit: result.exitCode,
          status: result.status,
          ms: result.ms,
        });
        const text = [
          `status: ${result.status}`,
          `exit_code: ${result.exitCode === null ? 'unknown' : result.exitCode}`,
          `elapsed_ms: ${result.ms}`,
          result.note === undefined ? '' : `note: ${result.note}`,
          'output (PTY, stdout+stderr merged):',
          result.stdout.length === 0 ? '  (空)' : result.stdout.split('\n').map((line) => `  ${line}`).join('\n'),
        ]
          .filter((line) => line !== '')
          .join('\n');
        return { text };
      },
    },
    {
      name: 'remote_exec',
      description:
        "Run one command over the same authenticated ControlMaster socket, out of band: no PTY, no echo, no marker parsing. Returns native stdout, stderr and exit code. Output does NOT appear in the user's terminal window (only in the console log). Use it for data collection, scripts and anything where you must judge success by exit code; prefer remote_run when the user should watch it or the command needs a tty (sudo, vim, nested ssh). The channel is forced to BatchMode=yes, so once the terminal is closed it fails hard instead of prompting or reconnecting. On platforms without ControlMaster (Windows OpenSSH) it falls back to the same terminal PTY: the command becomes visible to the user and stdout/stderr are merged.",
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command; executed as: sh -c <command> on the remote host.' },
        timeout_ms: { type: 'number', description: `Wait bound in ms (default ${DEFAULT_TIMEOUT_MS}).` },
        cwd: { type: 'string', description: 'Optional working directory; prepended as: cd <cwd> && ...' },
        console_pid: { type: 'string', description: 'Optional console pid when several terminals are open.' },
      },
      async execute(args, exec) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') return await ptyExecTool(ctx, consoleCover, args, exec);
        const cover = consoleCover;
        await gateDangerousCommand(ctx, exec, args.command, 'remote_exec', cover);
        hydrate(cover);
        if (cover.host === undefined || cover.socket === undefined || cover.socket.length === 0) {
          throw new Error('CONSOLE_NOT_CONNECTED: 该终端还没有登录成功或没有可用的控制 socket');
        }
        const timeout =
          Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? Math.min(args.timeout_ms, 600000) : DEFAULT_TIMEOUT_MS;
        const script =
          typeof args.cwd === 'string' && args.cwd.length > 0
            ? `cd ${singleQuote(args.cwd)} && ${args.command}`
            : args.command;
        const remote = `sh -c ${singleQuote(script)}`;
        const prefix = await sshConfigPrefix();
        const argv = [
          ...prefix,
          '-S',
          cover.socket,
          '-o',
          'BatchMode=yes',
          '-o',
          'ControlMaster=no',
          '-o',
          'ConnectTimeout=10',
          '--',
          cover.host,
          remote,
        ];
        const started = Date.now();
        const result = await new Promise((resolve) => {
          execFile('ssh', argv, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
            resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
          });
        });
        const ms = Date.now() - started;
        const failed = result.code === null;
        const closed = failed && /control socket|connection refused|no such file/i.test(result.stderr);
        writeEvent(cover, {
          t: Date.now(),
          k: 'exec-via-ssh',
          code: result.code,
          ms,
          cmd: stripArgs(script),
        });
        audit(cover, { tool: 'remote_exec', action: 'exec', cmd: script, exit: result.code, status: failed ? 'error' : 'done', ms });
        const clip = (text) => (text.length > 262144 ? `${text.slice(0, 262144)}\n[output truncated]` : text);
        const text = [
          `status: ${failed ? 'error' : 'done'}`,
          `exit_code: ${result.code === null ? 'unknown' : result.code}`,
          `elapsed_ms: ${ms}`,
          closed ? 'note: 控制 socket 不可用（终端可能已关闭），这是 fail-closed 行为' : '',
          'stdout:',
          clip(result.stdout).length === 0 ? '  (空)' : clip(result.stdout).split('\n').map((line) => `  ${line}`).join('\n'),
          'stderr:',
          clip(result.stderr).length === 0 ? '  (空)' : clip(result.stderr).split('\n').map((line) => `  ${line}`).join('\n'),
        ]
          .filter((line) => line !== '')
          .join('\n');
        return { text };
      },
    },
    {
      name: 'remote_upload',
      description:
        "Upload one local file to the remote host through this console's already-authenticated SSH connection: no password prompt and no second connection. Bytes are streamed, then the sha256 is compared on both sides. Refuses to overwrite an existing remote file unless overwrite is true. Writing a sensitive path (~/.ssh, /etc, sudoers, a shell profile) asks the user for approval first. Limit 256 MB (1 MiB through the PTY fallback used on platforms without ControlMaster); use remote_write_file for small text.",
      parameters: {
        local_path: { type: 'string', required: true, description: 'File to read on the machine running DSH.' },
        remote_path: {
          type: 'string',
          required: true,
          description: 'Destination path on the remote host; must not contain `..`.',
        },
        overwrite: { type: 'boolean', description: 'Overwrite when the remote path already exists (default false).' },
        mode: { type: 'string', description: "Optional chmod mode for the remote file, e.g. '0644'." },
        timeout_ms: { type: 'number', description: `Transfer timeout in ms (default ${TRANSFER_TIMEOUT_MS}).` },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args, exec) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') return await ptyUploadTool(ctx, consoleCover, args, exec);
        const cover = socketConsole(args);
        const localPath = String(args.local_path ?? '').trim();
        if (localPath.length === 0) throw new Error('BAD_PATH: local_path 为空');
        const remotePath = normalizeRemotePath(args.remote_path);
        const timeoutMs = transferTimeout(args.timeout_ms);
        let localStat;
        try {
          localStat = statSync(localPath);
        } catch (error) {
          throw new Error(`LOCAL_NOT_FOUND: 读不到本地文件（${String(error?.message ?? error)}）`);
        }
        if (!localStat.isFile()) throw new Error(`LOCAL_NOT_FILE: ${localPath} 不是普通文件`);
        if (localStat.size > MAX_TRANSFER_BYTES) {
          throw new Error(`FILE_TOO_LARGE: ${localStat.size} 字节，上限 ${MAX_TRANSFER_BYTES} 字节`);
        }
        await gateSensitiveWrite(ctx, exec, cover, 'remote_upload', remotePath);
        if (args.overwrite !== true) {
          const check = await execOverSocket(cover, `test -e ${singleQuote(remotePath)} && printf EXISTS`, {
            timeoutMs: 15000,
          });
          if (check.stdout.includes('EXISTS')) {
            throw new Error(`FILE_EXISTS: 远端已存在 ${remotePath}；确认覆盖请传 overwrite: true`);
          }
        }
        const started = Date.now();
        const result = await execOverSocket(cover, `cat > ${singleQuote(remotePath)}`, {
          stdinPath: localPath,
          timeoutMs,
        });
        if (result.code !== 0) {
          const detail = result.stderr.trim().slice(0, 800);
          throw new Error(
            `UPLOAD_FAILED: 远端写入 ${remotePath} 失败（exit ${String(result.code)}）${detail.length === 0 ? '' : `：${detail}`}。远端文件可能只写了一部分，请检查后重传。`,
          );
        }
        const localHash = await sha256File(localPath);
        const remoteHash = (await execOverSocket(cover, remoteHashScript(remotePath), { timeoutMs: 30000 })).stdout.trim();
        let modeNote = '';
        if (typeof args.mode === 'string' && args.mode.trim().length > 0) {
          const mode = args.mode.trim();
          if (!/^[0-7]{3,4}$/u.test(mode)) throw new Error('BAD_MODE: mode 必须是 3-4 位八进制，例如 0644');
          const chmodResult = await execOverSocket(cover, `chmod ${mode} ${singleQuote(remotePath)}`, { timeoutMs: 15000 });
          modeNote = chmodResult.code === 0 ? `\nmode: ${mode}` : `\nmode: 设置失败（exit ${String(chmodResult.code)}）`;
        }
        writeEvent(cover, {
          t: Date.now(),
          k: 'transfer',
          tool: 'remote_upload',
          path: remotePath,
          bytes: localStat.size,
          sha256: localHash,
        });
        if (remoteHash !== 'UNAVAILABLE' && remoteHash !== localHash) {
          throw new Error(
            `UPLOAD_HASH_MISMATCH: 上传后远端 sha256 与本地不一致\nlocal: ${localHash}\nremote: ${remoteHash}`,
          );
        }
        const verified = remoteHash === 'UNAVAILABLE' ? 'unavailable（远端没有 sha256sum/shasum）' : 'yes';
        audit(cover, {
          tool: 'remote_upload',
          action: 'upload',
          path: remotePath,
          bytes: localStat.size,
          verified: verified === 'yes',
        });
        return {
          text: [
            'status: done',
            `local: ${localPath}`,
            `remote: ${remotePath}`,
            `bytes: ${localStat.size}`,
            `sha256: ${localHash}`,
            `verified: ${verified}`,
            `elapsed_ms: ${Date.now() - started}`,
          ].join('\n') + modeNote,
        };
      },
    },
    {
      name: 'remote_download',
      description:
        "Copy one remote file to this machine through the console's authenticated SSH connection. Streams the bytes, refuses to overwrite an existing local file unless overwrite is true, and compares sha256 on both sides. Directories are not supported; use remote_exec with tar for those. Limit 256 MB (1 MiB through the PTY fallback used on platforms without ControlMaster).",
      parameters: {
        remote_path: {
          type: 'string',
          required: true,
          description: 'File to read on the remote host; must not contain `..`.',
        },
        local_path: { type: 'string', required: true, description: 'Destination path on the machine running DSH.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing local file (default false).' },
        timeout_ms: { type: 'number', description: `Transfer timeout in ms (default ${TRANSFER_TIMEOUT_MS}).` },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') return await ptyDownloadTool(ctx, consoleCover, args);
        const cover = socketConsole(args);
        const remotePath = normalizeRemotePath(args.remote_path);
        const localPath = String(args.local_path ?? '').trim();
        if (localPath.length === 0) throw new Error('BAD_PATH: local_path 为空');
        const timeoutMs = transferTimeout(args.timeout_ms);
        const quoted = singleQuote(remotePath);
        const info = await execOverSocket(
          cover,
          `if [ -d ${quoted} ]; then printf DIR; elif [ -f ${quoted} ]; then wc -c < ${quoted}; else printf MISSING; fi`,
          { timeoutMs: 15000 },
        );
        const probe = info.stdout.trim();
        if (probe === 'MISSING') throw new Error(`REMOTE_NOT_FOUND: 远端没有 ${remotePath}`);
        if (probe === 'DIR') throw new Error(`REMOTE_IS_DIR: ${remotePath} 是目录，remote_download 只支持单个文件`);
        const size = Number(probe);
        if (Number.isFinite(size) && size > MAX_TRANSFER_BYTES) {
          throw new Error(`FILE_TOO_LARGE: ${size} 字节，上限 ${MAX_TRANSFER_BYTES} 字节`);
        }
        if (existsSync(localPath) && args.overwrite !== true) {
          throw new Error(`FILE_EXISTS: 本地已存在 ${localPath}；确认覆盖请传 overwrite: true`);
        }
        mkdirSync(dirname(localPath), { recursive: true });
        // 先下到临时文件，校验通过再原子改名：失败或哈希不符时不会毁掉本地已有文件。
        const tempPath = `${localPath}.dsh-download-${process.pid}-${Date.now().toString(36)}`;
        const started = Date.now();
        const result = await execOverSocket(cover, `cat -- ${quoted}`, { stdoutPath: tempPath, timeoutMs });
        const cleanupTemp = () => {
          try {
            rmSync(tempPath, { force: true });
          } catch {
            /* ignore */
          }
        };
        if (result.code !== 0) {
          cleanupTemp();
          const detail = result.stderr.trim().slice(0, 800);
          throw new Error(
            `DOWNLOAD_FAILED: 读取 ${remotePath} 失败（exit ${String(result.code)}）${detail.length === 0 ? '' : `：${detail}`}`,
          );
        }
        const localHash = await sha256File(tempPath);
        const remoteHash = (await execOverSocket(cover, remoteHashScript(remotePath), { timeoutMs: 30000 })).stdout.trim();
        writeEvent(cover, {
          t: Date.now(),
          k: 'transfer',
          tool: 'remote_download',
          path: remotePath,
          bytes: result.bytes,
          sha256: localHash,
        });
        if (remoteHash !== 'UNAVAILABLE' && remoteHash !== localHash) {
          cleanupTemp();
          throw new Error(
            `DOWNLOAD_HASH_MISMATCH: 下载后本地 sha256 与远端不一致\nlocal: ${localHash}\nremote: ${remoteHash}`,
          );
        }
        renameSync(tempPath, localPath);
        const verified = remoteHash === 'UNAVAILABLE' ? 'unavailable（远端没有 sha256sum/shasum）' : 'yes';
        audit(cover, {
          tool: 'remote_download',
          action: 'download',
          path: remotePath,
          bytes: result.bytes,
          verified: verified === 'yes',
        });
        return {
          text: [
            'status: done',
            `remote: ${remotePath}`,
            `local: ${localPath}`,
            `bytes: ${result.bytes}`,
            `sha256: ${localHash}`,
            `verified: ${verified}`,
            `elapsed_ms: ${Date.now() - started}`,
          ].join('\n'),
        };
      },
    },
    {
      name: 'remote_read_file',
      description:
        "Read a remote text file through the authenticated SSH connection (no password, no echo in the user's terminal). Returns UTF-8 text; refuses to pretend binary data is text and points to remote_download instead. Bounded by max_bytes so a huge file cannot flood the conversation. Without ControlMaster (Windows) the read goes through the PTY, so it is visible and capped at 1 MiB.",
      parameters: {
        path: { type: 'string', required: true, description: 'Remote file path; must not contain `..`.' },
        max_bytes: { type: 'number', description: 'Read limit in bytes (default 131072, max 262144).' },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') return await ptyReadFileTool(consoleCover, args);
        const cover = socketConsole(args);
        const remotePath = normalizeRemotePath(args.path);
        const limit =
          Number.isFinite(args.max_bytes) && args.max_bytes > 0
            ? Math.min(Math.floor(args.max_bytes), 262144)
            : 131072;
        const result = await execOverSocket(cover, `cat -- ${singleQuote(remotePath)}`, {
          maxBytes: limit,
          timeoutMs: 30000,
        });
        if (result.code !== 0 && !result.truncated) {
          const detail = result.stderr.trim().slice(0, 800);
          throw new Error(
            `READ_FAILED: 读取 ${remotePath} 失败（exit ${String(result.code)}）${detail.length === 0 ? '' : `：${detail}`}`,
          );
        }
        const text = result.stdout;
        if (text.includes('\0')) {
          return {
            text: [
              `path: ${remotePath}`,
              `bytes: ${result.bytes}`,
              'binary: yes',
              'note: 看起来是二进制文件（含 NUL 字节），没有显示内容。请用 remote_download 取回后在本地处理。',
            ].join('\n'),
          };
        }
        audit(cover, { tool: 'remote_read_file', action: 'read', path: remotePath, bytes: result.bytes });
        return {
          text: [
            `path: ${remotePath}`,
            `bytes: ${result.bytes}`,
            `truncated: ${result.truncated ? `yes（超过 ${limit} 字节，只返回前 ${limit} 字节）` : 'no'}`,
            'content:',
            text.length === 0 ? '  (空文件)' : text.split('\n').map((line) => `  ${line}`).join('\n'),
          ].join('\n'),
        };
      },
    },
    {
      name: 'remote_write_file',
      description:
        "Write a small UTF-8 text file on the remote host through the authenticated SSH connection. Content is sent over stdin, so it never appears in the user's terminal. Refuses paths containing `..`, caps the payload at 256 KB (use remote_upload for bigger or binary files), and asks the user for approval when the target is a sensitive path (~/.ssh, /etc, sudoers, shell profiles). Without ControlMaster (Windows) it goes through the PTY: the write is visible and capped at 1 MiB.",
      parameters: {
        path: { type: 'string', required: true, description: 'Remote file path; must not contain `..`.' },
        content: { type: 'string', required: true, description: 'UTF-8 text to write (max 256 KB).' },
        append: { type: 'boolean', description: 'Append instead of replacing the file (default false).' },
        mode: { type: 'string', description: "Optional chmod mode, e.g. '0644'." },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args, exec) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') return await ptyWriteFileTool(ctx, consoleCover, args, exec);
        const cover = socketConsole(args);
        const remotePath = normalizeRemotePath(args.path);
        const content = typeof args.content === 'string' ? args.content : '';
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_TEXT_WRITE_BYTES) {
          throw new Error(`CONTENT_TOO_LARGE: ${bytes} 字节，上限 ${MAX_TEXT_WRITE_BYTES} 字节；大文件请用 remote_upload`);
        }
        await gateSensitiveWrite(ctx, exec, cover, 'remote_write_file', remotePath);
        const append = args.append === true;
        const result = await execOverSocket(cover, `cat ${append ? '>>' : '>'} ${singleQuote(remotePath)}`, {
          stdinText: content,
          timeoutMs: 30000,
        });
        if (result.code !== 0) {
          const detail = result.stderr.trim().slice(0, 800);
          throw new Error(
            `WRITE_FAILED: 写入 ${remotePath} 失败（exit ${String(result.code)}）${detail.length === 0 ? '' : `：${detail}`}`,
          );
        }
        let modeNote = '';
        if (typeof args.mode === 'string' && args.mode.trim().length > 0) {
          const mode = args.mode.trim();
          if (!/^[0-7]{3,4}$/u.test(mode)) throw new Error('BAD_MODE: mode 必须是 3-4 位八进制，例如 0644');
          const chmodResult = await execOverSocket(cover, `chmod ${mode} ${singleQuote(remotePath)}`, { timeoutMs: 15000 });
          modeNote = chmodResult.code === 0 ? `\nmode: ${mode}` : `\nmode: 设置失败（exit ${String(chmodResult.code)}）`;
        }
        writeEvent(cover, {
          t: Date.now(),
          k: 'transfer',
          tool: 'remote_write_file',
          path: remotePath,
          bytes,
          append,
        });
        audit(cover, { tool: 'remote_write_file', action: 'write', path: remotePath, bytes, append });
        return {
          text: ['status: done', `path: ${remotePath}`, `bytes: ${bytes}`, `append: ${append ? 'yes' : 'no'}`].join('\n') +
            modeNote,
        };
      },
    },
    {
      name: 'remote_forward',
      description:
        "Manage loopback port forwards over the console's authenticated SSH connection. start opens `ssh -N -L 127.0.0.1:<local_port>:<remote_host>:<remote_port>` (bound to loopback only, so other machines on the LAN cannot reach it), stop closes one, list shows the console's tunnels. Tunnels are also stopped when the terminal ends or remote_close runs. Use it to reach a database, a dev server or a private panel that only listens on the remote host. Requires a ControlMaster socket, so it is unavailable on Windows (there is no authenticated connection to reuse).",
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: "'start' opens a tunnel, 'stop' closes one, 'list' shows this console's tunnels.",
        },
        remote_host: {
          type: 'string',
          description: "Address the remote host connects to (default 127.0.0.1). Use the remote's own IP or an address it can reach.",
        },
        remote_port: { type: 'number', description: 'Port on the remote side to reach (required for start).' },
        local_port: { type: 'number', description: 'Loopback port to listen on locally; default picks a free port.' },
        forward_id: { type: 'string', description: 'Tunnel id returned by start (required for stop).' },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args) {
        const consoleCover = liveConsole(args);
        if (transportOf(consoleCover) === 'pty') {
          throw new Error(
            'FORWARD_UNAVAILABLE: 端口转发需要一条已经认证好的 ControlMaster 连接；' +
              '当前终端没有 socket（Windows 版 OpenSSH 不支持 ControlMaster），无法在不重新输密码的前提下建隧道。' +
              '可以在终端里手动执行 ssh -N -L ...，或换到支持 ControlMaster 的平台。',
          );
        }
        const cover = socketConsole(args);
        const action = String(args.action ?? '').trim().toLowerCase();
        if (action === 'list') {
          const mine = [...S.forwards.values()].filter((info) => info.coverPid === cover.pid);
          if (mine.length === 0) return { text: 'forwards: 0（当前终端没有端口转发）' };
          return {
            text: [
              `forwards: ${mine.length}`,
              ...mine.map(
                (info) =>
                  `${info.id}: 127.0.0.1:${info.listenPort} -> ${info.remoteHost}:${info.remotePort}（pid ${String(info.pid)}）`,
              ),
            ].join('\n'),
          };
        }
        if (action === 'stop') {
          const id = String(args.forward_id ?? '').trim();
          const info = S.forwards.get(id);
          if (info === undefined) throw new Error(`FORWARD_NOT_FOUND: 没有 ${id} 这个转发（先用 action: list 看）`);
          if (info.coverPid !== cover.pid) throw new Error('FORWARD_NOT_OWNED: 这个转发属于另一个终端');
          const stopped = await stopForward(info);
          writeEvent(cover, { t: Date.now(), k: 'forward-stop', id, listen: `127.0.0.1:${info.listenPort}` });
          audit(cover, {
            tool: 'remote_forward',
            action: 'forward-stop',
            id,
            listen: `127.0.0.1:${info.listenPort}`,
          });
          return {
            text: stopped.closed
              ? `STOPPED: ${id}（127.0.0.1:${info.listenPort} 已关闭）`
              : `STOPPED: ${id} 已从 master 取消，但 127.0.0.1:${info.listenPort} 仍在监听（可能是别的进程占用该端口）`,
          };
        }
        if (action !== 'start') throw new Error('BAD_ACTION: action 必须是 start / stop / list');
        const remotePort = Number(args.remote_port);
        if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          throw new Error('BAD_PORT: remote_port 必须是 1-65535 的整数');
        }
        const remoteHost =
          typeof args.remote_host === 'string' && args.remote_host.trim().length > 0 ? args.remote_host.trim() : '127.0.0.1';
        if (!/^[A-Za-z0-9.:_[\]-]+$/u.test(remoteHost)) throw new Error('BAD_HOST: remote_host 含非法字符');
        const localPortRaw = Number(args.local_port);
        const info = await startForward(cover, {
          localPort: Number.isFinite(localPortRaw) ? localPortRaw : undefined,
          remoteHost,
          remotePort,
        });
        writeEvent(cover, {
          t: Date.now(),
          k: 'forward',
          id: info.id,
          listen: `127.0.0.1:${info.listenPort}`,
          target: `${remoteHost}:${remotePort}`,
        });
        audit(cover, {
          tool: 'remote_forward',
          action: 'forward-start',
          id: info.id,
          listen: `127.0.0.1:${info.listenPort}`,
          target: `${remoteHost}:${remotePort}`,
        });
        return {
          text: [
            'status: started',
            `id: ${info.id}`,
            `listen: 127.0.0.1:${info.listenPort}`,
            `target: ${remoteHost}:${remotePort}（由远端主机发起连接）`,
            'note: 只绑定回环地址，局域网其他机器连不上；终端结束或 remote_close 时自动停止。',
          ].join('\n'),
        };
      },
    },
    {
      name: 'remote_screen',
      description:
        "Return the last N lines of the user's remote console screen (plain text, ANSI stripped). Use it to answer 'what does the user see now' or to inspect an interactive program; prefer remote_run / remote_log for command results.",
      parameters: {
        lines: { type: 'number', description: 'How many trailing lines (default 40, max 400).' },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args) {
        const cover = requireConsole(args);
        const count = Number.isFinite(args.lines) && args.lines > 0 ? Math.min(Math.floor(args.lines), 400) : 40;
        return { text: cover.screen(count) };
      },
    },
    {
      name: 'remote_log',
      description:
        "Read the unified console log incrementally: both the user's own commands (they appear as terminal echo) and the agent's commands/results, in one append-only JSONL. Pass the cursor returned by the previous call; omit it to read from the beginning. Use this to catch up after the user worked in the terminal and asked you to take over.",
      parameters: {
        cursor: { type: 'number', description: 'Byte offset returned by the previous remote_log call (default 0).' },
        max_bytes: { type: 'number', description: 'Maximum bytes to return (default 65536, max 262144).' },
        console_pid: { type: 'string', description: 'Optional console pid.' },
      },
      async execute(args) {
        const cover = requireConsole(args);
        const cursor = Number.isFinite(args.cursor) && args.cursor >= 0 ? Math.floor(args.cursor) : 0;
        const maxBytes =
          Number.isFinite(args.max_bytes) && args.max_bytes > 0 ? Math.min(Math.floor(args.max_bytes), 262144) : 65536;
        const file = logFileFor(cover);
        if (!existsSync(file)) {
          const mem = cover.events.join('');
          return { text: `cursor: ${mem.length}\nfrom_memory: true\ndata:\n${mem}` };
        }
        try {
          const fd = openSync(file, 'r');
          try {
            const size = fstatSync(fd).size;
            const from = Math.min(cursor, size);
            const to = Math.min(size, from + maxBytes);
            const buffer = Buffer.alloc(to - from);
            if (to > from) readSync(fd, buffer, 0, to - from, from);
            const rotated = cursor > size;
            return {
              text:
                `cursor: ${to}\ntotal: ${size}${rotated ? '\nnote: 日志已滚动，cursor 从 0 重新计数' : ''}\n` +
                `data:\n${buffer.toString('utf8')}`,
            };
          } finally {
            closeSync(fd);
          }
        } catch (error) {
          return { text: `LOG_READ_FAILED: ${String(error?.message ?? error)}\nfrom_memory:\n${cover.events.join('')}` };
        }
      },
    },
    {
      name: 'remote_audit_read',
      description:
        "Read the persistent audit trail: what the agent did on the remote host (commands with exit codes, approvals, file transfers, port forwards, session start/end). It contains no screen output and none of the text the user typed, survives terminal close, and rotates at 8 MB. Pass the cursor from the previous call to read incrementally; filter by tool name to keep the answer small. Works without a live terminal.",
      parameters: {
        cursor: { type: 'number', description: 'Byte offset returned by the previous call (default 0).' },
        max_bytes: { type: 'number', description: 'Maximum bytes to return (default 65536, max 262144).' },
        tool: {
          type: 'string',
          description: "Optional tool filter, e.g. 'remote_run', 'remote_exec', 'remote_upload', 'session'.",
        },
      },
      async execute(args) {
        const result = readAudit({
          cursor: Number.isFinite(args.cursor) && args.cursor >= 0 ? Math.floor(args.cursor) : 0,
          maxBytes:
            Number.isFinite(args.max_bytes) && args.max_bytes > 0
              ? Math.min(Math.floor(args.max_bytes), 262144)
              : 65536,
          tool: typeof args.tool === 'string' && args.tool.length > 0 ? args.tool : undefined,
        });
        return {
          text: [
            `cursor: ${result.cursor}`,
            `total: ${result.total}`,
            `lines: ${result.lines}${result.filtered > 0 ? `（过滤掉 ${result.filtered} 条不匹配的记录）` : ''}`,
            result.rotated ? 'note: 审计日志已滚动，cursor 从 0 重新计数' : '',
            'data:',
            result.data.length === 0 ? '  (空)' : result.data.split('\n').map((line) => `  ${line}`).join('\n'),
          ]
            .filter((line) => line !== '')
            .join('\n'),
        };
      },
    },
    {
      name: 'remote_audit_export',
      description:
        "Export the whole audit trail to a file on this machine (not the remote host): 'jsonl' keeps the raw records, 'csv' gives fixed columns for a spreadsheet. Written 0600. Useful to hand the trail to someone else or keep a copy before uninstalling the plugin.",
      parameters: {
        local_path: { type: 'string', required: true, description: 'Destination path on the machine running DSH.' },
        format: { type: 'string', description: "'jsonl' (default) or 'csv'." },
      },
      async execute(args) {
        const localPath = String(args.local_path ?? '').trim();
        if (localPath.length === 0) throw new Error('BAD_PATH: local_path 为空');
        const format = String(args.format ?? 'jsonl').trim().toLowerCase();
        if (format !== 'jsonl' && format !== 'csv') throw new Error("BAD_FORMAT: format 只能是 'jsonl' 或 'csv'");
        const result = exportAudit({ localPath, format });
        return {
          text: [
            'status: done',
            `path: ${localPath}`,
            `format: ${result.format}`,
            `records: ${result.records}`,
            `bytes: ${result.bytes}`,
          ].join('\n'),
        };
      },
    },
    {
      name: 'remote_close',
      description:
        "Disconnect the remote console: terminate the PTY (which kills the local ssh master), ask the control socket to exit and remove the rendezvous/socket files. After this the agent has no remote capability.",
      parameters: {
        console_pid: { type: 'string', description: 'Optional console pid; omit for the newest console.' },
      },
      async execute(args) {
        const cover = requireConsole(args);
        killForwardsFor(cover);
        audit(cover, { tool: 'remote_close', action: 'close' });
        killConsole(cover, 'agent-close');
        return { text: `CLOSED: pid ${cover.pid}（${cover.host ?? '未知主机'}）已断开，端口转发已停止，之后任何远端调用都会失败。` };
      },
    },
  ];

  for (const def of defs) {
    tools.register(
      defineTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        output: toolOutput(),
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.();
          return await def.execute(args, exec);
        },
      }),
    );
  }
  debug('tools registered');
}

/* ───────────────────────── 自测（隔离实例） ───────────────────────── */

async function selfTest(ctx) {
  const file = join(RC_DIR, 'selftest.log');
  const write = (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* ignore */
    }
  };
  write('selftest start');
  try {
    const handle = await ctx.subprocess.spawnTerminal({
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      cwd: homedir(),
      rows: 24,
      cols: 80,
      terminalType: 'xterm-256color',
      graceMs: 3000,
    });
    write(`spawned pid=${handle.pid} (plain bash: not a wrapper, must NOT auto-register)`);
    // 自测把普通 PTY 手动登记成 console，用来验证「哨兵 → 输出/退出码」链路
    const cover = new Console(String(handle.pid), handle, new PassThrough(), { argv: ['/bin/bash'] });
    S.consoles.set(cover.pid, cover);
    attachHandle(cover);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const one = await cover.run('echo SELFTEST-$((40+2))', 8000);
    write(`run1 status=${one.status} exit=${String(one.exitCode)} stdout=${JSON.stringify(one.stdout)}`);
    const two = await cover.run('false', 8000);
    write(`run2 status=${two.status} exit=${String(two.exitCode)}`);
    const three = await cover.run('sleep 0.2; echo THREE-OK; exit 7', 8000);
    write(`run3 status=${three.status} exit=${String(three.exitCode)} stdout=${JSON.stringify(three.stdout)}`);
    const screen = cover.screen(5);
    write(`screen=${JSON.stringify(screen)}`);
    write(`bytes=${cover.bytes} log=${logFileFor(cover)}`);
    const logText = existsSync(logFileFor(cover)) ? readFileSync(logFileFor(cover), 'utf8').split('\n').length : 0;
    write(`log lines=${logText}`);
    await handle.terminate();
    await new Promise((resolve) => setTimeout(resolve, 400));
    write(`ended=${cover.ended} exit=${JSON.stringify(cover.exit ?? null)}`);
    write('selftest done');
  } catch (error) {
    write(`selftest FAIL ${String(error?.stack ?? error)}`);
  }
}

/* ───────────────────────── 入口 ───────────────────────── */

export function apply(ctx, config) {
  S.config = config !== null && typeof config === 'object' ? config : {};
  ensureDirs();
  debug(`apply (installed=${String(S.installed)}) rcDir=${RC_DIR}`);
  if (S.installed === false) sweepStaleFiles();
  wrapSpawnTerminal(ctx);
  wrapShells(ctx);
  wrapRetain(ctx);
  applyTools(ctx);
  S.installed = true;

  if (SELFTEST) setTimeout(() => void selfTest(ctx), 2000).unref?.();

  return () => {
    debug('dispose');
    // 转发子进程没有别的 owner：插件卸载后必须自己收掉，否则本机端口会一直开着。
    killForwardsFor(undefined);
    try {
      const subprocess = ctx.subprocess;
      if (S.wrappers.spawnTerminal !== undefined && subprocess.spawnTerminal === S.wrappers.spawnTerminal) {
        // 保留包装，避免热加载窗口里丢掉正在运行的 console
        debug('dispose: keeping spawnTerminal wrapper for live consoles');
      }
    } catch {
      /* ignore */
    }
  };
}

/* ───────────────────────── 测试采光口（不是公共 API） ───────────────────────── */

/**
 * 只给仓库自带的 `tests/` 用：导出纯函数和 Console 类，让测试不必起整个 DSH。
 * 发布包以 `files` 白名单分发，测试不进 npm 包；这里也不承诺稳定。
 */
export const __testing = {
  Console,
  dangerousMatches,
  terminatingMatches,
  gateDangerousCommand,
  requireApproval,
  sanitize,
  redact,
  echoSkipLength,
  singleQuote,
  discoverHosts,
  configHostLines,
  isDirectTarget,
  ensureDirs,
  ensureHostLaunchers,
  ensureNewSessionLauncher,
  sweepStaleFiles,
  state,
  // 文件传输 / 端口转发的内部件：集成测试直接拿真实 sshd 调它们
  normalizeRemotePath,
  sensitiveWriteMatches,
  sshSocketArgv,
  execOverSocket,
  reserveFreePort,
  portAccepts,
  startForward,
  stopForward,
  killForwardsFor,
  sha256File,
  remoteHashScript,
  transportOf,
  ptyWriteFile,
  ptyReadFile,
  ptyRemoteHash,
  ptyExec,
  base64DecodeFlag,
  PTY_TRANSFER_LIMIT,
  MAX_TEXT_WRITE_BYTES,
  audit,
  readAudit,
  exportAudit,
  auditFiles,
  AUDIT_FILE,
  paths: { RC_DIR, BIN_DIR, LOG_DIR, SESS_DIR, SOCK_DIR },
};
