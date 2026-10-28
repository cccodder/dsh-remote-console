/**
 * 真实 sshd 集成测试：不再用假 shell，而是启动一个真的 openssh sshd，
 * 让 bin/dsh-ssh 真正登录一次，然后沿着同一个 ControlMaster socket 验证
 * 复用、二进制流上下行、端口转发和退出码透传。
 *
 * 机器上没有可用的 ssh/sshd（或指定了坏掉的 SSHD_BIN/SSH_BIN）时整组 skip；
 * CI 的 ubuntu-latest 与本地解压的便携版 OpenSSH 都能跑。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  canConnect,
  findSshTools,
  getFreePort,
  isSshToolsError,
  listSessionFiles,
  readFirstSession,
  startSshd,
  waitFor,
  waitForPortClosed,
} from './sshd-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(here, '..', 'bin', 'dsh-ssh');
const MAX_BUFFER = 64 * 1024 * 1024;

let skipReason = '';
try {
  findSshTools();
} catch (error) {
  if (!isSshToolsError(error)) throw error;
  skipReason = error.message;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function shellSingleQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * 等 promise 完成，超时则失败；超时定时器在结束时清掉，
 * 避免测试跑完后事件循环被未触发的 timer 挂住。
 */
async function waitForExit(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 起一个 127.0.0.1 上的 TCP echo server（端口转发测试的目标）。 */
async function startEchoServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  server.listen({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 经本地转发端口发一段数据，必须原样收到。 */
function echoRoundTrip(port, payload, timeout = 5000) {
  return new Promise((done, fail) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`端口转发 echo 超时（${timeout}ms）`));
    }, timeout);
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
      if (received === payload) {
        clearTimeout(timer);
        socket.end();
        done(received);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    socket.once('connect', () => socket.write(payload));
  });
}

/**
 * 以 --host 启动包装器。
 *
 * 包装器按 DSH_SSH_CONFIG 把 -F 传给 ssh（与插件主机侧 exec/传输通道读同一个变量），
 * 所以临时 config 里生成的 host 别名、身份文件和 known_hosts 会生效，测试不读写真实用户的
 * ~/.ssh/config，也不需要系统 /etc/ssh 配置。
 */
