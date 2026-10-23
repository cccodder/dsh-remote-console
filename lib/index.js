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
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
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
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { PassThrough } from 'node:stream';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-remote-console';
export const inject = ['subprocess', 'terminalController'];

const RC_DIR = process.env.DSH_REMOTE_CONSOLE_DIR ?? join(resolveDshHome(), 'remote-console');
const BIN_DIR = join(RC_DIR, 'bin');
const LOG_DIR = join(RC_DIR, 'logs');
const SESS_DIR = join(RC_DIR, 'sessions');
const SOCK_DIR = join(RC_DIR, 'socks');
/** 随包发布的菜单包装器（不往用户数据目录拷贝）。 */
const WRAPPER = fileURLToPath(new URL('../bin/dsh-ssh', import.meta.url));
const SSH_CONFIG = process.env.DSH_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
let sshPrefixCache = null;
/**
 * 通用 ssh 配置前缀：正常情况下直接用系统默认配置；只有当默认配置不可读
 * （例如企业镜像把 /etc/ssh 属主改错导致 "Bad owner or permissions"）才退回
 * `-F ~/.ssh/config`。这样在别的机器上不会平白绕过系统 ssh 配置。
 */
function sshConfigPrefix() {
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
      wrappers: {},
      consoles: new Map(),
      idToPid: new Map(),
      holders: new Map(),
      graceTimers: new Map(),
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
/** 读取 ~/.ssh/config 与 hosts.tsv 里的远端主机（供面板/启动器使用）。 */
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
  return [...hosts];
}

