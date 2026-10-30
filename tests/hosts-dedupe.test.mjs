/**
 * 面板主机来源去重：hosts.tsv 里带 user/port 的行是登录时记下的直连目标，
 * 必须还原成 user@host:port 走 --target，并与设置页里的同目标去重，
 * 否则面板会同时出现 `127.0.0.1` 和 `demo@127.0.0.1:2222` 两个入口。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const RC_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-dedupe-'));
process.env.DSH_REMOTE_CONSOLE_DIR = RC_DIR;
process.env.DSH_SSH_CONFIG = join(RC_DIR, 'ssh-config');

const { __testing } = await import('../lib/index.js');
const { directTargetSpecs, discoverHosts } = __testing;

const entry = (host, user = '', port = '') => ({ host, user, port });

describe('面板主机去重（hosts.tsv + 设置页）', () => {
  it('设置页与 hosts.tsv 指向同一目标时只出一个入口', () => {
    const specs = directTargetSpecs(['demo@127.0.0.1:2222'], [entry('127.0.0.1', 'demo', '2222')]);
    assert.deepEqual(specs, ['demo@127.0.0.1:2222']);
  });

  it('hosts.tsv 的直连行会还原成 user@host:port', () => {
    assert.deepEqual(directTargetSpecs([], [entry('10.0.0.5', 'deploy', '2222')]), ['deploy@10.0.0.5:2222']);
    assert.deepEqual(directTargetSpecs([], [entry('10.0.0.5', 'deploy', '')]), ['deploy@10.0.0.5']);
    assert.deepEqual(directTargetSpecs([], [entry('10.0.0.5', '', '2222')]), ['10.0.0.5:2222']);
  });

  it('缺省端口与显式 22 视为同一个目标', () => {
    assert.deepEqual(directTargetSpecs(['deploy@10.0.0.5'], [entry('10.0.0.5', 'deploy', '22')]), ['deploy@10.0.0.5']);
  });

  it('user/port 都为空的 hosts.tsv 行是真别名，不进直连目标', () => {
    assert.deepEqual(directTargetSpecs([], [entry('demo-vm')]), []);
  });

  it('hosts.tsv 的直连行不再被当成别名出现在 discoverHosts 里', () => {
    writeFileSync(process.env.DSH_SSH_CONFIG, 'Host nas\n  HostName 192.0.2.10\n');
    writeFileSync(join(RC_DIR, 'hosts.tsv'), 'nas\t\t\ndemo-vm\t\t\n127.0.0.1\tdemo\t2222\n');
    const hosts = discoverHosts();
    assert.ok(hosts.includes('nas'), 'ssh config 别名应保留');
    assert.ok(hosts.includes('demo-vm'), 'hosts.tsv 里的真别名应保留');
    assert.ok(!hosts.includes('127.0.0.1'), '带 user/port 的直连行不能变成别名');
  });
});
