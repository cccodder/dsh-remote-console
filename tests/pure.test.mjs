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
const { sanitize, redact, echoSkipLength, singleQuote, dangerousMatches, terminatingMatches , forwardSpec, sshSocketArgv, dangerEntries, describeDanger } = __testing;

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

describe('端口转发规格', () => {
  it('-L：本地端口转到远端 host:port', () => {
    const { flag, spec } = forwardSpec('L', { localPort: 9000, remoteHost: 'db.internal', remotePort: 5432 });
    assert.equal(flag, '-L');
    assert.equal(spec, '127.0.0.1:9000:db.internal:5432');
  });

  it('-D：只有本地 SOCKS5 监听，没有目标', () => {
    const { flag, spec } = forwardSpec('D', { localPort: 1080 });
    assert.equal(flag, '-D');
    assert.equal(spec, '127.0.0.1:1080');
    assert.ok(!spec.includes(':db'), 'SOCKS5 不该带远端目标');
  });

  it('-D 的取消命令必须用 -D 标记（用 -L 取消不掉）', () => {
    const prefix = [];
    const cover = { socket: '/tmp/x.sock', host: 'h' };
    const { flag, spec } = forwardSpec('D', { localPort: 1080 });
    const argv = sshSocketArgv(prefix, cover, ['-O', 'cancel', flag, spec]);
    assert.ok(argv.includes('-D'), argv.join(' '));
    assert.ok(!argv.includes('-L'), argv.join(' '));
  });
});

describe('危险命令分级', () => {
  it('删除类命中给 destructive 和中文说明', () => {
    const entries = dangerEntries('rm -rf /data');
    assert.equal(entries[0].id, 'rm-recursive-force');
    assert.equal(entries[0].risk, 'destructive');
    assert.equal(entries[0].label, '递归强制删除');
  });

  it('强制推送是 irreversible，不是 destructive', () => {
    const entries = dangerEntries('git push --force origin main');
    assert.ok(entries.some((entry) => entry.id === 'force-push' && entry.risk === 'irreversible'));
  });

  it('结束会话类只有在 includeTerminating 时才出现', () => {
    assert.equal(dangerEntries('exit 0', { includeTerminating: false }).length, 0);
    const withTerm = dangerEntries('exit 0', { includeTerminating: true });
    assert.equal(withTerm[0].id, 'shell-exit');
    assert.equal(withTerm[0].risk, 'session');
  });

  it('正常命令不误报', () => {
    for (const cmd of ['ls -la', 'git status', 'rm -f build.log', 'sudo systemctl restart nginx']) {
      assert.equal(dangerEntries(cmd).length, 0, cmd);
    }
  });

  it('描述句说清「为什么危险」，不拿模式 id 交差', () => {
    const text = describeDanger(dangerEntries('rm -rf /data && git push --force'));
    assert.match(text, /递归强制删除（数据会被删除，无法恢复）/);
    assert.match(text, /强制推送覆盖远端历史（操作不可逆，回滚成本高）/);
    assert.ok(!text.includes('rm-recursive-force'), '不要把内部 id 甩给用户');
  });
});
