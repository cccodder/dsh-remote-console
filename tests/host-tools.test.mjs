/**
 * 主机列表工具：不依赖设置页、不依赖终端，直接读写 hosts.tsv。
 * 用临时 DSH_REMOTE_CONSOLE_DIR，不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-hosttools-'));
const sshConfig = join(rcDir, 'ssh_config');
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_SSH_CONFIG = sshConfig;

const plugin = await import('../lib/index.js');
const { apply, __testing } = plugin;
const { paths } = __testing;

function makeTools() {
  const registered = new Map();
  const registry = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => {};
    },
  };
  const ctx = {
    subprocess: { spawnTerminal: async () => ({ output: {}, done: new Promise(() => {}) }) },
    terminalController: { shells: async () => [], list: () => [], retain: () => ({}) },
    get: (service) => (service === 'tools' ? registry : undefined),
  };
  apply(ctx);
  return registered;
}

describe('主机列表工具（不需要设置页 / 终端）', () => {
  it('remote_host_add 写入 hosts.tsv，重复添加是更新不是追加', async () => {
    const tools = makeTools();
    const added = await tools.get('remote_host_add').execute({ spec: 'deploy@10.0.0.5:2220' }, {});
    assert.match(added.text, /status: done/u);
    assert.match(added.text, /host: 10\.0\.0\.5/u);
    assert.match(added.text, /port: 2220/u);
    const file = join(paths.RC_DIR, 'hosts.tsv');
    assert.equal(readFileSync(file, 'utf8'), '10.0.0.5\tdeploy\t2220\n');

    // 同一个 host 再发布一次：更新 user/port
    await tools.get('remote_host_add').execute({ spec: 'root@10.0.0.5' }, {});
    assert.equal(readFileSync(file, 'utf8'), '10.0.0.5\troot\t\n');
  });

  it('remote_host_list 标出来源', async () => {
    const tools = makeTools();
    await tools.get('remote_host_add').execute({ spec: 'ops@10.1.1.1' }, {});
    const listed = await tools.get('remote_host_list').execute({}, {});
    assert.match(listed.text, /10\.1\.1\.1\s+\(hosts\.tsv\)/u);
  });

  it('remote_host_remove 只删 hosts.tsv 里的条目', async () => {
    const tools = makeTools();
    await tools.get('remote_host_add').execute({ spec: 'tmp@10.2.2.2' }, {});
    const removed = await tools.get('remote_host_remove').execute({ spec: '10.2.2.2' }, {});
    assert.match(removed.text, /status: done/u);
    const listed = await tools.get('remote_host_list').execute({}, {});
    assert.ok(!listed.text.includes('10.2.2.2'));
    const again = await tools.get('remote_host_remove').execute({ spec: '10.2.2.2' }, {});
    assert.match(again.text, /NOT_FOUND/u);
  });

  it('非法写法被拒绝，不写坏文件', async () => {
    const tools = makeTools();
    await assert.rejects(() => tools.get('remote_host_add').execute({ spec: 'bad host;rm -rf /' }, {}), /BAD_SPEC/u);
    await assert.rejects(() => tools.get('remote_host_add').execute({ spec: '10.0.0.5:99999' }, {}), /BAD_SPEC|端口/u);
  });

  it('加进去的主机会出现在 shells() 的启动器里', async () => {
    const tools = makeTools();
    await tools.get('remote_host_add').execute({ spec: 'listed@10.3.3.3:2201' }, {});
    const controller = { shells: async () => [], list: () => [], retain: () => ({}) };
    const ctx = {
      subprocess: { spawnTerminal: async () => ({ output: {}, done: new Promise(() => {}) }) },
      terminalController: controller,
      get: () => undefined,
    };
    apply(ctx);
    const list = await controller.shells();
    assert.ok(list.some((entry) => entry.name === 'SSH 10.3.3.3' || entry.name.includes('10.3.3.3')), list.map((e) => e.name).join(', '));
  });
});
