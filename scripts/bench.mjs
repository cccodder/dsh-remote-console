#!/usr/bin/env node
/**
 * dsh-remote-console — SSH 通道开销基线（不依赖 DSH、不依赖插件）。
 *
 * 起一个 127.0.0.1 上的临时 sshd，用 ControlMaster socket 量四件事：
 *   1. 建立 master 的耗时（连接 + 认证 + socket 就绪）；
 *   2. exec 往返 p50/p95（`ssh -S <sock> <host> true`，与 remote_exec 同一条路径）；
 *   3. 1 MiB 上传吞吐（stdin → 远端 `cat > file`）；
 *   4. 1 MiB 下载吞吐（远端 `cat file` → stdout）。
 *
 * 只测 SSH 通道本身，不测 DSH 的 PTY、OSC 解析或工具调用开销。数字是 loopback
 * 基线：真实网络取决于 RTT、带宽、加密套件和远端负载，不能直接外推。
 *
 * 用法：
 *   node scripts/bench.mjs                 # 人类可读表格
 *   node scripts/bench.mjs --json          # 机器可读 JSON（stdout）
 *   node scripts/bench.mjs --runs 60       # exec 轮次（默认 40，最少 30）
 *   node scripts/bench.mjs --keep          # 保留临时目录（排错用）
 *   node scripts/bench.mjs --help
 *
 * 环境变量（本机 ssh/sshd 不在 PATH 时用，例如解压的便携版 OpenSSH）：
 *   SSH_BIN    ssh 可执行文件路径
 *   SSHD_BIN   sshd 可执行文件路径
 *   SSH_KEYGEN ssh-keygen 路径（默认取 ssh 同目录下的 ssh-keygen）
 * 如果二进制不在系统库路径下，脚本会按 <prefix>/usr/lib/<triplet> 与
 * <prefix>/lib/<triplet> 自动补 LD_LIBRARY_PATH；也可以自己导出。
 *
 * 前置：ssh 客户端 + sshd（服务端）。macOS 自带，Linux 装 openssh-server。
 * 找不到时脚本会打印各平台的准备命令并以退出码 2/3 结束。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { arch, cpus, hostname, platform, release, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const USAGE = `用法: node scripts/bench.mjs [--runs N] [--json] [--keep] [--help]

  --runs N   exec 往返的采样次数（默认 40，最少 30）
  --json     只往 stdout 打 JSON，便于存档/比较
  --keep     保留临时 sshd 目录（打印路径）
  --help     显示本帮助

环境变量: SSH_BIN / SSHD_BIN / SSH_KEYGEN（见文件头注释）。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const jsonOut = argv.includes('--json');
const keepDir = argv.includes('--keep');
const runsArg = argv.indexOf('--runs');
const REQUESTED_RUNS = runsArg >= 0 ? Number(argv[runsArg + 1]) : 40;
if (!Number.isFinite(REQUESTED_RUNS)) {
  console.error(`--runs 需要数字，收到: ${String(argv[runsArg + 1])}`);
  process.exit(2);
}
const RUNS = Math.max(30, Math.floor(REQUESTED_RUNS));
if (RUNS !== REQUESTED_RUNS && !jsonOut) console.error(`提示：exec 采样至少 30 次，按 30 次运行。`);
const MASTER_RUNS = 5;
const TRANSFER_BYTES = 1024 * 1024;
const TRANSFER_ROUNDS = 3;

/** 提示安装方式；返回 null 表示不继续。 */
function missing(kind, extra = '') {
  const lines = [];
  if (kind === 'ssh') {
    lines.push('找不到 ssh 客户端。本脚本需要一个能连 127.0.0.1 的 OpenSSH 客户端：');
    lines.push('  macOS:         系统自带（/usr/bin/ssh）');
    lines.push('  Debian/Ubuntu: sudo apt-get install -y openssh-client');
    lines.push('  Fedora/RHEL:   sudo dnf install -y openssh-clients');
    lines.push('  其他:          用 SSH_BIN=/path/to/ssh 指定');
  } else {
    lines.push('找不到 sshd（OpenSSH 服务端）。本脚本用 127.0.0.1 上的临时 sshd 跑 loopback 基线：');
    lines.push('  macOS:         系统自带（/usr/sbin/sshd），可直接运行本脚本');
    lines.push('  Debian/Ubuntu: sudo apt-get install -y openssh-server');
    lines.push('  Fedora/RHEL:   sudo dnf install -y openssh-server');
    lines.push('  其他:          用 SSHD_BIN=/path/to/sshd 指定');
    lines.push('');
    lines.push('没有服务端就量不了 loopback 基线。想量真实链路，请在远端机器上装 sshd，');
    lines.push('或直接看 README 里本机跑出来的参考数字（注明是 loopback）。');
  }
  if (extra !== '') lines.push(extra);
  console.error(lines.join('\n'));
  process.exit(kind === 'ssh' ? 2 : 3);
}

