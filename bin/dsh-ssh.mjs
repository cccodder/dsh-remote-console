#!/usr/bin/env node
/**
 * dsh-ssh.mjs — 没有 bash 的平台（Windows）用的菜单包装器。
 *
 * 行为与 bin/dsh-ssh 对齐：列主机 → 选一个 → 在窗口里看到 `ssh ... -- target` 这行 →
 * ssh 自己提示密码；退出后回菜单（菜单模式）或提示终端已结束（指定主机模式）。
 *
 * 与 bash 版的差别只在连接参数：Windows 版 OpenSSH 不支持 ControlMaster，所以这里
 * 不传 `-M` / `-S`，rendezvous 里的 socket 留空。宿主侧插件看到没有 socket 就自动
 * 退回 PTY 通道（命令与传输走同一个终端窗口，文件上限 1 MiB）。
 *
 * 参数（由宿主生成的启动器传入）：
 *   --host <alias>      ssh 配置里的别名 / 主机名（user、port 从 hosts.tsv 补）
 *   --target <spec>     user@host[:port] 直连
 *   --ask-target        交互式问一个 user@host[:port]
 *   -i 等               DSH 给候选 shell 追加的参数，忽略
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ARGV = process.argv.slice(2);

/** 读一个带值的参数（--flag value 或 --flag=value）。 */
function argValue(flag) {
  for (let index = 0; index < ARGV.length; index += 1) {
    const arg = ARGV[index];
    if (arg === flag) return ARGV[index + 1] ?? '';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

// rc 目录：启动器会传 --rc-dir（包装器所在 <rc-dir>/bin/ 的上一级），比环境变量可靠——
// 桌面版重建 PTY 环境时可能没有 DSH_HOME，算错目录就会让 socket/rendezvous 对不上宿主。
const RC_OVERRIDE = argValue('--rc-dir');
const RC_DIR =
  RC_OVERRIDE !== undefined && RC_OVERRIDE !== ''
    ? RC_OVERRIDE
    : process.env.DSH_REMOTE_CONSOLE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-console');
const SESS_DIR = join(RC_DIR, 'sessions');
const SOCK_DIR = join(RC_DIR, 'socks');
const HOSTS_FILE = join(RC_DIR, 'hosts.tsv');
const SSH_CONFIG = process.env.DSH_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
const DRYRUN = process.env.DSH_RC_DRYRUN === '1';
const IS_WINDOWS = process.platform === 'win32';

const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });

/**
 * 行队列式提问：readline 在管道输入结束时会一次性读完并触发 close，
 * 此时「已经读到缓冲区里的行」仍然要按顺序消费，不能一律当空回答。
 */
const lines = [];
const waiters = [];
let inputClosed = false;
readline.on('line', (line) => {
  const value = String(line ?? '').trim();
  const waiter = waiters.shift();
  if (waiter !== undefined) waiter(value);
  else lines.push(value);
});
readline.on('close', () => {
  inputClosed = true;
  for (const waiter of waiters.splice(0)) waiter('');
});

function ask(question) {
  process.stdout.write(question);
  if (lines.length > 0) return Promise.resolve(lines.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => waiters.push(resolve));
}

function osc(text) {
  process.stdout.write(`\x1b]1337;DSH-RC;${text}\x07`);
}

/** 与 bash 版一致：把命令结束钩子通过环境变量带进远端交互 shell。 */
function buildHook() {
  return (
    'r=$?; if [ -z "${__dsh_c-}" ]; then __dsh_c=1; printf "\\033[2J\\033[3J\\033[H"; fi; ' +
    'printf "\\033]1337;DSH;D;%d\\007" "$r"'
  );
}

/** 远端命令用单引号包住（钩子里没有单引号），交给远端 sh 执行。 */
function remoteCommand() {
  const hook = buildHook().replaceAll("'", "'\\''");
  return `env PROMPT_COMMAND='${hook}' HISTCONTROL='' bash -li`;
}

