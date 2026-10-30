/**
 * Windows 通道：Node 包装器（可在 Linux 上测）+ 无 ControlMaster 时的 PTY 回退选择。
 * 真实 PTY 上的分块读写见 pty-transport.test.mjs。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const wrapperMjs = join(here, '..', 'bin', 'dsh-ssh.mjs');
const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-win-'));
const sshConfig = join(rcDir, 'ssh_config');
writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\n');

process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_SSH_CONFIG = sshConfig;
process.env.DSH_RC_NO_CLEAR = '1';

const plugin = await import('../lib/index.js');
const { apply, __testing } = plugin;
const { state, transportOf, ensureDirs } = __testing;

/** 假 ssh：探测失败让配置前缀走 -F，连接直接按给定退出码退出。 */
function makeStubPath(exitCode = 0) {
  const stubDir = join(rcDir, 'stubs');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'ssh'), `#!/bin/sh\ncase "$1" in\n  -G) echo bad >&2; exit 1 ;;\nesac\nexit ${exitCode}\n`, { mode: 0o755 });
  return `${stubDir}:${process.env.PATH}`;
}

function runWrapper(args, input, { dryRun = true, exitCode = 0 } = {}) {
  const result = spawnSync(process.execPath, [wrapperMjs, ...args], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: makeStubPath(exitCode),
      DSH_REMOTE_CONSOLE_DIR: rcDir,
      DSH_SSH_CONFIG: sshConfig,
      DSH_RC_DRYRUN: dryRun ? '1' : '0',
    },
  });
  return result;
}

describe('Node 包装器（Windows 用）', () => {
  it('--target 解析 user@host:port，走 dry-run，且不传 ControlMaster 参数', () => {
    const { status, stdout } = runWrapper(['--target', 'deploy@10.9.9.9:2220'], '');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /-- deploy@10\.9\.9\.9/u);
    assert.match(stdout, /-p 2220/u);
    assert.match(stdout, /10\.9\.9\.9/u);
    assert.ok(!stdout.includes('-M '), '不能传 -M');
    assert.ok(!stdout.includes('-S '), '不能传 -S');
    assert.match(stdout, /-t --/u);
  });

  it('--host 走 ssh 配置里的别名', () => {
    const { status, stdout } = runWrapper(['--host', 'alpha'], '');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /-- alpha/u);
    assert.ok(!stdout.includes('DSH 远程控制终端（Windows 版）'));
  });

  it('菜单列出主机，选项号直连', () => {
    const { status, stdout } = runWrapper([], '1\n');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /DSH 远程控制终端（Windows 版）/u);
    assert.match(stdout, /alpha/u);
    assert.match(stdout, /beta/u);
    assert.match(stdout, />> ssh/u);
  });

  it('n 新建主机写入 hosts.tsv', () => {
    const { status, stdout } = runWrapper([], 'n\n10.8.8.8\ndeploy\n2200\n');
    assert.equal(status, 0, stdout);
    const hosts = readFileSync(join(rcDir, 'hosts.tsv'), 'utf8');
    assert.match(hosts, /^10\.8\.8\.8\tdeploy\t2200$/mu);
  });

  it('--rc-dir 覆盖环境变量：环境里没有 DSH_HOME 也写到指定目录', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-rc-win-rcflag-'));
    const sshConfig2 = join(target, 'ssh_config');
    writeFileSync(sshConfig2, 'Host alpha\n  HostName 10.0.0.1\n');
    const stub = join(target, 'ssh');
    writeFileSync(stub, '#!/bin/sh\ncase "$1" in -G) exit 1;; esac\nsleep 3\nexit 0\n', { mode: 0o755 });
    const env = {
      PATH: `${target}:${process.env.PATH}`,
      DSH_SSH_CONFIG: sshConfig2,
      DSH_RC_DRYRUN: '0',
    };
    const child = spawn(process.execPath, [wrapperMjs, '--host', 'alpha', '--rc-dir', target], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let payload;
    for (let index = 0; index < 40; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const files = readdirSync(join(target, 'sessions'));
      if (files.length > 0) {
        payload = JSON.parse(readFileSync(join(target, 'sessions', files[0]), 'utf8'));
        break;
      }
    }
    child.kill('SIGKILL');
    assert.ok(payload, '应该在 --rc-dir 下写 rendezvous');
    assert.equal(payload.host, 'alpha');
  });

  it('非 dry-run 时写 rendezvous，socket 为空（宿主据此走 PTY）', async () => {
    // 假 ssh 先睡一会，好在它退出、rendezvous 被删之前读到文件
    const stubDir = join(rcDir, 'stubs-slow');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, 'ssh'), '#!/bin/sh\ncase "$1" in\n  -G) exit 1 ;;\nesac\nsleep 2\nexit 0\n', { mode: 0o755 });
    const child = spawn(process.execPath, [wrapperMjs, '--target', 'probe-host'], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        DSH_REMOTE_CONSOLE_DIR: rcDir,
        DSH_SSH_CONFIG: sshConfig,
        DSH_RC_DRYRUN: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let payload;
    for (let index = 0; index < 40; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const files = readdirSync(join(rcDir, 'sessions'));
      if (files.length > 0) {
        payload = JSON.parse(readFileSync(join(rcDir, 'sessions', files[0]), 'utf8'));
        break;
      }
    }
    child.kill('SIGKILL');
    assert.ok(payload, '应该写出 rendezvous');
    assert.equal(payload.host, 'probe-host');
    assert.equal(payload.socket, '', '没有 ControlMaster，socket 必须为空');
  });
});