function isRunnable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  const result = spawnSync(name, ['-V'], { stdio: 'ignore' });
  return result.error === undefined;
}

/** 在 PATH 里查找绝对路径：sshd 自身要求「re-exec requires an absolute path」，裸名字会启动失败。 */
function pathLookup(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const full = join(dir, name);
    if (isRunnable(full)) return full;
  }
  return undefined;
}

function findBin(envName, candidates) {
  const explicit = process.env[envName];
  if (explicit !== undefined && explicit !== '') {
    if (!isRunnable(explicit)) missing(candidates.kind, `${envName}=${explicit} 不可执行。`);
    return resolve(explicit);
  }
  for (const candidate of candidates.paths) {
    if (candidate.includes('/')) {
      if (isRunnable(candidate)) return candidate;
    } else {
      const found = pathLookup(candidate);
      if (found !== undefined) return found;
    }
  }
  missing(candidates.kind);
}

/** 便携版 OpenSSH 的共享库目录（容器/CI 里解压 .deb 的情形）。 */
function libDirsFor(bin) {
  if (!bin.includes('/')) return [];
  const dir = dirname(resolve(bin));
  if (basename(dir) !== 'bin' && basename(dir) !== 'sbin') return [];
  const root = dirname(dirname(dir)); // /opt/openssh/usr/bin/ssh -> /opt/openssh
  const triplet = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu`;
  return [
    join(root, 'usr/lib', triplet),
    join(root, 'lib', triplet),
    join(root, 'usr/lib64'),
    join(root, 'lib64'),
  ].filter(existsSync);
}

function childEnv(...bins) {
  const dirs = [...new Set(bins.flatMap((bin) => libDirsFor(bin)))];
  if (dirs.length === 0) return { ...process.env };
  const existing = process.env.LD_LIBRARY_PATH;
  return {
    ...process.env,
    LD_LIBRARY_PATH: existing === undefined ? dirs.join(':') : `${dirs.join(':')}:${existing}`,
  };
}

function sshVersionText(sshBin, env) {
  const result = spawnSync(sshBin, ['-V'], { encoding: 'utf8', env });
  return String(`${result.stderr ?? ''}${result.stdout ?? ''}`).trim().split('\n')[0] ?? 'unknown';
}

function keygenFor(sshBin) {
  const explicit = process.env.SSH_KEYGEN;
  if (explicit !== undefined && explicit !== '') {
    if (!isRunnable(explicit)) missing('ssh', `SSH_KEYGEN=${explicit} 不可执行。`);
    return resolve(explicit);
  }
  const siblings = [`${dirname(resolve(sshBin))}/ssh-keygen`, '/usr/bin/ssh-keygen', '/usr/local/bin/ssh-keygen'];
  for (const candidate of siblings) if (isRunnable(candidate)) return candidate;
  if (onPath('ssh-keygen')) return 'ssh-keygen';
  missing('ssh', '找不到 ssh-keygen（通常和 ssh 一起安装）。可用 SSH_KEYGEN=/path/to/ssh-keygen 指定。');
}

function run(cmd, args, { env, timeoutMs = 20000, input } = {}) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      done({ code: null, timedOut: true, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), stdoutBuf: Buffer.concat(out), stderrBuf: Buffer.concat(err), ms: performance.now() - started });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code: null, error, stdout: '', stderr: String(error.message), stdoutBuf: Buffer.alloc(0), stderrBuf: Buffer.alloc(0), ms: performance.now() - started });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      const stderrBuf = Buffer.concat(err);
      done({ code, timedOut: false, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString(), stdoutBuf, stderrBuf, ms: performance.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((done) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (performance.now() > deadline) done(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 50);
}

function fmtMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

function throughput(bytes, ms) {
  return bytes / 1024 / 1024 / (ms / 1000);
}

function note(text) {
  if (!jsonOut) console.log(text);
}

async function main() {
  const sshBin = findBin('SSH_BIN', { kind: 'ssh', paths: ['ssh', '/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'] });
  const sshdBin = findBin('SSHD_BIN', { kind: 'sshd', paths: ['sshd', '/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'] });
  const keygenBin = keygenFor(sshBin);
  const env = childEnv(sshBin, sshdBin);
  const sshVersion = sshVersionText(sshBin, env);

  const baseTmp = existsSync('/tmp') ? '/tmp' : tmpdir();
  const workdir = mkdtempSync(join(baseTmp, 'dsh-rc-bench-'));
  const hostKey = join(workdir, 'host_ed25519');
  const clientKey = join(workdir, 'client_ed25519');
  const authorizedKeys = join(workdir, 'authorized_keys');
  const knownHosts = join(workdir, 'known_hosts');
  const sshdConfig = join(workdir, 'sshd_config');
  const socketPath = join(workdir, 'ctl.sock');
  const remoteFile = `/tmp/dsh-rc-bench-${process.pid}-${randomInt(1_000_000)}.bin`;
  // 用真实 uid 对应的用户名：USER/LOGNAME 在容器里可能未设置，"root" 会让非 root
  // sshd 认证成功却无法建立会话（临时 authorized_keys + StrictModes no 对任何账号都成立）。
  const user = process.env.SSH_USER ?? userInfo().username;
  const target = `${user}@127.0.0.1`;
  let sshd = null;
  let sshdLog = '';
  let port = 0;
  let masterOpen = false;

  const sshBase = (p) => [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PubkeyAuthentication=yes',
    '-o', 'IdentitiesOnly=yes',
    '-i', clientKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '-p', String(p),
  ];

  const sshCtl = (p, ...rest) => [sshBin, [...sshBase(p), ...rest]];

  const ssh = (p, args, options = {}) => {
    const [bin, argv] = sshCtl(p, ...args);
    return run(bin, argv, { env, ...options });
  };

  try {
    note(`准备临时 sshd …`);
    // 很老的 OpenSSH（< 6.5）没有 ed25519；失败且用户没指定类型时退回 rsa 3072。
    let keyType = process.env.BENCH_KEY_TYPE ?? 'ed25519';
    const makeKey = (path) =>
      run(keygenBin, ['-q', '-t', keyType, '-N', '', '-f', path, '-C', 'dsh-rc-bench'], { env, timeoutMs: 15000 });
    let hostGenerated = await makeKey(hostKey);
    if (hostGenerated.code !== 0 && process.env.BENCH_KEY_TYPE === undefined) {
      keyType = 'rsa';
      hostGenerated = await makeKey(hostKey);
    }
    if (hostGenerated.code !== 0) throw new Error(`ssh-keygen 生成 host key 失败: ${hostGenerated.stderr}`);
    const clientGenerated = await makeKey(clientKey);
    if (clientGenerated.code !== 0) throw new Error(`ssh-keygen 生成 client key 失败: ${clientGenerated.stderr}`);
    chmodSync(hostKey, 0o600);
    chmodSync(clientKey, 0o600);
    writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`));
    chmodSync(authorizedKeys, 0o600);

    // sshd 以当前用户运行（非 root 也可以）：host key、authorized_keys 都放临时目录，
    // 因此 StrictModes 必须关掉；UsePAM no + 只许公钥认证保证启动不依赖系统账号配置。
    const listenPort = await freePort();
    writeFileSync(
      sshdConfig,
      [
        `Port ${listenPort}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'UsePAM no',
        'StrictModes no',
        'AllowUsers ' + user,
        `PidFile ${join(workdir, 'sshd.pid')}`,
        'LogLevel DEBUG1',
        '',
      ].join('\n'),
    );

    sshd = spawn(sshdBin, ['-f', sshdConfig, '-D', '-e'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    sshd.stdout.on('data', (chunk) => { sshdLog += chunk.toString(); });
    sshd.stderr.on('data', (chunk) => { sshdLog += chunk.toString(); });
    port = listenPort;

    if (!(await waitForPort(port, 5000))) {
      throw new Error(`sshd 没有在 127.0.0.1:${port} 上监听。sshd 输出：\n${sshdLog.split('\n').slice(-12).join('\n')}`);
    }

    // 第一次连接会写 known_hosts，同时确认 key 认证可用。
    const warm = await ssh(port, [target, 'true'], { timeoutMs: 10000 });
    if (warm.code !== 0) {
      throw new Error(`ssh 登录临时 sshd 失败（退出码 ${String(warm.code)}）。sshd 输出：\n${sshdLog.split('\n').slice(-12).join('\n')}`);
    }
    note(`sshd 就绪：127.0.0.1:${port}（用户 ${user}，公钥认证）`);

    // 1) master 建立耗时：每次新建 socket，从启动 ssh 到 -fN 返回。
    const masterTimings = [];
    for (let i = 0; i < MASTER_RUNS; i += 1) {
      rmSync(socketPath, { force: true });
      const started = performance.now();
      const master = await ssh(port, ['-M', '-S', socketPath, '-o', 'ControlPersist=60', '-fN', target], { timeoutMs: 15000 });
      const elapsed = performance.now() - started;
      if (master.code !== 0) throw new Error(`第 ${i + 1} 次建立 master 失败（退出码 ${String(master.code)}）：${master.stderr}`);
      masterTimings.push(elapsed);
      masterOpen = true;
      const closed = await ssh(port, ['-S', socketPath, '-O', 'exit', target], { timeoutMs: 5000 });
      if (closed.code !== 0) throw new Error(`关闭 master 失败：${closed.stderr}`);
      masterOpen = false;
      await sleep(30);
    }
    note(`master 建立完成：${masterTimings.map((ms) => ms.toFixed(1)).join(', ')} ms`);

    // 之后所有测量复用同一个 master。
    rmSync(socketPath, { force: true });
    const master = await ssh(port, ['-M', '-S', socketPath, '-o', 'ControlPersist=300', '-fN', target], { timeoutMs: 15000 });
    if (master.code !== 0) throw new Error(`建立常驻 master 失败：${master.stderr}`);
    masterOpen = true;

    const execOnce = async () => {
      const r = await ssh(port, ['-S', socketPath, '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', target, 'true'], { timeoutMs: 10000 });
      if (r.code !== 0) throw new Error(`exec 往返失败（退出码 ${String(r.code)}）：${r.stderr}`);
      return r.ms;
    };
    await execOnce(); // 预热：把 ssh 二进制的页缓存和 DNS 之类的首用成本排除掉
    const execTimings = [];
    for (let i = 0; i < RUNS; i += 1) execTimings.push(await execOnce());
    const execSorted = [...execTimings].sort((a, b) => a - b);
    note(`exec 往返 ${RUNS} 次完成`);

    const payload = randomBytes(TRANSFER_BYTES);
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');
    const uploadTimings = [];
    const downloadTimings = [];
    let uploadBytes = 0;
    let downloadBytes = 0;
    for (let i = 0; i < TRANSFER_ROUNDS; i += 1) {
      const upload = await run(
        sshBin,
        [...sshBase(port), '-S', socketPath, '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', target, `cat > ${remoteFile}`],
        { env, timeoutMs: 30000, input: payload },
      );
      if (upload.code !== 0) throw new Error(`上传失败（退出码 ${String(upload.code)}）：${upload.stderr}`);
      uploadTimings.push(upload.ms);

      const download = await run(
        sshBin,
        [...sshBase(port), '-S', socketPath, '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', target, `cat ${remoteFile}`],
        { env, timeoutMs: 30000 },
      );
      if (download.code !== 0) throw new Error(`下载失败（退出码 ${String(download.code)}）：${download.stderr}`);
      downloadTimings.push(download.ms);
      downloadBytes = download.stdoutBuf.length;
      if (downloadBytes !== TRANSFER_BYTES) throw new Error(`下载字节数不对：期望 ${TRANSFER_BYTES}，收到 ${downloadBytes}`);
      const gotSha256 = createHash('sha256').update(download.stdoutBuf).digest('hex');
      if (gotSha256 !== payloadSha256) throw new Error('下载内容 sha256 与上传内容不一致');
      uploadBytes = payload.length;
    }

    const sizeCheck = await ssh(port, ['-S', socketPath, '-o', 'ControlMaster=no', target, `wc -c < ${remoteFile}`], { timeoutMs: 10000 });
    if (sizeCheck.code !== 0 || Number(sizeCheck.stdout.trim()) !== TRANSFER_BYTES) {
      throw new Error(`远端文件大小校验失败：${sizeCheck.stdout || sizeCheck.stderr}`);
    }

    const result = {
      generatedAt: new Date().toISOString(),
      kind: 'ssh-channel-loopback-baseline',
      note: 'loopback baseline: real networks depend on RTT, bandwidth and remote load',
      target: `127.0.0.1:${port}`,
      user,
      client: sshVersion,
      platform: `${platform()} ${arch()} ${release()}`,
      hostname: hostname(),
      cpu: cpus()[0]?.model?.trim() ?? 'unknown',
      node: process.version,
      config: {
        execRuns: RUNS,
        masterRuns: MASTER_RUNS,
        transferBytes: TRANSFER_BYTES,
        transferRounds: TRANSFER_ROUNDS,
        cipher: 'default (negotiated, not pinned)',
      },
      masterEstablish: {
        runsMs: masterTimings,
        medianMs: median(masterTimings),
        minMs: Math.min(...masterTimings),
        maxMs: Math.max(...masterTimings),
      },
      execRoundTrip: {
        p50Ms: percentile(execSorted, 50),
        p95Ms: percentile(execSorted, 95),
        minMs: execSorted[0],
        maxMs: execSorted[execSorted.length - 1],
        meanMs: execTimings.reduce((a, b) => a + b, 0) / execTimings.length,
      },
      upload: {
        bytes: uploadBytes,
        runsMs: uploadTimings,
        medianMs: median(uploadTimings),
        medianMiBPerSec: throughput(uploadBytes, median(uploadTimings)),
        minMiBPerSec: throughput(uploadBytes, Math.max(...uploadTimings)),
        maxMiBPerSec: throughput(uploadBytes, Math.min(...uploadTimings)),
      },
      download: {
        bytes: downloadBytes,
        runsMs: downloadTimings,
        medianMs: median(downloadTimings),
        medianMiBPerSec: throughput(downloadBytes, median(downloadTimings)),
        minMiBPerSec: throughput(downloadBytes, Math.max(...downloadTimings)),
        maxMiBPerSec: throughput(downloadBytes, Math.min(...downloadTimings)),
      },
    };

    if (jsonOut) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log('');
      console.log('dsh-remote-console — SSH 通道基线（loopback）');
      console.log('='.repeat(58));
      console.log(`target   127.0.0.1:${port}（临时 sshd，公钥认证，不经过 DSH）`);
      console.log(`client   ${sshVersion}`);
      console.log(`platform ${result.platform}`);
      console.log(`cpu      ${result.cpu} (${cpus().length} vCPU)`);
      console.log(`node     ${result.node}`);
      console.log(`samples  master ${MASTER_RUNS} 次，exec ${RUNS} 次，传输 ${TRANSFER_ROUNDS} 轮 × ${TRANSFER_BYTES / 1024 / 1024} MiB`);
      console.log('');
      console.log('指标                             结果');
      console.log('-'.repeat(58));
      console.log(`建立 master（中位数）            ${fmtMs(result.masterEstablish.medianMs)}  [${masterTimings.map((ms) => ms.toFixed(1)).join(', ')}]`);
      console.log(`exec 往返 p50                    ${fmtMs(result.execRoundTrip.p50Ms)}`);
      console.log(`exec 往返 p95                    ${fmtMs(result.execRoundTrip.p95Ms)}`);
      console.log(`exec 往返 min / max              ${fmtMs(result.execRoundTrip.minMs)} / ${fmtMs(result.execRoundTrip.maxMs)}`);
      console.log(`1 MiB 上传（中位数）             ${result.upload.medianMiBPerSec.toFixed(0)} MiB/s  (${fmtMs(result.upload.medianMs)})`);
      console.log(`1 MiB 下载（中位数）             ${result.download.medianMiBPerSec.toFixed(0)} MiB/s  (${fmtMs(result.download.medianMs)})`);
      console.log('');
      console.log('说明：loopback 基线，同一台机器、无真实网络 RTT；');
      console.log('      真实网络取决于 RTT、带宽、加密套件和远端负载，不能直接外推。');
      console.log(`      原始样本在上面的 JSON（--json）。`);
    }
  } finally {
    if (masterOpen) {
      await ssh(port, ['-S', socketPath, '-O', 'exit', target], { timeoutMs: 5000 }).catch(() => {});
    }
    if (port !== 0) {
      await ssh(port, ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', target, `rm -f ${remoteFile}`], { timeoutMs: 5000 }).catch(() => {});
    }
    if (sshd !== null) {
      sshd.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => sshd.once('close', done)),
        sleep(2000),
      ]);
      if (sshd.exitCode === null) sshd.kill('SIGKILL');
    }
    if (keepDir) console.error(`保留临时目录: ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`bench 失败: ${String(error?.stack ?? error)}`);
  process.exit(4);
});
