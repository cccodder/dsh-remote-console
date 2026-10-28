/**
 * 真实 sshd 测试 harness。
 *
 * 在临时目录里生成 host key、client key、authorized_keys 和 sshd/ssh 配置，
 * 以当前用户（非 root 也可）在 127.0.0.1 的随机空闲端口启动一个只认公钥的 sshd，
 * 并给测试提供可用的 ssh 客户端、客户端配置、已知主机文件与清理函数。
 *
 * 找不到能真正运行的 ssh/sshd/ssh-keygen 时抛 SshToolsError，
 * 测试文件据此整组 skip（不会因为「机器上没有 sshd」而红）。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 容器/CI 里 OpenSSH 常见的安装位置（PATH 之外也兜底搜一遍）。 */
const SSH_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
const SSHD_DIRS = ['/usr/sbin', '/usr/local/sbin', '/opt/homebrew/sbin'];
const KEYGEN_DIRS = [...SSH_DIRS, ...SSHD_DIRS];

export class SshToolsError extends Error {
  constructor(message, details = []) {
    super(details.length > 0 ? `${message}；尝试过：${details.join(' | ')}` : message);
    this.name = 'SshToolsError';
    this.code = 'SSH_TOOLS_MISSING';
    this.details = details;
  }
}

export function isSshToolsError(error) {
  return error instanceof SshToolsError || error?.code === 'SSH_TOOLS_MISSING';
}