function startWrapper(h) {
  const dshHome = join(h.workdir, 'dsh-home');
  const rcDir = join(dshHome, 'remote-console');
  mkdirSync(join(h.homeDir, '.ssh'), { recursive: true, mode: 0o700 });

  const env = {
    ...h.childEnv,
    HOME: h.homeDir,
    PATH: [...h.binDirs, process.env.PATH ?? ''].filter((dir) => dir.length > 0).join(':'),
    DSH_HOME: dshHome,
    DSH_SSH_CONFIG: h.sshConfigPath,
    DSH_RC_DRYRUN: '0',
    TERM: 'dumb',
  };
  const child = spawn(wrapperPath, ['--host', h.hostAlias], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stdin 是远端交互 shell 的输入：保持打开（不 end），ssh master 才会一直活着。
  child.stdin.on('error', () => {});

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 262144) stdout = stdout.slice(-131072);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 262144) stderr = stderr.slice(-131072);
  });
  child.on('error', (error) => {
    stderr += `spawn error: ${error.message}\n`;
  });
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
  // stdout/stderr 是管道：'exit' 之后数据可能还没读完，等 'close' 再断言退出提示。
  const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));

  return {
    child,
    exited,
    closed,
    rcDir,
    sessionsDir: join(rcDir, 'sessions'),
    socksDir: join(rcDir, 'socks'),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const state = {};

describe('真实 sshd 集成（包装器登录 + ControlMaster 复用）', { skip: skipReason || false }, () => {
  function countAcceptedPublickey() {
    return (state.h.sshdLog().match(/Accepted publickey/gu) ?? []).length;
  }

  function runSsh(extraArgs, options = {}) {
    return spawnSync(
      state.h.sshBin,
      ['-F', state.h.sshConfigPath, '-S', state.sock, ...extraArgs],
      {
        env: state.h.childEnv,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: MAX_BUFFER,
        ...options,
      },
    );
  }

  /** 幂等兜底清理：任何测试失败也不留包装器 / ssh master / sshd 进程与端口。 */
  async function cleanup() {
    const { h, wrapper, hostAlias } = state;
    try {
      if (wrapper !== undefined && wrapper.child.exitCode === null) {
        wrapper.child.kill('SIGTERM');
        await waitForExit(wrapper.exited, 2000, '包装器没有响应 SIGTERM').catch(() => {});
        if (wrapper.child.exitCode === null) {
          wrapper.child.kill('SIGKILL');
          await waitForExit(wrapper.exited, 1000, '包装器没有响应 SIGKILL').catch(() => {});
        }
      }
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    try {
      if (h !== undefined && state.sock !== undefined && existsSync(state.sock)) {
        runSsh(['-O', 'exit', hostAlias], { timeout: 5000 });
      }
    } catch {
      /* ignore */
    }
    if (h !== undefined) await h.stop();
  }

  before(async () => {
    const h = await startSshd();
    state.h = h;
    try {
      const wrapper = startWrapper(h);
      state.wrapper = wrapper;
      state.rcDir = wrapper.rcDir;
      state.sessionsDir = wrapper.sessionsDir;
      state.socksDir = wrapper.socksDir;

      const failIfWrapperExited = () => {
        if (wrapper.child.exitCode !== null) {
          throw new Error(
            `包装器提前退出（exit ${wrapper.child.exitCode}）\nstdout:${wrapper.stdout()}\nstderr:${wrapper.stderr()}`,
          );
        }
      };

      await waitFor(
        () => {
          failIfWrapperExited();
          return readFirstSession(wrapper.sessionsDir);
        },
        { timeout: 20000, message: '包装器没有写出 sessions/*.json' },
      );
      const session = readFirstSession(wrapper.sessionsDir);
      state.session = session;
      state.sock = session.socket;

      await waitFor(
        () => {
          failIfWrapperExited();
          return existsSync(session.socket);
        },
        { timeout: 25000, message: 'ControlMaster socket 没有出现（登录未成功？）' },
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  after(async () => {
    await cleanup();
  });

  it('包装器登录后写出 rendezvous，并建立 ControlMaster socket', async () => {
    const { h, wrapper, session, sock } = state;
    const expectedSocket = join(state.socksDir, `${h.hostAlias}.${wrapper.child.pid}.sock`);

    assert.ok(wrapper.stdout().includes('>> ssh'), `包装器没有打印 ssh 命令行：${wrapper.stdout()}`);
    assert.ok(wrapper.stdout().includes(h.hostAlias), '包装器没有打印主机别名');
    assert.match(wrapper.stdout(), /\]1337;DSH-RC;CONNECT /u, '没有发出 CONNECT OSC 事件');

    assert.equal(session.host, h.hostAlias, 'rendezvous 里的 host 应为主机别名');
    assert.equal(String(session.pid), String(wrapper.child.pid), 'rendezvous 里的 pid 应为包装器进程');
    assert.equal(session.user, '', '--host 没有 hosts.tsv 记录时 user 应为空（由 ssh 配置提供）');
    assert.equal(session.port, '', '--host 模式端口由 ssh 配置提供，rendezvous 里应为空');
    assert.equal(session.socket, expectedSocket, 'socket 应为 socks/<host>.<pid>.sock');
    assert.ok(existsSync(sock), `socket 文件不存在：${sock}`);
    assert.ok(statSync(sock).isSocket(), `${sock} 不是 unix socket`);

    // DSH_SSH_CONFIG 显式指定时包装器应直接把 -F <临时配置> 传给 ssh，不走真实 ~/.ssh/config。
    const wrapperLog = readFileSync(join(state.rcDir, 'wrapper.log'), 'utf8');
    assert.match(wrapperLog, /ssh config override: why=env-override/u, `诊断日志不对：${wrapperLog}`);
    assert.ok(wrapperLog.includes(`-F ${h.sshConfigPath}`), `包装器没用临时配置：${wrapperLog}`);

    // sshd 的 VERBOSE 日志会记录每次真实认证；拿不到该行时后续测试降级为不计数。
    try {
      await waitFor(() => countAcceptedPublickey() >= 1, {
        timeout: 3000,
        message: 'sshd 没有记录 Accepted publickey',
      });
      state.authLogSeen = true;
    } catch {
      state.authLogSeen = false;
    }
  });

  it('ssh -S 复用已有 master，不重新认证', () => {
    const { h } = state;

    const check = runSsh(['-O', 'check', h.hostAlias]);
    const checkOutput = `${check.stdout ?? ''}${check.stderr ?? ''}`;
    assert.equal(check.status, 0, `-O check 失败：${checkOutput}`);
    assert.match(checkOutput, /Master running \(pid=\d+\)/u, `-O check 输出不对：${checkOutput}`);

    const acceptedBefore = countAcceptedPublickey();
    const reuse = runSsh([
      // 与插件 remote_exec 一样：不新开 master，只复用 -S 指定的 socket。
      '-o', 'ControlMaster=no',
      '-o', 'BatchMode=yes',
      '-o', 'PreferredAuthentications=none',
      '-o', 'NumberOfPasswordPrompts=0',
      '--', h.hostAlias, 'echo reuse-ok',
    ]);
    assert.equal(reuse.status, 0, `复用命令失败：${reuse.stderr}`);
    assert.equal((reuse.stdout ?? '').trim(), 'reuse-ok');

    // -S <sock> 只在 master 存活时可用；PreferredAuthentications=none 又堵死新认证，
    // 命令能成功本身就证明走的是已有 master。日志行数则再确认没有第二次登录。
    if (state.authLogSeen) {
      assert.equal(acceptedBefore, 1, `master 建立时应有且只有 1 次认证：${h.sshdLog()}`);
      assert.equal(countAcceptedPublickey(), acceptedBefore, '复用 master 不应新增认证');
    }
  });

  it('1MB 随机文件经 master 上下行，sha256 一致', () => {
    const { h } = state;
    const local = randomBytes(1024 * 1024);
    const localDigest = sha256(local);
    mkdirSync(join(h.workdir, 'remote'), { recursive: true });
    const remotePath = join(h.workdir, 'remote', 'upload.bin');

    const upload = spawnSync(
      h.sshBin,
      [
        '-F', h.sshConfigPath, '-S', state.sock, '-o', 'BatchMode=yes',
        '--', h.hostAlias, `cat > ${shellSingleQuote(remotePath)}`,
      ],
      { env: h.childEnv, input: local, timeout: 60000, maxBuffer: MAX_BUFFER },
    );
    assert.equal(upload.status, 0, `上传失败：${String(upload.stderr)}`);
    assert.ok(existsSync(remotePath), '远端文件没有写出来');
    assert.equal(statSync(remotePath).size, local.length, '上传后远端文件大小不一致');
    assert.equal(sha256(readFileSync(remotePath)), localDigest, '上传后远端文件 sha256 不一致');

    const download = spawnSync(
      h.sshBin,
      [
        '-F', h.sshConfigPath, '-S', state.sock, '-o', 'BatchMode=yes',
        '--', h.hostAlias, `cat ${shellSingleQuote(remotePath)}`,
      ],
      { env: h.childEnv, timeout: 60000, maxBuffer: MAX_BUFFER },
    );
    assert.equal(download.status, 0, `下载失败：${String(download.stderr)}`);
    assert.equal(download.stdout.length, local.length, '下载字节数不一致');
    assert.equal(sha256(download.stdout), localDigest, '下载内容 sha256 与本地文件不一致');
    assert.ok(download.stdout.equals(local), '下载内容与原始随机字节不一致');
  });

  it('ssh -N -L 端口转发能连通并原样收发', async () => {
    const { h } = state;
    const echo = await startEchoServer();
    const localPort = await getFreePort();
    const spec = `127.0.0.1:${localPort}:127.0.0.1:${echo.port}`;
    let forward;
    let forwardExit;
    let forwardStderr = '';
    try {
      forward = spawn(
        h.sshBin,
        [
          '-v', '-v', '-v', '-F', h.sshConfigPath, '-S', state.sock, '-N',
          '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
          '-L', spec,
          h.hostAlias,
        ],
        { env: h.childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      forward.stderr.on('data', (chunk) => {
        forwardStderr += chunk;
      });
      forwardExit = new Promise((done) =>
        forward.once('exit', (code, signal) => done({ code, signal })),
      );

      // 复用 master 时监听端口由 master 进程持有，客户端本身怎么退都不重要：
      //   - OpenSSH 9.2：-N 客户端装上转发后以 0 退出；
      //   - OpenSSH 9.6：同样场景客户端可能以 1 退出（转发仍然有效，CI 实测）。
      // 所以唯一可信的成功判据是「本地端口能连上」，退出码只用于失败诊断。
      // 插件的 startForward 也是先看端口、再看退出码，行为与这里一致。
      try {
        await waitFor(() => canConnect(localPort), {
          timeout: 15000,
          interval: 100,
          message: `本地转发端口 ${localPort} 没有就绪`,
        });
      } catch (error) {
        const detail = forwardStderr.trim().split('\n').slice(-40).join('\n');
        const sshdLog = String(h.sshdLog?.() ?? '').trim().split('\n').slice(-20).join('\n');
        const masterErr = String(state.wrapper?.stderr?.() ?? '').trim().split('\n').slice(-30).join('\n');
        throw new Error(
          `${error.message}（ssh exit=${String(forward.exitCode)}）\n--- ssh stderr ---\n${detail}\n--- master (wrapper) stderr ---\n${masterErr}\n--- sshd log ---\n${sshdLog}`,
        );
      }

      const payload = 'dsh-forward-echo';
      assert.equal(await echoRoundTrip(localPort, payload), payload, '转发链路上的 echo 内容不一致');

      const cancel = runSsh(['-O', 'cancel', '-L', spec, h.hostAlias]);
      if (cancel.status !== 0) {
        // 某些版本/场景下监听端口由 -N 客户端自己持有：杀掉客户端即可释放。
        forward.kill('SIGTERM');
        await waitForExit(forwardExit, 5000, '转发 ssh 没有在取消后退出').catch(() => {});
      }
      await waitForPortClosed(localPort, { timeout: 5000, message: '取消转发后本地端口没有释放' });
      const check = runSsh(['-O', 'check', h.hostAlias]);
      assert.equal(check.status, 0, `取消转发后 master 不应退出：${check.stderr}`);
    } finally {
      if (forward !== undefined && forward.exitCode === null && forward.signalCode === null) {
        forward.kill('SIGKILL');
        if (forwardExit !== undefined) {
          await waitForExit(forwardExit, 1000, '转发 ssh 没有响应 SIGKILL').catch(() => {});
        }
      }
      try {
        if (state.sock !== undefined && existsSync(state.sock)) {
          runSsh(['-O', 'cancel', '-L', spec, h.hostAlias], { timeout: 5000 });
        }
      } catch {
        /* 兜底取消失败不影响断言 */
      }
      await echo.close();
    }
  });

  it('远端命令退出码原样透传（false→1，exit 7→7）', () => {
    const { h } = state;
    const failed = runSsh(['--', h.hostAlias, 'false']);
    assert.equal(failed.status, 1, `false 应透传退出码 1：${failed.stderr}`);

    const exited = runSsh(['--', h.hostAlias, 'exit 7']);
    assert.equal(exited.status, 7, `exit 7 应透传退出码 7：${exited.stderr}`);
  });

  it('退出后清理 socket/rendezvous，停掉 sshd 后不残留端口和临时目录', async () => {
    const { h, wrapper, hostAlias } = state;

    const exitRequest = runSsh(['-O', 'exit', hostAlias]);
    assert.equal(exitRequest.status, 0, `-O exit 失败：${exitRequest.stderr}`);

    await waitForExit(wrapper.exited, 15000, 'master 退出后包装器没有结束');
    await wrapper.closed;
    assert.ok(wrapper.child.exitCode !== null, '包装器进程应正常退出');
    assert.match(wrapper.stdout(), /ssh 已退出/u, `包装器没有打印退出提示：${wrapper.stdout()}`);

    await waitFor(() => !existsSync(state.sock), { timeout: 10000, message: 'socket 文件没有清理' });
    await waitFor(() => listSessionFiles(state.sessionsDir).length === 0, {
      timeout: 10000,
      message: 'rendezvous 文件没有清理',
    });
    assert.deepEqual(readdirSync(state.socksDir), [], 'socks 目录仍有残留');

    await h.stop();
    await waitForPortClosed(h.port, { timeout: 10000, message: 'sshd 停止后端口仍可连接' });
    if (process.env.DSH_TEST_KEEP_SSHD !== '1') {
      assert.equal(existsSync(h.workdir), false, '临时目录没有清理');
    }
  });
});