describe('无 ControlMaster 时的通道选择', () => {
  it('transportOf：有 socket 走 socket，空 socket/未登录走 pty', () => {
    assert.equal(transportOf({ socket: '/tmp/x.sock' }), 'socket');
    assert.equal(transportOf({ socket: '' }), 'pty');
    assert.equal(transportOf({}), 'pty');
  });

  it('Windows 启动器是 node + dsh-ssh.mjs，args 带 --host/--target', async () => {
    const previous = process.env.DSH_RC_FORCE_NODE_LAUNCHERS;
    process.env.DSH_RC_FORCE_NODE_LAUNCHERS = '1';
    try {
      ensureDirs();
      const controller = {
        shells: async () => [{ path: '/bin/bash', name: 'bash', args: ['-i'] }],
        list: () => [],
        retain: () => ({}),
      };
      const ctx = {
        subprocess: { spawnTerminal: async () => ({ output: new PassThrough(), done: new Promise(() => {}) }) },
        terminalController: controller,
        get: () => undefined,
      };
      apply(ctx, { hosts: 'target-host\nops@10.9.9.9:2220' });
      const shells = (await controller.shells()).filter((entry) => entry.name.startsWith('SSH '));
      const alias = shells.find((entry) => entry.name === 'SSH target-host');
      const target = shells.find((entry) => entry.name === 'SSH ops@10.9.9.9:2220');
      assert.equal(alias.path, process.execPath);
      // 启动器把 rc 目录传下去：PTY 环境可能没有 DSH_HOME，不能靠环境变量推
      assert.deepEqual(alias.args, [wrapperMjs, '--host', 'target-host', '--rc-dir', rcDir]);
      assert.deepEqual(target.args, [wrapperMjs, '--target', 'ops@10.9.9.9:2220', '--rc-dir', rcDir]);
      const newSession = shells.find((entry) => entry.name === 'SSH 新建会话');
      assert.deepEqual(newSession.args, [wrapperMjs, '--ask-target', '--rc-dir', rcDir]);
    } finally {
      if (previous === undefined) delete process.env.DSH_RC_FORCE_NODE_LAUNCHERS;
      else process.env.DSH_RC_FORCE_NODE_LAUNCHERS = previous;
    }
  });

  it('启动器解析真正的 Node（issue #26：Desktop 的 execPath 是 App 不是 node）', () => {
    const { resolveNodeExecutable } = __testing;
    // CLI 宿主：execPath 本身就是 node
    assert.equal(resolveNodeExecutable({ execPath: '/usr/bin/node', env: {}, platform: 'linux', exists: () => false }), '/usr/bin/node');
    // 显式覆盖优先
    assert.equal(
      resolveNodeExecutable({ execPath: 'C:\\App\\DeepSeek Harness.exe', env: { DSH_RC_NODE: 'C:\\node\\node.exe' }, platform: 'win32', exists: () => false }),
      'C:\\node\\node.exe',
    );
    // DSH Desktop：按候选路径找到自带的 Node（用 POSIX 布局模拟，Windows 侧由 path.join 生成同构路径）
    const appPath = '/opt/DeepSeek Harness/DeepSeek Harness';
    const expected = join('/opt/DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node');
    assert.equal(resolveNodeExecutable({ execPath: appPath, env: {}, platform: 'linux', exists: (candidate) => candidate === expected }), expected);
    // 找不到候选时退回 execPath（保持原行为，不引入新的失败点）
    assert.equal(resolveNodeExecutable({ execPath: appPath, env: {}, platform: 'linux', exists: () => false }), appPath);
  });

  it('Windows 写入按 8 字符切片（issue #26 的丢帧修复）', async () => {
    const { writeSlices, chunkedWrites } = __testing;
    assert.deepEqual(writeSlices('1234567890abcdefghij'), ['12345678', '90abcdef', 'ghij']);
    assert.deepEqual(writeSlices('short'), ['short']);
    assert.deepEqual(writeSlices(''), []);
    assert.equal(typeof chunkedWrites(), 'boolean');

    ensureDirs();
    const previous = process.env.DSH_RC_FORCE_SLOW_WRITE;
    process.env.DSH_RC_FORCE_SLOW_WRITE = '1';
    try {
      const writes = [];
      const cover = new __testing.Console(
        'slow-write',
        {
          write: async (chunk) => {
            writes.push(chunk);
          },
        },
        new PassThrough(),
        {},
      );
      await cover.write(' echo 1234567890abcdefghij\r');
      assert.equal(writes.join(''), ' echo 1234567890abcdefghij\r');
      assert.ok(writes.length > 1, '应分片写入');
      assert.ok(writes.every((chunk) => chunk.length <= 8));
    } finally {
      if (previous === undefined) delete process.env.DSH_RC_FORCE_SLOW_WRITE;
      else process.env.DSH_RC_FORCE_SLOW_WRITE = previous;
    }
  });

  it('spawnTerminal 能识别 node 版启动器并接管输出', async () => {
    const handles = [];
    const controller = { shells: async () => [], list: () => [], retain: () => ({}) };
    const wrappedSubprocess = {
      spawnTerminal: async (spec) => {
        const handle = {
          pid: 6000 + handles.length,
          spec,
          output: new PassThrough(),
          write: async () => {},
          terminate: async () => {},
          done: new Promise(() => {}),
        };
        handles.push(handle);
        return handle;
      },
    };
    const ctx = {
      subprocess: wrappedSubprocess,
      terminalController: controller,
      get: () => undefined,
    };
    apply(ctx);
    const result = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, wrapperMjs, '--target', 'ops@1.2.3.4'], cwd: tmpdir() });
    const pid = String(handles[0].pid);
    assert.ok(state().consoles.has(pid), 'node 版包装器的终端应被登记为 console');
    // output 被换成插件留存的 tee
    assert.ok(result.output instanceof PassThrough);
    state().consoles.delete(pid);
  });
});

