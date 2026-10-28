/**
 * 设置页的主机列表（宿主侧）：Config schema、行解析、启动器生成。
 * 只跑纯逻辑与假 ctx，不需要 ssh。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-settings-host-'));
const sshConfig = join(rcDir, 'ssh_config');
writeFileSync(sshConfig, 'Host nas\n  HostName 10.0.0.9\nHost other\n  HostName 10.0.0.10\n');
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_SSH_CONFIG = sshConfig;
process.env.DSH_RC_NO_CLEAR = '1';

const plugin = await import('../lib/index.js');
const { apply, Config, __testing } = plugin;
const { configHostLines, isDirectTarget, ensureDirs, discoverHosts, state, paths } = __testing;

function makeCtx() {
  const controller = {
    shells: async () => [{ path: '/bin/bash', name: 'bash', args: ['-i'] }],
    list: () => [],
    retain: () => ({ type: 'retained' }),
  };
  const ctx = {
    subprocess: { spawnTerminal: async () => ({ output: { pipe() {} }, done: new Promise(() => {}) }) },
    terminalController: controller,
    get: () => undefined,
  };
  return ctx;
}

describe('Config schema', () => {
  /** volatile 字段在 schemastery 里是 `{ get() }` 引用，两种形态都要能读。 */
  const read = (value) =>
    typeof value === 'string' || typeof value === 'number'
      ? value
      : value !== null && typeof value?.get === 'function'
        ? value.get()
        : undefined;

  it('hosts 默认空字符串，且接受多行文本', () => {
    assert.equal(read(Config({}).hosts), '');
    assert.equal(read(Config({ hosts: 'nas\nops@1.2.3.4:22' }).hosts), 'nas\nops@1.2.3.4:22');
  });

  it('maxTransferMB 默认 256、标了 volatile（DSH 设置接口只允许写 volatile 字段）', () => {
    // 回归：0.10.3 漏了 volatile，导致设置页保存被 DSH 整体拒绝
    assert.equal(Config.dict.maxTransferMB.meta?.volatile, true);
    assert.equal(read(Config({}).maxTransferMB), 256);
    assert.equal(read(Config({ maxTransferMB: 512 }).maxTransferMB), 512);
  });

  it('maxTransferMB 不在 schema 层拒绝越界值（避免坏配置让插件加载失败）', () => {
    assert.equal(read(Config({}).maxTransferMB), 256);
    assert.equal(read(Config({ maxTransferMB: 8 }).maxTransferMB), 8);
    // 越界值能不能落盘由设置页拦；真落到配置里也只应夹取，不应抛错
    assert.doesNotThrow(() => Config({ maxTransferMB: 5000 }));
    assert.doesNotThrow(() => Config({ maxTransferMB: 0 }));
    assert.equal(__testing.resolveMaxTransferMB(read(Config({ maxTransferMB: 5000 }).maxTransferMB)), 2048);
  });
});

describe('configHostLines', () => {
  it('去空行与注释、去重、拒绝非法字符', () => {
    state().config = {
      hosts: ['# 注释', '', '  nas  ', 'ops@1.2.3.4:22', 'nas', 'bad host', 'x;rm -rf /'].join('\n'),
    };
    assert.deepEqual(configHostLines(), ['nas', 'ops@1.2.3.4:22']);
    state().config = {};
  });
});

describe('isDirectTarget', () => {
  it('别名不是直连目标，user@host / host:port / IPv6 是', () => {
    assert.equal(isDirectTarget('nas'), false);
    assert.equal(isDirectTarget('ops@10.0.0.5'), true);
    assert.equal(isDirectTarget('10.0.0.5:2222'), true);
    assert.equal(isDirectTarget('[::1]:22'), true);
  });
});

describe('设置页主机 → 侧栏启动器', () => {
  it('apply(config) 后 shells() 里有别名的 --host 启动器与直连目标的 --target 启动器', async () => {
    ensureDirs();
    const ctx = makeCtx();
    const dispose = apply(ctx, { hosts: '# 家\nnas\nops@10.9.9.9:2220\n' });
    const result = await ctx.terminalController.shells();
    const names = result.map((entry) => entry.name);
    assert.ok(names.includes('SSH nas'), `应包含 SSH nas：${names.join(', ')}`);
    assert.ok(names.includes('SSH ops@10.9.9.9:2220'), `应包含直连目标：${names.join(', ')}`);

    // 直连目标启动器内容走 --target，别名走 --host
    const targetLauncher = result.find((entry) => entry.name === 'SSH ops@10.9.9.9:2220');
    const body = readFileSync(targetLauncher.path, 'utf8');
    assert.match(body, /--target "ops@10\.9\.9\.9:2220"/u);
    // 启动器把 rc 目录自证给包装器：PTY 环境可能没有 DSH_HOME
    assert.ok(body.includes(`--rc-dir "${paths.RC_DIR}"`), `启动器应带 --rc-dir：${body}`);
    const aliasLauncher = result.find((entry) => entry.name === 'SSH nas');
    assert.match(readFileSync(aliasLauncher.path, 'utf8'), /--host "nas"/u);

    // 别名也要能出现在 discoverHosts 里（面板列表用）
    assert.ok(discoverHosts().includes('nas'));
    assert.ok(!discoverHosts().includes('ops@10.9.9.9:2220'), '直连目标不进别名列表');

    // 设置里删掉后，重启后旧启动器要被清掉
    dispose();
    apply(ctx, { hosts: '' });
    await ctx.terminalController.shells();
    const remaining = readdirSync(paths.BIN_DIR).filter(
      (file) => file.startsWith('dsh-ssh-') && (file.includes('nas') || file.includes('ops')),
    );
    // nas 仍来自 ssh_config；ops 直连启动器应该没了
    assert.ok(!remaining.some((file) => file.includes('ops')), `直连目标的旧启动器应被清掉：${remaining.join(', ')}`);
  });

  it('不会把非法的配置行写成启动器', async () => {
    ensureDirs();
    const ctx = makeCtx();
    apply(ctx, { hosts: 'bad host\nokhost\n' });
    const result = await ctx.terminalController.shells();
    assert.ok(result.some((entry) => entry.name === 'SSH okhost'));
    assert.ok(!existsSync(join(paths.BIN_DIR, 'dsh-ssh-bad host')));
  });
});