/** ssh 的通用配置前缀：显式 DSH_SSH_CONFIG 优先，其次探测默认配置是否可用。 */
function configPrefix() {
  if (typeof process.env.DSH_SSH_CONFIG === 'string' && process.env.DSH_SSH_CONFIG.length > 0) {
    return ['-F', SSH_CONFIG];
  }
  const probe = spawnSync('ssh', ['-G', 'localhost'], { encoding: 'utf8', timeout: 8000 });
  const broken = probe.error !== undefined || /bad owner or permissions/i.test(String(probe.stderr ?? ''));
  if (!broken) return [];
  return existsSync(SSH_CONFIG) ? ['-F', SSH_CONFIG] : ['-F', IS_WINDOWS ? 'NUL' : '/dev/null'];
}

function sshConfigAliases() {
  try {
    const text = readFileSync(SSH_CONFIG, 'utf8');
    const hosts = [];
    for (const line of text.split('\n')) {
      const match = /^\s*Host\s+(.+)$/i.exec(line);
      if (match === null) continue;
      for (const token of match[1].trim().split(/\s+/)) {
        if (token.length === 0 || token.startsWith('!') || /[?*]/.test(token)) continue;
        hosts.push(token);
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

function savedHosts() {
  try {
    return readFileSync(HOSTS_FILE, 'utf8')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((fields) => (fields[0] ?? '').length > 0)
      .map((fields) => ({ host: fields[0], user: fields[1] ?? '', port: fields[2] ?? '' }));
  } catch {
    return [];
  }
}

function saveHost(host, user = '', port = '') {
  if (host === undefined || host.length === 0) return;
  const existing = savedHosts().some((entry) => entry.host === host);
  if (existing) return;
  try {
    mkdirSync(RC_DIR, { recursive: true });
    writeFileSync(HOSTS_FILE, `${host}\t${user}\t${port}\n`, { flag: 'a', mode: 0o600 });
  } catch {
    /* 存不下就算了，主机仍可本次使用 */
  }
}

function lookupSaved(host) {
  return savedHosts().find((entry) => entry.host === host) ?? { user: '', port: '' };
}

/** 解析 user@host[:port]：只在恰好一个冒号时拆端口，避免把 IPv6 拆错。 */
function parseTarget(text) {
  const line = String(text ?? '').replace(/\s+/gu, '');
  if (line.length === 0) return undefined;
  let user = '';
  let hostport = line;
  if (line.includes('@')) {
    user = line.slice(0, line.indexOf('@'));
    hostport = line.slice(line.indexOf('@') + 1);
  }
  let host = hostport;
  let port = '';
  const colons = (hostport.match(/:/gu) ?? []).length;
  if (colons === 1) {
    host = hostport.slice(0, hostport.indexOf(':'));
    port = hostport.slice(hostport.indexOf(':') + 1);
  }
  if (host.length === 0) return undefined;
  return { host, user, port };
}

function sshArgv({ host, user, port }) {
  const argv = ['ssh', ...configPrefix(), '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (port.length > 0) argv.push('-p', port);
  argv.push('-t', '--');
  argv.push(user.length > 0 ? `${user}@${host}` : host);
  argv.push(remoteCommand());
  return argv;
}

function rendezvousPath(host, pid) {
  const safe = host.replace(/[^A-Za-z0-9._-]/gu, '_');
  return join(SESS_DIR, `${safe}.${pid}.json`);
}

function writeRendezvous({ host, user, port }, pid) {
  try {
    mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 });
    const payload = {
      host: host.replace(/[^A-Za-z0-9._:-]/gu, ''),
      user: user.replace(/[^A-Za-z0-9._-]/gu, ''),
      port: port.replace(/[^0-9]/gu, ''),
      // 没有 ControlMaster：socket 留空，宿主据此退回 PTY 通道
      socket: '',
      pid,
      startedAt: Math.floor(Date.now() / 1000),
    };
    writeFileSync(rendezvousPath(host, pid), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return rendezvousPath(host, pid);
  } catch {
    return undefined;
  }
}

function runSsh(target, { inMenu }) {
  const argv = sshArgv(target);
  const rendezvous = DRYRUN ? undefined : writeRendezvous(target, process.pid);
  const printed = [argv[0], ...argv.slice(1, -1)]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
  osc(`CONNECT ${target.host}`);
  process.stdout.write(`\n>> ${printed}\n\n`);
  if (DRYRUN) {
    process.stdout.write('[dry-run] 以上命令不会真正执行\n');
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stdout.write(`\n无法执行 ssh：${error.message}\n`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : signal === null ? 1 : 1;
      if (rendezvous !== undefined) rmSync(rendezvous, { force: true });
      osc(`RETURN ${exitCode}`);
      process.stdout.write(`\n── ssh 已退出（退出码 ${exitCode}）${inMenu ? '，回到远端选择 ──' : ' ──'}\n`);
      if (!inMenu) {
        process.stdout.write('   这个终端已经结束（ssh 进程退出），工具会拒绝写入。\n');
        process.stdout.write('   请关闭此标签，在右侧栏重新打开 SSH 终端并重新登录。\n');
      }
      resolve(exitCode);
    });
  });
}

function printMenu(hosts) {
  process.stdout.write('\n┌──────────────────────────────────────────────────────────┐\n');
  process.stdout.write('│                DSH 远程控制终端（Windows 版）            │\n');
  process.stdout.write('└──────────────────────────────────────────────────────────┘\n');
  hosts.forEach((entry, index) => {
    const suffix = entry.user.length > 0 || entry.port.length > 0 ? `  (${entry.user || '?'}@${entry.port || '22'})` : '';
    process.stdout.write(`  ${index + 1}. ${entry.host}${suffix}\n`);
  });
  process.stdout.write('\n  输入序号连接，n 新建主机，q 退出\n');
}

async function pickHost() {
  for (;;) {
    // stdin 关了（管道输入结束）就别再循环打印菜单
    if (inputClosed) return undefined;
    const aliases = sshConfigAliases();
    const saved = savedHosts();
    const seen = new Set();
    const hosts = [];
    for (const entry of [...saved.map((item) => ({ ...item })), ...aliases.map((host) => ({ ...lookupSaved(host), host }))]) {
      if (seen.has(entry.host)) continue;
      seen.add(entry.host);
      hosts.push(entry);
    }
    printMenu(hosts);
    const answer = await ask('> ');
    if (answer === '' || answer === 'q' || answer === 'Q') return undefined;
    if (answer === 'n' || answer === 'N') {
      const host = await ask('主机 (host/IP): ');
      if (host.length === 0) continue;
      const user = await ask('用户名 (留空则用 ssh 配置/询问): ');
      const port = await ask('端口 (留空默认 22): ');
      saveHost(host, user, port);
      return { host, user, port };
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= hosts.length) return hosts[index - 1];
    process.stdout.write('无效选择\n');
  }
}

async function main(argv) {
  for (const dir of [SESS_DIR, SOCK_DIR]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
  }
  let forcedHost = '';
  let targetSpec = '';
  let askTarget = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host' || arg === '-H') {
      forcedHost = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--host=')) forcedHost = arg.slice('--host='.length);
    else if (arg === '--target' || arg === '-T') {
      targetSpec = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--target=')) targetSpec = arg.slice('--target='.length);
    else if (arg === '--rc-dir') {
      index += 1;
    } else if (arg.startsWith('--rc-dir=')) {
      // 已在模块顶部解析过
    } else if (arg === '--ask-target') askTarget = true;
    // -i / --interactive / --login：DSH 追加的参数，忽略
  }

  if (targetSpec.length > 0 || askTarget) {
    const parsed = targetSpec.length > 0 ? parseTarget(targetSpec) : parseTarget(await ask('新建 SSH 会话 —— 目标（user@host，可加 :port，直接回车取消）: '));
    if (parsed === undefined) {
      process.stdout.write('已取消。\n');
      return 0;
    }
    const code = await runSsh(parsed, { inMenu: false });
    if (code === 0) saveHost(parsed.host, parsed.user, parsed.port);
    return code;
  }

  if (forcedHost.length > 0) {
    const saved = lookupSaved(forcedHost);
    return await runSsh({ host: forcedHost, user: saved.user, port: saved.port }, { inMenu: false });
  }

  for (;;) {
    if (inputClosed) {
      process.stdout.write('已退出。\n');
      return 0;
    }
    const picked = await pickHost();
    if (picked === undefined) {
      process.stdout.write('已退出。\n');
      return 0;
    }
    await runSsh(picked, { inMenu: true });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    readline.close();
    process.exit(code);
  },
  (error) => {
    readline.close();
    process.stdout.write(`\n包装器出错：${String(error?.message ?? error)}\n`);
    process.exit(1);
  },
);
