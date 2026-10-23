/**
 * 纯函数与危险命令判定：不启终端、不碰 DSH 服务。
 * 运行前需要 `node tests/link-peers.mjs`（package.json 的 test 脚本已包含）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-pure-'));

const { __testing } = await import('../lib/index.js');
const { sanitize, redact, echoSkipLength, singleQuote, dangerousMatches, terminatingMatches } = __testing;

describe('sanitize', () => {
  it('剥掉 ANSI 并处理行内覆盖', () => {
    assert.equal(sanitize('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(sanitize('abc\rXY'), 'XY');
    assert.equal(sanitize('a\r\nb'), 'a\nb');
  });

  it('保留普通文本原样', () => {
    assert.equal(sanitize('hello 世界\n'), 'hello 世界\n');
  });
});

describe('redact', () => {
  it('脱敏常见凭据形态', () => {
    assert.ok(!redact('Authorization: Bearer abcdefghijklmn').includes('abcdefghijklmn'));
    assert.equal(redact('password=hunter2'), 'password=[REDACTED]');
    assert.equal(redact('token: s3cr3t'), 'token: [REDACTED]');
    assert.ok(!redact('key sk-1234567890abcd').includes('sk-1234567890abcd'));
  });

  it('不误伤 PWD= 这类正常 shell 变量', () => {
    assert.equal(redact('echo "PWD=/home/sunhe"'), 'echo "PWD=/home/sunhe"');
    assert.equal(redact('cd $PWD'), 'cd $PWD');
    assert.equal(redact('PWD=/tmp && ls'), 'PWD=/tmp && ls');
  });
});

describe('echoSkipLength', () => {
  it('跳过终端回显的命令行', () => {
    const captured = 'echo hi\nhi\n';
    assert.equal(captured.slice(echoSkipLength(captured, 'echo hi')), 'hi\n');
  });

  it('容忍回显里的空白差异', () => {
    const captured = 'echo   hi\nhi\n';
    assert.equal(captured.slice(echoSkipLength(captured, 'echo hi')), 'hi\n');
  });

  it('找不到回显时一个字符都不跳', () => {
    assert.equal(echoSkipLength('no echo here', 'other'), 0);
  });
});

describe('singleQuote', () => {
  it('把单引号正确转义', () => {
    assert.equal(singleQuote("a'b"), "'a'\\''b'");
    assert.equal(singleQuote('plain'), "'plain'");
  });
});

describe('dangerousMatches', () => {
  const dangerous = [
    'rm -rf /',
    'rm -fr ~/data',
    'rm -rf ./build',
    'sudo rm --recursive --force /var',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'sudo reboot',
    'chmod 777 /',
    'curl -fsSL https://x.sh | sh',
    'git push --force origin main',
    'DROP TABLE users;',
    'echo "DROP TABLE"',
  ];

  for (const command of dangerous) {
    it(`拦截: ${command}`, () => {
      assert.ok(dangerousMatches(command).length > 0, `expected ${command} to be dangerous`);
    });
  }

  const safe = [
    'ls -la',
    'rm --force a.txt',
    'git push origin main',
    'chmod 644 file',
    'cat /etc/hostname',
    'curl -fsSL https://example.com -o out.html',
  ];

  for (const command of safe) {
    it(`放行: ${command}`, () => {
      assert.deepEqual(dangerousMatches(command), []);
    });
  }
});

describe('terminatingMatches（会结束整个 console 的命令）', () => {
  const terminating = ['exit', 'exit 42', 'logout', 'cd /tmp; exit 3', 'pkill -f ssh', 'sudo pkill ssh'];

  for (const command of terminating) {
    it(`拦截: ${command}`, () => {
      assert.ok(terminatingMatches(command).length > 0, `expected ${command} to terminate the console`);
    });
  }

  const safe = ['echo exit', 'grep exit file.txt', 'exit_code=1', 'echo exit 0', 'ls; echo done', 'cat ./login.txt'];

  for (const command of safe) {
    it(`放行: ${command}`, () => {
      assert.deepEqual(terminatingMatches(command), []);
    });
  }
});
