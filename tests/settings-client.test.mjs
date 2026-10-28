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
  const injected = [];
  const ctx = {
    get: (name) => (name === 'configForms' ? configForms : undefined),
    // cordis 的可选依赖：服务可用时回调；不可用时不回调（测试里用它模拟加载顺序）
    inject(deps, callback) {
      injected.push([...deps]);
      if (configForms !== undefined && deps.includes('configForms')) callback(ctx);
      return () => {};
    },
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
  return { ctx, registrations, effects, injected, whileServed: () => whileServedCalls };
}

describe('设置页注册（客户端）', () => {
  it('有 configForms 时注册 plugins.row.config 页面，key 为 包名#行 id', () => {
    const client = loadClient();
    const { ctx, registrations, whileServed, injected } = makeContext();
    client.apply(ctx);
    const page = registrations.find((entry) => entry.options.name === 'plugins.row.config');
    assert.ok(page, '应注册 plugins.row.config');
    assert.equal(page.options.key, 'dsh-remote-console#dsh-remote-console');
    assert.equal(page.options.order, 60);
    assert.equal(typeof page.component, 'function');

    // 包详情页顶部也挂一份，用户更容易找到
    const bundle = registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
    assert.ok(bundle, '应注册 plugins.bundle.config');
    assert.equal(bundle.options.key, 'dsh-remote-console');
    assert.equal(typeof bundle.component, 'function');
    assert.equal(whileServed(), 1);
    assert.deepEqual(injected, [['configForms']], '应该通过 ctx.inject 等待设置服务');
    const props = page.options.inject();
    assert.equal(typeof props.form.mutate, 'function');
  });

  it('没有 configForms 的部署不注册也不报错', () => {
    const client = loadClient();
    const { ctx, registrations, injected } = makeContext({ withConfigForms: false });
    assert.doesNotThrow(() => client.apply(ctx));
    assert.equal(registrations.filter((entry) => entry.options.name === 'plugins.row.config').length, 0);
    // 仍然会声明可选依赖，只是服务不出现时回调不执行
    assert.deepEqual(injected, [['configForms']]);
  });

  it('主机行解析：保留注释、去空行、拼接可逆', () => {
    const client = loadClient();
    const { hostsLinesFromValue, hostsValueFromLines } = client.__testing;
    assert.deepEqual(hostsLinesFromValue('nas\n\n  ops@10.0.0.5:22  \n# 注释\n'), [
      'nas',
      'ops@10.0.0.5:22',
      '# 注释',
    ]);
    assert.equal(hostsValueFromLines(['nas', 'ops@10.0.0.5:22']), 'nas\nops@10.0.0.5:22');
    assert.deepEqual(hostsLinesFromValue(undefined), []);
  });

  it('保存：第一次被拒会重试一次，且不传 expectedRevision', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;
    let calls = 0;
    const secondWorks = {
      mutate: async () => {
        calls += 1;
        return calls === 2;
      },
    };
    assert.deepEqual(await saveHosts(secondWorks, ['nas']), { ok: true, attempts: 2, mode: 'mutate' });
    assert.equal(calls, 2);

    let fails = 0;
    const alwaysFails = {
      mutate: async () => {
        fails += 1;
        return false;
      },
    };
    // mutate 两次都失败、没有 set 兜底时，返回明确失败
    assert.deepEqual(await saveHosts(alwaysFails, ['nas']), { ok: false, attempts: 2, mode: 'mutate' });
    assert.equal(fails, 2);

    // 有 set 时用它兜底（单字段写入走另一条路径）
    let setCalls = 0;
    const withSet = {
      mutate: async () => false,
      set: async (field, value) => {
        setCalls += 1;
        assert.equal(field, 'hosts');
        assert.equal(value, 'nas');
        return true;
      },
    };
    assert.deepEqual(await saveHosts(withSet, ['nas']), { ok: true, attempts: 3, mode: 'set' });
    assert.equal(setCalls, 1);

    const revisions = [];
    await saveHosts(
      {
        mutate: async (ops, revision) => {
          revisions.push(revision);
          return true;
        },
      },
      ['nas'],
    );
    assert.deepEqual(revisions, [undefined], '不传 expectedRevision，由服务端用最新修订号');

    // 每次尝试前都刷新快照：失败两次时会刷新两次（+ set 兜底前一次）
    let refreshCalls = 0;
    await saveHosts(
      { mutate: async () => false },
      ['nas'],
      async () => {
        refreshCalls += 1;
      },
    );
    assert.ok(refreshCalls >= 2, `失败重试前应刷新快照，实际 ${refreshCalls} 次`);
  });

  it('版本号与 package.json 一致（设置页不绕过发版检查）', () => {
    const client = loadClient();
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    assert.equal(client.__testing?.PLUGIN_VERSION, pkg.version);
  });
});