/** 为每个主机生成一个启动器脚本（用参数传 host，避免符号链接被 realpath 解析掉）。 */
function ensureHostLaunchers(hosts) {
  const created = [];
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
  for (const dir of [RC_DIR, BIN_DIR, LOG_DIR, SESS_DIR, SOCK_DIR]) {
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
  /((?:password|passwd|pwd|token|secret|api[_-]?key|X-Monitor-Token)\s*[=:]\s*)[^\s'\";]+/gi,
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
 * 命中危险模式时向用户要一次授权。用户拒绝、取消、没有 answerer 或没有
 * approval 服务，都抛错阻止执行。
 */
async function gateDangerousCommand(ctx, exec, command, toolName, cover) {
  const hits = dangerousMatches(command);
  if (hits.length === 0) return;
  const reason = `远端命令命中危险模式 ${hits.join(', ')}：${String(command).slice(0, 240)}`;
  if (cover !== undefined) {
    writeEvent(cover, { t: Date.now(), k: 'guard', tool: toolName, hits, cmd: stripArgs(String(command)) });
  }
  if (process.env.DSH_RC_DANGER_GUARD === 'off') {
    debug(`danger guard disabled by env, allowing ${toolName} hits=${hits.join(',')}`);
    return;
  }
  const approval = ctx.get('approval');
  if (approval === undefined) {
    throw new Error(`DANGEROUS_BLOCKED: ${reason}。当前部署没有审批服务（ctx.approval），命令未执行。`);
  }
  if (exec?.agent === undefined) {
    throw new Error(`DANGEROUS_BLOCKED: ${reason}。此次调用没有 agent 上下文，无法请求审批，命令未执行。`);
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });
  if (outcome !== 'allowed-once') {
    throw new Error(`DANGEROUS_REJECTED: 用户未批准（${outcome}），命令未执行。`);
  }
  if (cover !== undefined) {
    writeEvent(cover, { t: Date.now(), k: 'guard-approved', tool: toolName, hits });
  }
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
          note: this.ended ? '终端已结束' : `超过 ${timeoutMs} ms 未结束；可用 remote_log 继续看增量`,
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
        note: this.ended ? '终端已结束' : `超过 ${timeoutMs} ms 未结束；可用 remote_log 继续看增量`,
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
  debug(`PTY ended pid=${cover.pid} ${JSON.stringify(outcome ?? {})}`);
  cleanupRendezvous(cover);
  cover.deleteLog();
  const timer = S.graceTimers.get(cover.pid);
  if (timer !== undefined) {
    clearTimeout(timer);
    S.graceTimers.delete(cover.pid);
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
    const base = basename(String(spec.argv?.[0] ?? ''));
    const isConsole = base === 'dsh-ssh' || base.startsWith('dsh-ssh-');
    if (!isConsole) return handle;
    const cover = new Console(String(handle.pid), handle, new PassThrough(), spec);
    cover.sessionId = spec.env?.DSH_SESSION_ID;
    S.consoles.set(cover.pid, cover);
    writeEvent(cover, { t: Date.now(), k: 'mk', kind: 'spawn', argv: spec.argv, cwd: spec.cwd });
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
    const launchers = ensureHostLaunchers(discoverHosts());
    for (const launcher of launchers) {
      if (list.some((entry) => entry.path === launcher.path)) continue;
      extras.push({ path: launcher.path, name: launcher.name, args: [] });
    }
    const fresh = ensureNewSessionLauncher();
    if (fresh !== undefined && !list.some((entry) => entry.path === fresh.path)) {
      extras.push({ path: fresh.path, name: fresh.name, args: [] });
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

function statusOf(cover) {
  hydrate(cover);
  const tail = cover.screen(6);
  return [
    `pid: ${cover.pid}`,
    `host: ${cover.host ?? '(未连接)'}`,
    `socket: ${cover.socket ?? '-'}`,
    `state: ${cover.ended ? 'exited' : cover.pending !== null ? 'running' : 'idle'}`,
    `bytes: ${cover.bytes}`,
    `log: ${logFileFor(cover)}`,
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
        "Run one command inside the user's remote console PTY: it appears in the sidebar like human typing, and its output is visible to the user. Returns bounded output plus the exit code the shell reports. Use this when the user should watch it, when the command needs a tty (sudo, vim, nested ssh), or when shell state (cd/export) must persist between calls. Prefer remote_exec for pure data collection or when you must judge success by exit code. Refuses to write while the terminal is waiting for the user's ssh password or host-key confirmation. On timeout the command may still be running: use remote_log to read more.",
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
        timeout_ms: { type: 'number', description: `Wait bound in ms (default ${DEFAULT_TIMEOUT_MS}).` },
        console_pid: { type: 'string', description: 'Optional console pid when several terminals are open.' },
      },
      async execute(args, exec) {
        const cover = requireConsole(args);
        await gateDangerousCommand(ctx, exec, args.command, 'remote_run', cover);
        const timeout = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
        const result = await cover.run(args.command, Math.min(timeout, 600000));
        const text = [
          `status: ${result.status}`,
          `exit_code: ${result.exitCode === null ? 'unknown' : result.exitCode}`,
          `elapsed_ms: ${result.ms}`,
          result.note === undefined ? '' : `note: ${result.note}`,
          'stdout:',
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
        "Run one command over the same authenticated ControlMaster socket, out of band: no PTY, no echo, no marker parsing. Returns native stdout, stderr and exit code. Output does NOT appear in the user's terminal window (only in the console log). Use it for data collection, scripts and anything where you must judge success by exit code; prefer remote_run when the user should watch it or the command needs a tty (sudo, vim, nested ssh). The channel is forced to BatchMode=yes, so once the terminal is closed it fails hard instead of prompting or reconnecting.",
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command; executed as: sh -c <command> on the remote host.' },
        timeout_ms: { type: 'number', description: `Wait bound in ms (default ${DEFAULT_TIMEOUT_MS}).` },
        cwd: { type: 'string', description: 'Optional working directory; prepended as: cd <cwd> && ...' },
        console_pid: { type: 'string', description: 'Optional console pid when several terminals are open.' },
      },
      async execute(args, exec) {
        const cover = requireConsole(args);
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
      name: 'remote_close',
      description:
        "Disconnect the remote console: terminate the PTY (which kills the local ssh master), ask the control socket to exit and remove the rendezvous/socket files. After this the agent has no remote capability.",
      parameters: {
        console_pid: { type: 'string', description: 'Optional console pid; omit for the newest console.' },
      },
      async execute(args) {
        const cover = requireConsole(args);
        killConsole(cover, 'agent-close');
        return { text: `CLOSED: pid ${cover.pid}（${cover.host ?? '未知主机'}）已断开，之后任何远端调用都会失败。` };
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

export function apply(ctx) {
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
  gateDangerousCommand,
  sanitize,
  redact,
  echoSkipLength,
  singleQuote,
  discoverHosts,
  ensureDirs,
  ensureHostLaunchers,
  ensureNewSessionLauncher,
  sweepStaleFiles,
  state,
  paths: { RC_DIR, BIN_DIR, LOG_DIR, SESS_DIR, SOCK_DIR },
};
