/**
 * 客户端 bundle 的幂等性测试：插件热更新会再执行一次 apply，而 ctx.webTerminals
 * 是共享服务。SSH 面板必须始终拿到「未过滤」的 shells 列表——包括启动器和新建会话。
 *
 * 不启浏览器：给 client.js 一个最小的 window/document/React/localStorage 替身，
 * 捕获它注册的 slot，然后直接调 inject(...).loadShells()。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module;
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: () => {} },
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

await import('../lib/client.js');

const BASE_SHELLS = [
  { path: '/bin/bash', name: 'bash', args: ['-i'] },
  { path: '/tmp/dsh-ssh-alpha', name: 'SSH alpha', args: [] },
  { path: '/tmp/dsh-ssh-new', name: 'SSH 新建会话', args: [] },
];

function makeCtx() {
  const paneRegs = [];
  const effects = [];
  const webTerminals = {
    launchShells: async () => ({ shells: BASE_SHELLS, selectedShell: '/bin/bash' }),
    selectShell: () => {},
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(definition, component) {
        if (definition.name === 'sidebar.right.pane.tab') paneRegs.push({ definition, component });
        return () => {};
      },
    },
    sidebarRight: { openTab: () => {} },
    sidebarRightTabs: { register: () => () => {} },
    webTerminals,
  };
  return { ctx, paneRegs, effects };
}

const requireStub = (name) => {
  if (name === 'react') return { createElement: () => ({}) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  return {};
};

describe('client apply 幂等性（插件热更新）', () => {
  it('连续 apply 两次后，SSH 面板仍拿到完整列表', async () => {
    const { ctx, paneRegs } = makeCtx();
    const plugin = loaded.factory(requireStub);

    plugin.apply(ctx); // 正常加载
    plugin.apply(ctx); // 模拟 HMR：同一个 ctx 上再跑一次 apply

    const loadShells = paneRegs.at(-1).definition.inject('session-1').loadShells;
    const result = await loadShells(undefined);

    const names = result.shells.map((shell) => shell.name);
    assert.ok(names.includes('SSH alpha'), `面板丢了主机启动器：${names.join(',')}`);
    assert.ok(names.includes('SSH 新建会话'), `面板丢了新建会话：${names.join(',')}`);
    assert.ok(names.includes('bash'), '本地 shell 也要保留');
  });

  it('原生终端下拉仍然只看到本地 shell', async () => {
    const { ctx } = makeCtx();
    const plugin = loaded.factory(requireStub);
    plugin.apply(ctx);

    const visible = await ctx.webTerminals.launchShells('session-1');
    const names = visible.shells.map((shell) => shell.name);
    assert.deepEqual(names, ['bash']);
    assert.equal(visible.selectedShell, '/bin/bash');
  });

  it('dispose 后还原原生 launchShells', async () => {
    const { ctx, effects } = makeCtx();
    const plugin = loaded.factory(requireStub);
    plugin.apply(ctx);
    const patched = ctx.webTerminals.launchShells;
    for (const dispose of effects) dispose();
    assert.notEqual(ctx.webTerminals.launchShells, patched);
    const visible = await ctx.webTerminals.launchShells('session-1');
    assert.equal(visible.shells.length, BASE_SHELLS.length);
  });
});
