/**
 * 设置页（插件行配置）客户端注册：只有宿主服务了本插件的 settings 命名空间、
 * 且部署里有 configForms 服务时才注册；没有时不能影响终端功能。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-settings-client-'));

/** client.js 是手写 bundle：用假 ModuleLoader 把它 load 出来拿内部导出的 apply。 */
function loadClient() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  globalThis.document = {
    querySelector: () => ({ tag: true }),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  // 只取 factory 的返回对象；require 提供 client 用到的模块
  const require = (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Button: function Button() {},
        IconGlobeOutlineRegular: function Icon() {},
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  return captured.factory(require);
}

function makeContext({ withConfigForms = true } = {}) {
  const registrations = [];
  const effects = [];
  let whileServedCalls = 0;
  const slots = {
    inject(_name, register) {
      return register();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { hosts: '' }, revision: 3, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
    dispose() {},
  };
  const configForms = withConfigForms
    ? {
        get(namespace) {
          assert.equal(namespace, 'dsh-remote-console');
          return form;
        },
        whileServed(namespaces, register) {
          whileServedCalls += 1;
          assert.deepEqual(namespaces, ['dsh-remote-console']);
          const disposer = register(new Set(namespaces));
          return () => {
            if (typeof disposer === 'function') disposer();
          };
        },
      }
    : undefined;
  const ctx = {
    get: (name) => (name === 'configForms' ? configForms : undefined),
    effect: (factory) => {
      const disposer = factory();
      effects.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    slots,
    sidebarRight: { openTab: () => {} },
    sidebarRightTabs: { register: () => () => {} },
    webTerminals: {
      launchShells: async () => ({ shells: [], selectedShell: undefined }),
      selectShell: () => {},
    },
  };
  return { ctx, registrations, effects, whileServed: () => whileServedCalls };
}

describe('设置页注册（客户端）', () => {
  it('有 configForms 时注册 plugins.row.config 页面，key 为 包名#行 id', () => {
    const client = loadClient();
    const { ctx, registrations, whileServed } = makeContext();
    client.apply(ctx);
    const page = registrations.find((entry) => entry.options.name === 'plugins.row.config');
    assert.ok(page, '应注册 plugins.row.config');
    assert.equal(page.options.key, 'dsh-remote-console#dsh-remote-console');
    assert.equal(page.options.order, 60);
    assert.equal(typeof page.component, 'function');
    assert.equal(whileServed(), 1);
    const props = page.options.inject();
    assert.equal(typeof props.form.mutate, 'function');
  });

  it('没有 configForms 的部署不注册也不报错', () => {
    const client = loadClient();
    const { ctx, registrations } = makeContext({ withConfigForms: false });
    assert.doesNotThrow(() => client.apply(ctx));
    assert.equal(registrations.filter((entry) => entry.options.name === 'plugins.row.config').length, 0);
  });

  it('版本号与 package.json 一致（设置页不绕过发版检查）', () => {
    const client = loadClient();
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    assert.equal(client.__testing?.PLUGIN_VERSION, pkg.version);
  });
});
