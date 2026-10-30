/**
 * 一键热更新：plugin-manager 的返回同样是 `{ ok, value }` 包膜。
 * 0.10.8 的 bug 是只读顶层字段，`value.error.code === 'already-installed'` 被当成成功，
 * 于是写 pending 标记 + 刷新页面，实际什么都没装（静默失败）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-hot-update-'));

function loadClient() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  let captured;
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
  globalThis.document = {
    querySelector: () => ({ tag: true }),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  const require = (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Button: function Button() {}, IconGlobeOutlineRegular: function Icon() {} };
    }
    throw new Error(`unexpected require: ${name}`);
  };
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  return captured.factory(require);
}

const PACKAGE = 'dsh-remote-console';
const plan = (version) => ({ spec: `${PACKAGE}@${version}`, currentSpec: `${PACKAGE}@0.10.8` });

/** 带 listBundles 的假管理器：ver 表示当前安装版本。 */
function managerWith({ onInstall, onRemove, ver = '0.10.8', bundles }) {
  const state = { installed: ver };
  const calls = [];
  return {
    calls,
    manager: {
      installBundle: async (spec, options) => {
        calls.push(['install', spec, options]);
        const result = await (onInstall ?? (async () => ({ ok: true, value: { application: 'applied' } })))(spec);
        if (result !== undefined) return result;
        state.installed = spec.split('@')[1];
        return { ok: true, value: { application: 'applied' } };
      },
      removeBundle: async (name) => {
        calls.push(['remove', name]);
        const result = await (onRemove ?? (async () => ({ ok: true, value: { application: 'applied' } })))();
        if (result !== undefined) return result;
        state.installed = undefined;
        return { ok: true, value: { application: 'applied' } };
      },
      listBundles: async () => ({
        ok: true,
        value: bundles ?? [{ name: PACKAGE, version: state.installed ?? '0.10.8' }],
      }),
    },
  };
}

describe('一键热更新的 manager 返回值（{ok,value} 包膜）', () => {
  it('already-installed 在包膜里时退成 卸载 → 安装，并确认版本', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    let first = true;
    const { manager, calls } = managerWith({
      onInstall: async (spec) => {
        if (first) {
          first = false;
          return { ok: true, value: { application: 'failed', error: { code: 'already-installed' } } };
        }
        return { ok: true, value: { application: 'applied' } };
      },
      onRemove: async () => ({ ok: true, value: { application: 'applied' } }),
    });
    // listBundles 反映真实安装结果：remove 后再 install，版本变 0.10.10
    let removed = false;
    manager.removeBundle = async (name) => {
      calls.push(['remove', name]);
      removed = true;
      return { ok: true, value: { application: 'applied' } };
    };
    manager.installBundle = async (spec, options) => {
      calls.push(['install', spec, options]);
      if (first) {
        first = false;
        return { ok: true, value: { application: 'failed', error: { code: 'already-installed' } } };
      }
      return { ok: true, value: { application: 'applied' } };
    };
    manager.listBundles = async () => ({ ok: true, value: [{ name: PACKAGE, version: removed ? '0.10.10' : '0.10.8' }] });

    const result = await runHotUpdate(manager, plan('0.10.10'), '0.10.8');
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([kind]) => kind), ['install', 'remove', 'install']);
  });

  it('ok:false 包膜算失败，并带出真实错误', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const { manager } = managerWith({
      onInstall: async () => ({ ok: false, error: { message: 'registry 不可达' } }),
    });
    const result = await runHotUpdate(manager, plan('0.10.10'), '0.10.8');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INSTALL_FAILED');
    assert.match(String(result.error), /registry 不可达/u);
  });

  it('安装返回成功但管理器报告版本没变 → INSTALL_UNCONFIRMED（不再假成功）', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const { manager } = managerWith({ bundles: [{ name: PACKAGE, version: '0.10.8' }] });
    const result = await runHotUpdate(manager, plan('0.10.10'), '0.10.8');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INSTALL_UNCONFIRMED');
    assert.match(String(result.error), /0\.10\.10/u);
  });

  it('不带包膜的老返回值仍然可用', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const manager = {
      installBundle: async () => ({ application: 'applied' }),
      removeBundle: async () => ({ application: 'applied' }),
      listBundles: async () => [{ name: PACKAGE, version: '0.10.10' }],
    };
    const result = await runHotUpdate(manager, plan('0.10.10'), '0.10.8');
    assert.equal(result.ok, true);
  });

  it('卸载失败时带上包膜里的错误原文', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const { manager } = managerWith({
      onInstall: async () => ({ ok: true, value: { application: 'failed', error: { code: 'already-installed' } } }),
      onRemove: async () => ({ ok: true, value: { application: 'failed', error: { message: 'bundle in use' } } }),
    });
    const result = await runHotUpdate(manager, plan('0.10.10'), '0.10.8');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REMOVE_FAILED');
    assert.match(String(result.error), /bundle in use/u);
  });
});
