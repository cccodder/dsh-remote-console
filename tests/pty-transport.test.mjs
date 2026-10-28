/**
 * 回退通道的真实验证：起一个交互式本地 bash 当「终端」，直接跑
 * ptyWriteFile / ptyReadFile / ptyRemoteHash / ptyExec（Windows 上没有 ControlMaster
 * 时工具走的就是这几个函数）。
 *
 * 说明：容器里没有可用的 pty（`script` 也报 Permission denied），所以这里用
 * `bash -i` 的管道作为最接近的替身：命令注入、OSC 哨兵、分块 base64、退出码都是同一套
 * 代码路径，只是少了终端行缓冲的长度限制（那是 Windows conpty 才有的约束）。
 * 没有 bash 时整组跳过。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).error === undefined;

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-pty-'));
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_RC_NO_CLEAR = '1';

const state = {};

describe('回退通道（真实 shell）', { skip: hasBash ? false : 'no bash' }, () => {
  before(async () => {
    const plugin = await import('../lib/index.js');
    const { Console, state: pluginState } = plugin.__testing;
    const child = spawn('bash', ['--noprofile', '--norc', '-i'], {
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
      terminate: async () => {
        child.kill('SIGKILL');
      },
      done: new Promise((resolve) => child.once('close', (code) => resolve({ exitCode: code }))),
    };
    const cover = new Console(String(child.pid), handle, tee, { argv: ['bash'] });
    child.stdout.on('data', (chunk) => cover.feed(chunk));
    child.stderr.on('data', () => {});
    pluginState().consoles.set(cover.pid, cover);
    state.plugin = plugin;
    state.child = child;
    state.cover = cover;
    state.workdir = mkdtempSync(join(tmpdir(), 'dsh-rc-pty-files-'));
    // 等 shell 起来：用一条命令做就绪探测
    const ready = await cover.run('printf DSH-PTY-READY', 20000);
    assert.match(ready.stdout, /DSH-PTY-READY/u);
  });

  after(() => {
    try {
      state.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    rmSync(state.workdir, { recursive: true, force: true });
  });

  it('ptyExec 在 PTY 里执行命令并拿退出码', async () => {
    const { ptyExec } = state.plugin.__testing;
    const result = await ptyExec(state.cover, 'printf PTY-EXEC-OK', 20000);
    assert.match(result.stdout, /PTY-EXEC-OK/u);
    assert.equal(result.exitCode, 0);
  });

  it('base64 解码参数按远端实现探测（GNU -d）', async () => {
    const { base64DecodeFlag } = state.plugin.__testing;
    assert.equal(await base64DecodeFlag(state.cover), '-d');
  });

  it('ptyWriteFile 分块写入（>2KB，跨多个 chunk）', async () => {
    const { ptyWriteFile } = state.plugin.__testing;
    const buffer = Buffer.alloc(5000);
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = (index * 7 + 3) % 256;
    const target = join(state.workdir, 'chunked.bin');
    await ptyWriteFile(state.cover, target, buffer);
    assert.deepEqual(readFileSync(target), buffer);
  });

  it('ptyWriteFile append 追加', async () => {
    const { ptyWriteFile } = state.plugin.__testing;
    const target = join(state.workdir, 'append.txt');
    await ptyWriteFile(state.cover, target, Buffer.from('alpha\n'));
    await ptyWriteFile(state.cover, target, Buffer.from('beta\n'), { append: true });
    assert.equal(readFileSync(target, 'utf8'), 'alpha\nbeta\n');
  });

  it('ptyReadFile 读回内容、按上限截断', async () => {
    const { ptyReadFile } = state.plugin.__testing;
    const target = join(state.workdir, 'read.txt');
    writeFileSync(target, 'hello pty world\n');
    const full = await ptyReadFile(state.cover, target, 1024);
    assert.equal(full.buffer.toString('utf8'), 'hello pty world\n');
    assert.equal(full.truncated, false);

    const partial = await ptyReadFile(state.cover, target, 5);
    assert.equal(partial.buffer.length, 5);
    assert.equal(partial.truncated, true);
  });

  it('ptyRemoteHash 与本地 sha256 一致', async () => {
    const { ptyRemoteHash } = state.plugin.__testing;
    const target = join(state.workdir, 'hash.bin');
    const buffer = Buffer.from('哈希校验用的内容');
    writeFileSync(target, buffer);
    const expected = createHash('sha256').update(buffer).digest('hex');
    assert.equal(await ptyRemoteHash(state.cover, target), expected);
  });

  it('PTY 通道上限会挡掉过大的文件', async () => {
    const { ptyWriteFile, PTY_TRANSFER_LIMIT } = state.plugin.__testing;
    assert.ok(PTY_TRANSFER_LIMIT >= 1024 * 1024);
    assert.equal(existsSync(join(state.workdir, 'huge.bin')), false);
    await assert.rejects(
      () => ptyWriteFile(state.cover, join(state.workdir, 'huge.bin'), Buffer.alloc(PTY_TRANSFER_LIMIT + 1)),
      /TRANSFER_TOO_LARGE/u,
    );
  });
});