describe('没有 socket 时工具自动走 PTY 通道（真实 shell）', () => {
  const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).error === undefined;
  let child;
  let cover;

  before(async () => {
    if (!hasBash) return;
    const { Console } = __testing;
    child = spawn('bash', ['--noprofile', '--norc', '-i'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
    });
    const tee = new PassThrough();
    const handle = {
      pid: child.pid,
      output: child.stdout,
      write: async (text) => {
        child.stdin.write(text);
      },
      terminate: async () => child.kill('SIGKILL'),
      done: new Promise((resolve) => child.once('close', (code) => resolve({ exitCode: code }))),
    };
    cover = new Console(String(handle.pid), handle, tee, { argv: ['bash'] });
    child.stdout.on('data', (chunk) => cover.feed(chunk));
    child.stderr.on('data', () => {});
    // 没有 ControlMaster：socket 为空字符串，transportOf() 因此返回 pty
    cover.socket = '';
    cover.host = 'pty-host';
    cover.events = [];
    cover.logPath = join(rcDir, `pty-${handle.pid}.jsonl`);
    state().consoles.set(cover.pid, cover);
    const ready = await cover.run('printf DSH-WIN-READY', 20000);
    assert.match(ready.stdout, /DSH-WIN-READY/u);
  });

  after(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (cover !== undefined) state().consoles.delete(cover.pid);
  });

  /** 每次在这里注册一套工具，拿到定义直接 execute。 */
  function tools() {
    const registered = new Map();
    const registry = {
      register(definition) {
        registered.set(definition.name, definition);
        return () => {};
      },
    };
    const ctx = {
      subprocess: { spawnTerminal: async () => ({ output: new PassThrough(), done: new Promise(() => {}) }) },
      terminalController: { shells: async () => [], list: () => [], retain: () => ({}) },
      get: (service) => (service === 'tools' ? registry : undefined),
    };
    apply(ctx);
    return registered;
  }

  it('remote_write_file / remote_read_file 走 PTY，内容真的落盘', { skip: !hasBash }, async () => {
    const registered = tools();
    const target = join(rcDir, 'pty-note.txt');
    const written = await registered.get('remote_write_file').execute(
      { path: target, content: 'windows fallback\n', console_pid: cover.pid },
      { agent: undefined },
    );
    assert.match(written.text, /status: done/u);
    assert.match(written.text, /transport: pty/u);
    assert.equal(readFileSync(target, 'utf8'), 'windows fallback\n');

    const read = await registered.get('remote_read_file').execute({ path: target, console_pid: cover.pid }, {});
    assert.match(read.text, /windows fallback/u);
    assert.match(read.text, /transport: pty/u);
  });

  it('remote_upload / remote_download 走 PTY 并校验 sha256', { skip: !hasBash }, async () => {
    const registered = tools();
    const local = join(rcDir, 'pty-up.bin');
    const payload = Buffer.alloc(3000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 13) % 256;
    writeFileSync(local, payload);
    const remote = join(rcDir, 'pty-remote.bin');

    const up = await registered.get('remote_upload').execute(
      { local_path: local, remote_path: remote, console_pid: cover.pid },
      { agent: undefined },
    );
    assert.match(up.text, /verified: yes/u);
    assert.match(up.text, /transport: pty/u);
    assert.deepEqual(readFileSync(remote), payload);

    const downPath = join(rcDir, 'pty-down.bin');
    const down = await registered.get('remote_download').execute(
      { remote_path: remote, local_path: downPath, console_pid: cover.pid },
      {},
    );
    assert.match(down.text, /verified: yes/u);
    assert.deepEqual(readFileSync(downPath), payload);
  });

  it('remote_exec 走 PTY 并在输出里说明通道', { skip: !hasBash }, async () => {
    const registered = tools();
    const result = await registered.get('remote_exec').execute(
      { command: 'printf PTY-EXEC-WIN', console_pid: cover.pid },
      { agent: undefined },
    );
    assert.match(result.text, /PTY-EXEC-WIN/u);
    assert.match(result.text, /transport: pty/u);
  });

  it('remote_forward 在 PTY 通道下明确不可用', { skip: !hasBash }, async () => {
    const registered = tools();
    await assert.rejects(
      () => registered.get('remote_forward').execute({ action: 'start', remote_port: 5432, console_pid: cover.pid }, {}),
      /FORWARD_UNAVAILABLE/u,
    );
  });
});
