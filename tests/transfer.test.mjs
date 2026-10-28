/**
 * 文件传输 / 端口转发的纯逻辑：路径安全、敏感写入判定、socket argv 拼装、空闲端口。
 * 真实 sshd 上的端到端行为在 tests/integration-sshd.test.mjs。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-transfer-'));

const { __testing } = await import('../lib/index.js');
const {
  normalizeRemotePath,
  sensitiveWriteMatches,
  sshSocketArgv,
  remoteHashScript,
  reserveFreePort,
  portAccepts,
  MAX_TEXT_WRITE_BYTES,
} = __testing;

describe('normalizeRemotePath', () => {
  it('接受绝对路径与相对 HOME 的路径', () => {
    assert.equal(normalizeRemotePath('/var/log/app.log'), '/var/log/app.log');
    assert.equal(normalizeRemotePath('src/index.js'), 'src/index.js');
    assert.equal(normalizeRemotePath('  ~/notes.md  '), '~/notes.md');
  });

  it('拒绝空路径、NUL 与任何 `..` 段', () => {
    assert.throws(() => normalizeRemotePath(''), /BAD_PATH/u);
    assert.throws(() => normalizeRemotePath('   '), /BAD_PATH/u);
    assert.throws(() => normalizeRemotePath('/tmp/a\0b'), /BAD_PATH/u);
    assert.throws(() => normalizeRemotePath('../etc/passwd'), /REMOTE_PATH_UNSAFE/u);
    assert.throws(() => normalizeRemotePath('/tmp/../etc/passwd'), /REMOTE_PATH_UNSAFE/u);
    // 名字里恰好含两个点但不是 .. 段，应当放行
    assert.equal(normalizeRemotePath('/tmp/..hidden'), '/tmp/..hidden');
  });
});

describe('sensitiveWriteMatches', () => {
  it('命中会改变登录方式或系统配置的路径', () => {
    assert.deepEqual(sensitiveWriteMatches('~/.ssh/authorized_keys'), ['ssh-dir', 'authorized-keys']);
    assert.deepEqual(sensitiveWriteMatches('/root/.ssh/config'), ['ssh-dir', 'root']);
    assert.deepEqual(sensitiveWriteMatches('/etc/passwd'), ['etc']);
    assert.deepEqual(sensitiveWriteMatches('/etc/sudoers'), ['etc', 'sudoers']);
    assert.deepEqual(sensitiveWriteMatches('/etc/sudoers.d/90-cloud'), ['etc', 'sudoers']);
    assert.deepEqual(sensitiveWriteMatches('/etc/systemd/system/x.service'), ['etc', 'systemd-unit']);
    assert.deepEqual(sensitiveWriteMatches('/home/u/.bashrc'), ['shell-profile']);
    assert.deepEqual(sensitiveWriteMatches('/home/u/.zshrc'), ['shell-profile']);
    assert.deepEqual(sensitiveWriteMatches('.ssh/authorized_keys'), ['ssh-dir', 'authorized-keys']);
  });

  it('普通路径不误报', () => {
    assert.deepEqual(sensitiveWriteMatches('/tmp/app.log'), []);
    assert.deepEqual(sensitiveWriteMatches('/home/u/project/src/main.ts'), []);
    assert.deepEqual(sensitiveWriteMatches('/var/log/nginx/access.log'), []);
    // passwd 只是文件名的一部分，不是 /etc/passwd
    assert.deepEqual(sensitiveWriteMatches('/tmp/passwd'), []);
  });
});

describe('sshSocketArgv', () => {
  const cover = { socket: '/tmp/x.sock', host: 'testhost' };

  it('复用 master：BatchMode=yes、ControlMaster=no、`--` 在 host 之前', () => {
    const argv = sshSocketArgv(['-F', '/tmp/cfg'], cover);
    assert.deepEqual(argv.slice(0, 3), ['-F', '/tmp/cfg', '-S']);
    assert.equal(argv[3], '/tmp/x.sock');
    assert.ok(argv.includes('BatchMode=yes'));
    assert.ok(argv.includes('ControlMaster=no'));
    const dash = argv.indexOf('--');
    assert.equal(argv[dash + 1], 'testhost');
    assert.equal(dash, argv.length - 2);
  });

  it('额外参数（-L / -N）插在 host 之前', () => {
    const argv = sshSocketArgv([], cover, ['-N', '-L', '127.0.0.1:9000:db:5432']);
    const dash = argv.indexOf('--');
    assert.deepEqual(argv.slice(dash - 3, dash), ['-N', '-L', '127.0.0.1:9000:db:5432']);
    assert.equal(argv[dash + 1], 'testhost');
  });
});

describe('remoteHashScript', () => {
  it('优先 sha256sum，回退 shasum，并对路径做单引号转义', () => {
    const script = remoteHashScript("/tmp/it's here.txt");
    assert.ok(script.includes('command -v sha256sum'));
    assert.ok(script.includes('shasum -a 256'));
    assert.ok(script.includes("'/tmp/it'\\''s here.txt'"));
    assert.ok(script.includes('UNAVAILABLE'));
  });
});

describe('空闲端口', () => {
  it('reserveFreePort 给出的端口可以立刻重新绑定', async () => {
    const port = await reserveFreePort();
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  });

  it('portAccepts 对监听中的端口返回 true，对关闭的端口返回 false', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    assert.equal(await portAccepts(port, 200), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await portAccepts(port, 200), false);
  });
});

it('文本写入上限是 256 KB', () => {
  assert.equal(MAX_TEXT_WRITE_BYTES, 256 * 1024);
});