export function delay(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * 轮询直到 predicate 返回真值；predicate 抛错时立即失败（用于「进程提前退出」这类错误）。
 * 永远不用固定 sleep 等就绪状态。
 */
export async function waitFor(predicate, { timeout = 10000, interval = 50, message = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // predicate 抛错（比如「进程提前退出」）时立即失败，不再继续等。
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${message} 在 ${timeout}ms 内没有满足`);
    await delay(interval);
  }
}

/** 先 bind 0 拿到内核分配的空闲端口，再释放给 sshd/端口转发用。 */
export function getFreePort() {
  return new Promise((done, fail) => {
    const server = net.createServer();
    server.once('error', fail);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 能建立 TCP 连接就返回 true；被拒绝/超时返回 false。 */
export function canConnect(port, { host = '127.0.0.1', timeout = 500 } = {}) {
  return new Promise((done) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 轮询等端口开始监听（sshd 就绪、端口转发就绪都用它）。 */
export async function waitForPort(port, options = {}) {
  const { timeout = 10000, interval = 50, message = `端口 ${port} 没有开始监听` } = options;
  await waitFor(() => canConnect(port), { timeout, interval, message });
}

/** 轮询等端口关闭（连接被拒绝）；进程/sshd 清理后的残留断言用它。 */
export async function waitForPortClosed(port, options = {}) {
  const { timeout = 10000, interval = 50, message = `端口 ${port} 没有关闭` } = options;
  await waitFor(async () => !(await canConnect(port)), { timeout, interval, message });
}

function unique(list) {
  return [...new Set(list)];
}

function pathDirs() {
  return (process.env.PATH ?? '').split(':').filter((dir) => dir.length > 0);
}

/** 从二进制所在前缀推可能的共享库目录（便携/解压版 OpenSSH 需要）。 */
function candidateLibDirs(binPath) {
  const binDir = dirname(binPath);
  const roots = [resolve(binDir, '..'), resolve(binDir, '..', '..')];
  const relatives = [
    'lib/x86_64-linux-gnu',
    'lib/aarch64-linux-gnu',
    'lib64',
    'lib',
    'usr/lib/x86_64-linux-gnu',
    'usr/lib/aarch64-linux-gnu',
    'usr/lib64',
    'usr/lib',
  ];
  const dirs = [];
  for (const root of roots) {
    for (const relative of relatives) {
      const dir = resolve(root, relative);
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return unique(dirs);
}

function withLibraryPath(binPath, baseEnv) {
  const libs = candidateLibDirs(binPath);
  if (libs.length === 0) return baseEnv;
  const existing = (baseEnv.LD_LIBRARY_PATH ?? '').split(':').filter((dir) => dir.length > 0);
  return { ...baseEnv, LD_LIBRARY_PATH: unique([...libs, ...existing]).join(':') };
}

/**
 * 依次用「当前环境」和「补过 LD_LIBRARY_PATH 的环境」跑一次 `-V` 自检。
 * 解压版 openssh 在系统库路径外，只有补过库路径才跑得起来。
 */
function chooseTool(name, envVar, dirs) {
  const explicit = process.env[envVar];
  const candidates = explicit
    ? [explicit]
    : unique([...dirs.map((dir) => join(dir, name)), ...pathDirs().map((dir) => join(dir, name))]);

  const tried = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      tried.push(`${candidate}: 不存在`);
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      tried.push(`${candidate}: 不可执行`);
      continue;
    }
    const baseEnv = { ...process.env };
    const attempts = [
      ['当前环境', baseEnv],
      ['补 LD_LIBRARY_PATH', withLibraryPath(candidate, baseEnv)],
    ];
    for (const [label, env] of attempts) {
      const result = spawnSync(candidate, ['-V'], { env, timeout: 5000, encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const loaderError = /error while loading shared libraries|cannot open shared object/u.test(output);
      if (result.error) {
        tried.push(`${candidate}（${label}）: ${result.error.code ?? result.error.message}`);
        continue;
      }
      if (result.status === null) {
        tried.push(`${candidate}（${label}）: 被信号终止`);
        continue;
      }
      if (loaderError) {
        tried.push(`${candidate}（${label}）: ${output.trim().split('\n')[0]}`);
        continue;
      }
      if (name === 'ssh-keygen') {
        // ssh-keygen 没有干净的 --version：-V 打 usage 并以 1 退出，只要没被动态库卡住就算可用。
        if (output.trim().length === 0) {
          tried.push(`${candidate}（${label}）: 没有任何输出`);
          continue;
        }
      } else if (!/OpenSSH/u.test(output) || result.status !== 0) {
        tried.push(`${candidate}（${label}）: exit ${result.status} ${output.trim().slice(0, 120)}`);
        continue;
      }
      return { bin: resolve(candidate), env, explicit: Boolean(explicit) };
    }
  }
  throw new SshToolsError(
    `没有找到可用的 ${name}（可用环境变量 ${envVar} 指定绝对路径）`,
    tried,
  );
}

/**
 * 找到能用的 ssh / sshd / ssh-keygen，并算出让它们都能跑起来的子进程环境。
 * @param {{ binDirs?: string[] }} options binDirs 优先搜索的目录（例如手动解压的便携版 OpenSSH）
 */
export function findSshTools({ binDirs = [] } = {}) {
  const ssh = chooseTool('ssh', 'SSH_BIN', [...binDirs, ...SSH_DIRS]);
  const sshd = chooseTool('sshd', 'SSHD_BIN', [...binDirs, ...SSHD_DIRS]);
  const keygen = chooseTool('ssh-keygen', 'SSH_KEYGEN_BIN', [...binDirs, ...KEYGEN_DIRS]);

  // 每个二进制自检通过时用的环境可能不同（尤其 LD_LIBRARY_PATH）；合并成一份给子进程。
  const libs = unique(
    [ssh.env, sshd.env, keygen.env].flatMap((env) =>
      (env.LD_LIBRARY_PATH ?? '').split(':').filter((dir) => dir.length > 0),
    ),
  );
  const childEnv = { ...process.env };
  if (libs.length > 0) childEnv.LD_LIBRARY_PATH = libs.join(':');

  // 合并后的环境再自检一次，避免「单独能跑、组合环境互相覆盖」的少见情况。
  for (const [name, tool] of [
    ['ssh', ssh],
    ['sshd', sshd],
  ]) {
    const result = spawnSync(tool.bin, ['-V'], { env: childEnv, timeout: 5000, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 || !/OpenSSH/u.test(output)) {
      throw new SshToolsError(`找到 ${name}=${tool.bin}，但合并后的运行环境仍无法运行它`, [
        `exit ${result.status}: ${output.trim().slice(0, 200)}`,
      ]);
    }
  }

  return {
    sshBin: ssh.bin,
    sshdBin: sshd.bin,
    keygenBin: keygen.bin,
    binDirs: unique([dirname(ssh.bin), dirname(sshd.bin), dirname(keygen.bin)]),
    childEnv,
  };
}

function quotePath(path) {
  return `"${path.replaceAll('"', '\\"')}"`;
}

function sshConfigText({ alias, port, user, identityFile, knownHosts }) {
  return [
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${quotePath(identityFile)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${quotePath(knownHosts)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking no',
    '  BatchMode yes',
    '  PreferredAuthentications publickey',
    '  ConnectTimeout 10',
    '  ServerAliveInterval 5',
    '',
    'Host *',
    '  BatchMode yes',
    '  ConnectTimeout 10',
    '',
  ].join('\n');
}

function sshdConfigText({ port, hostKey, pidFile, authorizedKeys }) {
  return [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    'AddressFamily inet',
    `HostKey ${quotePath(hostKey)}`,
    `PidFile ${quotePath(pidFile)}`,
    `AuthorizedKeysFile ${quotePath(authorizedKeys)}`,
    // 非 root sshd 只登录当前用户；StrictModes no 让临时目录里的文件可用。
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitEmptyPasswords no',
    'PubkeyAuthentication yes',
    'PermitRootLogin no',
    'AllowTcpForwarding yes',
    'AllowAgentForwarding no',
    'X11Forwarding no',
    'PrintMotd no',
    'PrintLastLog no',
    'UseDNS no',
    'MaxStartups 10:30:60',
    'LogLevel VERBOSE',
    'SyslogFacility AUTH',
    '',
  ].join('\n');
}

function runKeygen(keygenBin, env, target, comment) {
  const result = spawnSync(
    keygenBin,
    ['-q', '-t', 'ed25519', '-N', '', '-f', target, '-C', comment],
    { env, timeout: 15000, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`ssh-keygen 生成 ${target} 失败（exit ${result.status}）：${detail}`);
  }
}

function killGroup(child, signal) {
  if (child === undefined || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已经退出 */
    }
  }
}

function waitChildExit(child, timeout) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    const timer = setTimeout(done, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * 启动一个真实 sshd。
 *
 * @param {{ binDirs?: string[], hostAlias?: string }} [options]
 * @returns {Promise<{
 *   port: number, sshBin: string, sshdBin: string, keygenBin: string,
 *   keyPath: string, knownHosts: string, sshConfigPath: string, workdir: string,
 *   hostAlias: string, user: string, homeDir: string, childEnv: Record<string,string>,
 *   sshdLog: () => string, stop: () => Promise<void>,
 * }>}
 */
export async function startSshd({ binDirs = [], hostAlias } = {}) {
  const tools = findSshTools({ binDirs });
  const user = userInfo().username;
  const alias = hostAlias ?? `dsh-it-${Math.random().toString(16).slice(2, 10)}`;
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-sshd-harness-'));
  const homeDir = join(workdir, 'home');
  const hostKey = join(workdir, 'ssh_host_ed25519_key');
  const clientKey = join(workdir, 'client_ed25519');
  const authorizedKeys = join(workdir, 'authorized_keys');
  const knownHosts = join(workdir, 'known_hosts');
  const sshdConfigPath = join(workdir, 'sshd_config');
  const sshConfigPath = join(workdir, 'ssh_config');
  const sshdPidFile = join(workdir, 'sshd.pid');

  let child;
  let log = '';
  let port;
  let stopPromise;

  const appendLog = (chunk) => {
    log += chunk.toString('utf8');
    if (log.length > 262144) log = log.slice(-131072);
  };
  const cleanupWorkdir = () => {
    if (process.env.DSH_TEST_KEEP_SSHD === '1') return;
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
  };
  const stopChild = async () => {
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child, 'SIGTERM');
    await waitChildExit(child, 5000);
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGKILL');
      await waitChildExit(child, 2000);
    }
  };

  const stop = () => {
    stopPromise ??= (async () => {
      await stopChild();
      await waitForPortClosed(port, { timeout: 5000, message: `sshd 端口 ${port} 没有释放` }).catch(
        () => {},
      );
      cleanupWorkdir();
    })();
    return stopPromise;
  };

  try {
    mkdirSync(join(homeDir, '.ssh'), { recursive: true, mode: 0o700 });
    runKeygen(tools.keygenBin, tools.childEnv, hostKey, 'dsh-sshd-harness-host');
    runKeygen(tools.keygenBin, tools.childEnv, clientKey, 'dsh-sshd-harness-client');
    copyFileSync(`${clientKey}.pub`, authorizedKeys);
    chmodSync(authorizedKeys, 0o600);
    writeFileSync(knownHosts, '');
    chmodSync(knownHosts, 0o600);

    // 端口探测与 sshd bind 之间存在极小竞争：遇到 bind 失败就换端口重试。
    let started = false;
    let lastError;
    for (let attempt = 1; attempt <= 3 && !started; attempt += 1) {
      port = await getFreePort();
      writeFileSync(
        sshdConfigPath,
        sshdConfigText({ port, hostKey, pidFile: sshdPidFile, authorizedKeys }),
      );
      writeFileSync(
        sshConfigPath,
        sshConfigText({ alias, port, user, identityFile: clientKey, knownHosts }),
      );

      log = '';
      child = spawn(tools.sshdBin, ['-D', '-e', '-f', sshdConfigPath], {
        env: tools.childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：stop() 可以整组结束（含每个连接 fork 出来的会话进程）。
        detached: true,
      });
      child.stdout.on('data', appendLog);
      child.stderr.on('data', appendLog);
      child.once('error', (error) => {
        appendLog(`sshd spawn error: ${error.message}\n`);
      });

      try {
        await waitFor(
          () => {
            if (child.exitCode !== null || child.signalCode !== null) {
              throw new Error(
                `sshd 提前退出（code=${child.exitCode} signal=${child.signalCode}）：${log.trim()}`,
              );
            }
            return canConnect(port);
          },
          { timeout: 15000, interval: 50, message: `sshd 没有在 127.0.0.1:${port} 上监听` },
        );
        started = true;
      } catch (error) {
        lastError = error;
        await stopChild();
        child = undefined;
        // 只有端口竞争才值得换端口重试，其它错误原样抛出。
        if (!/bind|address already in use/i.test(error.message)) throw error;
      }
    }
    if (!started) {
      throw lastError ?? new Error('sshd 多次尝试仍未能启动');
    }
  } catch (error) {
    await stopChild();
    cleanupWorkdir();
    throw error;
  }

  return {
    port,
    sshBin: tools.sshBin,
    sshdBin: tools.sshdBin,
    keygenBin: tools.keygenBin,
    keyPath: clientKey,
    knownHosts,
    sshConfigPath,
    workdir,
    hostAlias: alias,
    user,
    homeDir,
    binDirs: tools.binDirs,
    childEnv: tools.childEnv,
    sshdLog: () => log,
    stop,
  };
}

/** 读目录下所有 *.json（rendezvous）文件名，目录不存在时返回空数组。 */
export function listSessionFiles(dir) {
  try {
    return readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
}

/** 读第一份 rendezvous；没有时返回 undefined。 */
export function readFirstSession(dir) {
  for (const file of listSessionFiles(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      /* 可能正写到一半，继续等 */
    }
  }
  return undefined;
}
