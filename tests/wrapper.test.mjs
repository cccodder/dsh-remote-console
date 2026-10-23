/**
 * 菜单包装器（bin/dsh-ssh）测试：用 dry-run 模式验证主机解析、菜单选择、
 * user@host:port 解析与 hosts.tsv 回写。不需要 ssh 客户端。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', 'bin', 'dsh-ssh');

function run(args, input) {
  const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-wrapper-'));
  const sshConfig = join(rcDir, 'ssh_config');
  writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\n');
  const result = spawnSync('bash', [wrapper, ...args], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      DSH_REMOTE_CONSOLE_DIR: rcDir,
      DSH_SSH_CONFIG: sshConfig,
      DSH_RC_DRYRUN: '1',
    },
  });
  return { ...result, rcDir };
}

describe('bin/dsh-ssh 菜单', () => {
  it('列出 ~/.ssh/config 的主机并 dry-run 连接', () => {
    const { status, stdout, rcDir } = run([], '1\n');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /DSH 远程控制终端/u);
    assert.match(stdout, /alpha/u);
    assert.match(stdout, /beta/u);
    assert.match(stdout, />> ssh/u);
    assert.match(stdout, /\[dry-run\]/u);
    // dry-run 不该留下 rendezvous / socket 文件
    assert.deepEqual(readdirSync(join(rcDir, 'sessions')), []);
    assert.deepEqual(readdirSync(join(rcDir, 'socks')), []);
  });

  it('q 退出', () => {
    const { status, stdout } = run([], 'q\n');
    assert.equal(status, 0);
    assert.match(stdout, /已退出/u);
    assert.ok(!stdout.includes('>> ssh'));
  });

  it('n 新建主机并写入 hosts.tsv', () => {
    const { status, stdout, rcDir } = run([], 'n\n10.9.9.9\ndeploy\n2222\n');
    assert.equal(status, 0, stdout);
    assert.match(stdout, />> ssh/u);
    assert.match(stdout, /deploy@10\.9\.9\.9/u);
    const hosts = readFileSync(join(rcDir, 'hosts.tsv'), 'utf8');
    assert.match(hosts, /^10\.9\.9\.9\tdeploy\t2222$/mu);
  });
});

describe('bin/dsh-ssh 直接指定主机', () => {
  it('--host 走 dry-run', () => {
    const { status, stdout } = run(['--host', 'alpha'], '');
    assert.equal(status, 0, stdout);
    assert.match(stdout, />> ssh/u);
    assert.match(stdout, /alpha/u);
    assert.ok(!stdout.includes('DSH 远程控制终端'), '指定主机时不该再出菜单');
  });

  it('--ask-target 解析 user@host:port', () => {
    const { status, stdout, rcDir } = run(['--ask-target'], 'root@10.0.0.5:2222\n');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /root@10\.0\.0\.5/u);
    assert.match(stdout, /-p 2222/u);
    const hosts = readFileSync(join(rcDir, 'hosts.tsv'), 'utf8');
    assert.match(hosts, /^10\.0\.0\.5\troot\t2222$/mu);
  });

  it('IPv6 不按 host:port 拆', () => {
    const { status, stdout } = run(['--ask-target'], 'root@2001:db8::1\n');
    assert.equal(status, 0, stdout);
    assert.match(stdout, /root@2001:db8::1/u);
    assert.ok(!stdout.includes('-p '), 'IPv6 地址不该被拆出端口');
  });

  it('--ask-target 直接回车取消', () => {
    const { status, stdout } = run(['--ask-target'], '\n');
    assert.equal(status, 0);
    assert.match(stdout, /已取消/u);
  });
});
