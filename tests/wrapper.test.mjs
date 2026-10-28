/**
 * 菜单包装器（bin/dsh-ssh）测试：dry-run 验证主机解析、菜单选择、
 * user@host:port 解析与 hosts.tsv 回写；再用 PATH 里的假 date/ssh
 * 复现 macOS 的 `date -Is` 失败与「ssh 退出后提示语」行为。
 * 不需要真的 ssh 客户端。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', 'bin', 'dsh-ssh');
const realDate = process.env.PATH.split(':')
  .map((dir) => join(dir, 'date'))
  .find((file) => existsSync(file));

/** BSD 风格 date：`-Is` 直接失败，`-u +格式` 正常。 */
const STUB_DATE = `#!/bin/sh
case "$1" in
  -I*|-Is) echo "date: invalid argument 's' for -I" >&2; exit 1 ;;
esac
exec ${JSON.stringify(realDate ?? '/bin/date')} "$@"
`;

/** 假 ssh：无参探测失败（让包装器走 -F 回退，从而写 wrapper.log），实际连接直接退出 42。 */
const STUB_SSH = `#!/bin/sh
case "$1" in
  -G) echo "ssh: stub probe failure" >&2; exit 1 ;;
esac
exit 42
`;

function makePath(stubDir, { date = false, ssh = false } = {}) {
  if (date) {
    writeFileSync(join(stubDir, 'date'), STUB_DATE);
    chmodSync(join(stubDir, 'date'), 0o755);
  }
  if (ssh) {
    writeFileSync(join(stubDir, 'ssh'), STUB_SSH);
    chmodSync(join(stubDir, 'ssh'), 0o755);
  }
  return [stubDir, process.env.PATH].join(':');
}

function run(args, input, { stubDate = false, stubSsh = false, dryRun = true } = {}) {
  const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-wrapper-'));
  const sshConfig = join(rcDir, 'ssh_config');
  writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\n');
  const stubDir = join(rcDir, 'stubs');
  mkdirSync(stubDir);
  const result = spawnSync('bash', [wrapper, ...args], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: makePath(stubDir, { date: stubDate, ssh: stubSsh }),
      DSH_REMOTE_CONSOLE_DIR: rcDir,
      DSH_SSH_CONFIG: sshConfig,
      DSH_RC_DRYRUN: dryRun ? '1' : '0',
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

describe('bin/dsh-ssh --rc-dir（不依赖 DSH_HOME）', () => {
  it('环境里没有 DSH_HOME / DSH_REMOTE_CONSOLE_DIR 时，用 --rc-dir 指定的目录', () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-rc-rcflag-'));
    const sshConfig = join(target, 'ssh_config');
    writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\n');
    const result = spawnSync('bash', [wrapper, '--host', 'alpha', '--rc-dir', target], {
      input: '',
      encoding: 'utf8',
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        DSH_SSH_CONFIG: sshConfig,
        DSH_RC_DRYRUN: '1',
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // socket 路径必须落在 --rc-dir 下
    assert.ok(result.stdout.includes(`${target}/socks/`), 'socket 路径必须落在 --rc-dir 下');
    assert.ok(existsSync(join(target, 'sessions')), '应该在 --rc-dir 下建 sessions');
    assert.ok(existsSync(join(target, 'wrapper.log')), '配置覆盖日志应写进 --rc-dir');
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

describe('跨平台时间戳（macOS BSD date）', () => {
  it('date -Is 失败时不把报错漏进终端，wrapper.log 仍有时间戳', () => {
    const { status, stdout, rcDir } = run(['--host', 'alpha'], '', { stubDate: true, stubSsh: true });
    assert.equal(status, 0, stdout);
    assert.ok(!stdout.includes('invalid argument'), `终端不应出现 date 报错：${stdout}`);
    const log = readFileSync(join(rcDir, 'wrapper.log'), 'utf8');
    assert.match(log, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /mu, `wrapper.log 时间戳格式不对：${log}`);
  });
});

describe('ssh 退出后的提示语', () => {
  it('面板指定主机：明确说终端已结束，不说「回到远端选择」', () => {
    const { status, stdout } = run(['--host', 'alpha'], '', { stubSsh: true, dryRun: false });
    assert.equal(status, 42, stdout);
    assert.match(stdout, /ssh 已退出（退出码 42）/u);
    assert.match(stdout, /这个终端已经结束/u);
    assert.ok(!stdout.includes('回到远端选择'), `一次性模式不能说还能继续用：${stdout}`);
  });

  it('菜单模式：确实回到远端选择', () => {
    const { status, stdout } = run([], '1\n', { stubSsh: true, dryRun: false });
    assert.equal(status, 0, stdout);
    assert.match(stdout, /回到远端选择/u);
  });
});
