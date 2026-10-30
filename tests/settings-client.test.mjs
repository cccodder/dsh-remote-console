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
  let disposeCalls = 0;
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
    dispose() {
      disposeCalls += 1;
    },
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
  return { ctx, registrations, effects, injected, form, disposeCalls: () => disposeCalls, whileServed: () => whileServedCalls };
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
    assert.deepEqual(
      injected,
      [['remote', 'remote.settings'], ['remote', 'remote.pluginManager'], ['configForms']],
      '应该分别等待 remote.settings / remote.pluginManager 命名空间服务，而不是只等 remote',
    );
    const props = page.options.inject();
    assert.equal(typeof props.form.mutate, 'function');
  });

  it('插件重载不 dispose configForms 的共享 form（回归：重载后设置页保存必失败）', () => {
    const client = loadClient();
    const { ctx, effects, registrations, form, disposeCalls } = makeContext();
    client.apply(ctx);
    assert.equal(disposeCalls(), 0, '挂载设置页时不能 dispose 宿主共享的 form');

    // 模拟「插件行禁用再启用」：先执行本插件注册的所有 effect 清理（客户端插件卸载），再 apply 一次（重载）
    for (const dispose of effects) {
      if (typeof dispose === 'function') dispose();
    }
    assert.equal(disposeCalls(), 0, '卸载插件时不能 dispose 宿主共享的 form——它由 configForms 缓存复用');
    assert.doesNotThrow(() => client.apply(ctx));

    const page = registrations.filter((entry) => entry.options.name === 'plugins.row.config').at(-1);
    assert.ok(page, '重载后应重新注册设置页');
    const props = page.options.inject();
    assert.equal(props.form, form, '重载后拿到的应该是同一个仍然可用的 form');
    assert.equal(typeof props.form.mutate, 'function');
  });

  it('没有 configForms 的部署不注册也不报错', () => {
    const client = loadClient();
    const { ctx, registrations, injected } = makeContext({ withConfigForms: false });
    assert.doesNotThrow(() => client.apply(ctx));
    assert.equal(registrations.filter((entry) => entry.options.name === 'plugins.row.config').length, 0);
    // 仍然会声明可选依赖，只是服务不出现时回调不执行
    assert.deepEqual(injected, [['remote', 'remote.settings'], ['remote', 'remote.pluginManager'], ['configForms']]);
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
    // mutate 三次都失败、没有 set 兜底时，返回明确失败，并且诊断里必须带原因（不能是空的）
    assert.deepEqual(await saveHosts(alwaysFails, ['nas']), {
      ok: false,
      attempts: 3,
      mode: 'mutate',
      error: 'mutate 返回 false（DSH 没有接受写入）',
    });
    assert.equal(fails, 3);

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

    // set 返回 false 时也要留下原因，供设置页诊断串展示（之前诊断串结尾是空的）
    const setFails = { mutate: async () => false, set: async () => false };
    const failedSet = await saveHosts(setFails, ['nas']);
    assert.equal(failedSet.ok, false);
    assert.match(String(failedSet.error), /set 返回 false/u);

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

  it('更新：按安装来源决定查询方式（对齐 ds-bot）', () => {
    const client = loadClient();
    const { sourceOf } = client.__testing;
    assert.equal(sourceOf('dsh-remote-console').kind, 'registry');
    assert.equal(sourceOf('dsh-remote-console@^0.10.5').kind, 'registry');
    assert.equal(sourceOf('link:/tmp/rc').kind, 'path');
    assert.equal(sourceOf('/data/work/rc').kind, 'path');
    assert.equal(sourceOf('file:../rc').kind, 'path');
    assert.equal(sourceOf('https://example.com/rc.tgz').kind, 'tarball');
    assert.equal(sourceOf('').kind, 'unknown');
    const git = sourceOf('github:cccodder/dsh-remote-console#v0.10.5');
    assert.equal(git.kind, 'git');
    assert.equal(git.ref, 'v0.10.5');
    assert.equal(sourceOf('git@github.com:cccodder/dsh-remote-console.git').kind, 'git');
  });

  it('更新：registry 顺序跟随 DSH/pnpm 配置，镜像优先（对齐 ds-bot）', async () => {
    const client = loadClient();
    const { registryPlan } = client.__testing;
    assert.deepEqual(await registryPlan(undefined), ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']);
    assert.deepEqual(
      await registryPlan({
        registries: async () => ({
          registry: 'https://registry.npmmirror.com',
          fallbackRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
          resolved: null,
        }),
      }),
      ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/'],
    );
    // 私有 registry：只问它，不把包名泄露给公共 registry
    assert.deepEqual(
      await registryPlan({
        registries: async () => ({ registry: 'https://npm.corp.example/', fallbackRegistries: [], resolved: null }),
      }),
      ['https://npm.corp.example/'],
    );
  });

  it('一键热更新：先直接安装（非 HMR 部署可原地升级），成功不卸载', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const calls = [];
    const manager = {
      removeBundle: async (name) => {
        calls.push(['remove', name]);
        return { application: 'applied' };
      },
      installBundle: async (spec, options) => {
        calls.push(['install', spec, options]);
        return { changed: true, application: 'applied', stage: 'install', target: spec };
      },
    };
    assert.deepEqual(await runHotUpdate(manager, { spec: 'dsh-remote-console@0.10.6' }, '0.10.5'), {
      ok: true,
      application: 'applied',
    });
    assert.deepEqual(calls, [['install', 'dsh-remote-console@0.10.6', { saveExact: true }]]);
  });

  it('一键热更新：HMR 拒绝 already-installed 时退成 卸载 → 安装', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const calls = [];
    let installs = 0;
    const manager = {
      removeBundle: async (name) => {
        calls.push(['remove', name]);
        return { application: 'applied' };
      },
      installBundle: async (spec, options) => {
        calls.push(['install', spec, options]);
        installs += 1;
        if (installs === 1) return { error: { code: 'already-installed', message: 'already installed' } };
        return { application: 'applied' };
      },
    };
    const result = await runHotUpdate(
      manager,
      { spec: 'dsh-remote-console@0.10.6', registry: 'https://registry.npmjs.org/' },
      '0.10.5',
    );
    assert.deepEqual(result, { ok: true, application: 'applied' });
    assert.deepEqual(calls, [
      ['install', 'dsh-remote-console@0.10.6', { saveExact: true, registry: 'https://registry.npmjs.org/' }],
      ['remove', 'dsh-remote-console'],
      ['install', 'dsh-remote-console@0.10.6', { saveExact: true, registry: 'https://registry.npmjs.org/' }],
    ]);
  });

  it('一键热更新：需要重启时如实上报 restart-required', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const manager = {
      removeBundle: async () => ({ application: 'applied' }),
      installBundle: async () => ({ application: 'restart-required', restartReason: 'bundle-structure' }),
    };
    const result = await runHotUpdate(manager, { spec: 'dsh-remote-console@0.10.6' }, '0.10.5');
    assert.equal(result.ok, true);
    assert.equal(result.application, 'restart-required');
    assert.equal(result.restartReason, 'bundle-structure');
  });

  it('一键热更新：新版本装失败时按当前版本回滚', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const installed = [];
    let installs = 0;
    const manager = {
      removeBundle: async () => ({ application: 'applied' }),
      installBundle: async (spec) => {
        installed.push(spec);
        installs += 1;
        if (installs === 1) return { error: { code: 'already-installed' } };
        if (installs === 2) return { application: 'failed', error: { message: 'registry 404' } };
        return { application: 'applied' };
      },
    };
    const result = await runHotUpdate(manager, { spec: 'dsh-remote-console@0.10.6' }, '0.10.5');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INSTALL_FAILED');
    assert.match(String(result.error), /registry 404/u);
    assert.equal(result.rollback, 'ok');
    assert.deepEqual(installed, ['dsh-remote-console@0.10.6', 'dsh-remote-console@0.10.6', 'dsh-remote-console@0.10.5']);
  });

  it('一键热更新：没有插件管理服务时明确拒绝，不瞎卸载', async () => {
    const client = loadClient();
    const { runHotUpdate } = client.__testing;
    const result = await runHotUpdate(undefined, { spec: 'dsh-remote-console@0.10.6' }, '0.10.5');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_PLUGIN_MANAGER');
  });

  it('版本号与 package.json 一致（设置页不绕过发版检查）', () => {
    const client = loadClient();
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    assert.equal(client.__testing?.PLUGIN_VERSION, pkg.version);
  });

  it('单文件传输上限：默认 256、夹在 1–2048，且与宿主侧常量一致', async () => {
    const client = loadClient();
    const { transferLimitMBFromValue, DEFAULT_MAX_TRANSFER_MB, MIN_MAX_TRANSFER_MB, MAX_MAX_TRANSFER_MB } =
      client.__testing;
    const host = (await import('../lib/index.js')).__testing;

    assert.equal(DEFAULT_MAX_TRANSFER_MB, host.DEFAULT_MAX_TRANSFER_MB);
    assert.equal(MIN_MAX_TRANSFER_MB, host.MIN_MAX_TRANSFER_MB);
    assert.equal(MAX_MAX_TRANSFER_MB, host.MAX_MAX_TRANSFER_MB);
    assert.equal(transferLimitMBFromValue(undefined), 256);
    assert.equal(transferLimitMBFromValue('512'), 512);
    assert.equal(transferLimitMBFromValue(12.4), 12);
    assert.equal(transferLimitMBFromValue(9999), 2048);
    assert.equal(transferLimitMBFromValue(0), 1);
    assert.equal(transferLimitMBFromValue('abc'), 256);
  });

  it('有 settings 服务时直连写入：每轮现读 revision，冲突自动重试', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;
    const revisions = [];
    let describedCount = 0;
    let attempt = 0;
    const settings = {
      describe: async () => {
        describedCount += 1;
        return { ok: true, value: { namespaces: [{ ns: 'dsh-remote-console', revision: 9 + describedCount }] } };
      },
      mutate: async (ns, ops, revision) => {
        attempt += 1;
        revisions.push([ns, revision]);
        assert.deepEqual(ops, [
          { op: 'set', path: ['hosts'], value: 'nas' },
          { op: 'set', path: ['maxTransferMB'], value: 512 },
        ]);
        if (attempt === 1) {
          return {
            ok: false,
            error: { message: 'settings namespace "dsh-remote-console" changed since it was read (expected revision 10, now 11)' },
          };
        }
        return { ok: true, value: { revision: 12 } };
      },
    };
    const result = await saveHosts({ mutate: async () => false }, ['nas'], undefined, 512, { settings: () => settings });
    assert.deepEqual(result, { ok: true, attempts: 2, mode: 'settings' });
    assert.deepEqual(revisions, [
      ['dsh-remote-console', 10],
      ['dsh-remote-console', 11],
    ]);
  });

  it('settings 服务的非冲突错误不重试，并返回错误原文（用于界面诊断）', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;
    let calls = 0;
    const settings = {
      describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'dsh-remote-console', revision: 3 }] } }),
      mutate: async () => {
        calls += 1;
        return { ok: false, error: { message: 'Config field "maxTransferMB" is not volatile' } };
      },
    };
    const result = await saveHosts({ mutate: async () => false }, ['nas'], undefined, 512, { settings: () => settings });
    assert.equal(result.ok, false);
    assert.equal(result.mode, 'settings');
    assert.equal(calls, 1, '非冲突错误重试也不会变，只应调用一次');
    assert.match(String(result.error), /not volatile/u);
  });

  it('没有 settings 服务时把 io.revision 现读的修订号传给写入', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;
    const seen = [];
    const form = {
      mutate: async (ops, revision) => {
        seen.push(revision);
        return true;
      },
    };
    const result = await saveHosts(form, ['nas'], undefined, undefined, { revision: () => 7 });
    assert.deepEqual(result, { ok: true, attempts: 1, mode: 'mutate' });
    assert.deepEqual(seen, [7]);
  });

  it('整体写入失败时退一步只写主机，并把「上限没写进去」标成 warning 而不是失败', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;
    const form = {
      mutate: async () => false,
      set: async (field) => field === 'hosts',
    };
    const result = await saveHosts(form, ['nas'], undefined, 512);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'set');
    assert.match(String(result.warning), /上限没有写进去/u);
  });

  it('保存主机时一起写单文件传输上限（mutate 一条批次、set 兜底逐字段）', async () => {
    const client = loadClient();
    const { saveHosts } = client.__testing;

    const batches = [];
    const form = {
      mutate: async (ops) => {
        batches.push(ops);
        return true;
      },
    };
    assert.deepEqual(await saveHosts(form, ['nas'], undefined, 512), {
      ok: true,
      attempts: 1,
      mode: 'mutate',
    });
    assert.deepEqual(batches, [
      [
        { op: 'set', path: ['hosts'], value: 'nas' },
        { op: 'set', path: ['maxTransferMB'], value: 512 },
      ],
    ]);

    // 不传上限时保持旧行为：只写 hosts（老调用方/测试不受影响）
    batches.length = 0;
    await saveHosts(form, ['nas']);
    assert.deepEqual(batches, [[{ op: 'set', path: ['hosts'], value: 'nas' }]]);

    const sets = [];
    const setForm = {
      mutate: async () => false,
      set: async (field, value) => {
        sets.push([field, value]);
        return true;
      },
    };
    assert.deepEqual(await saveHosts(setForm, ['nas'], undefined, 64), { ok: true, attempts: 3, mode: 'set' });
    assert.deepEqual(sets, [
      ['hosts', 'nas'],
      ['maxTransferMB', 64],
    ]);
  });
});

describe('更新后自检（客户端）', () => {
  /** 浏览器存储的假实现；测完要删掉，避免影响其它用例。 */
  function withFakeStorage(run) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
    try {
      return run(store);
    } finally {
      delete globalThis.localStorage;
    }
  }

  it('点更新前记下目标版本，读回来一致，清掉后为空', () => {
    withFakeStorage((store) => {
      const client = loadClient();
      const { writePendingUpdate, readPendingUpdate, clearPendingUpdate } = client.__testing;
      assert.equal(readPendingUpdate(), undefined);
      writePendingUpdate('v0.10.5');
      const pending = readPendingUpdate();
      assert.equal(pending.version, 'v0.10.5');
      assert.ok(Number.isFinite(pending.at));
      assert.equal(store.size, 1);
      clearPendingUpdate();
      assert.equal(readPendingUpdate(), undefined);
      assert.equal(store.size, 0);
    });
  });

  it('没有 localStorage 时不抛错（浏览器禁用存储）', () => {
    const client = loadClient();
    const { writePendingUpdate, readPendingUpdate, clearPendingUpdate } = client.__testing;
    assert.doesNotThrow(() => writePendingUpdate('0.10.5'));
    assert.doesNotThrow(() => clearPendingUpdate());
    assert.equal(readPendingUpdate(), undefined);
  });

  it('自检结果：真的换掉了 / 还在跑旧 bundle / 过期标记', () => {
    const client = loadClient();
    const { pendingUpdateState } = client.__testing;
    const now = Date.now();
    assert.deepEqual(pendingUpdateState(undefined, '0.10.4', now), { status: 'none' });
    // 刷新后加载到目标版本 → 热更真的生效
    assert.deepEqual(pendingUpdateState({ version: 'v0.10.5', at: now - 1000 }, '0.10.5', now), {
      status: 'applied',
      version: 'v0.10.5',
    });
    // 刷新后还是旧版本 → 客户端 bundle 没热换，需要重启
    assert.deepEqual(pendingUpdateState({ version: '0.10.5', at: now - 1000 }, '0.10.4', now), {
      status: 'restart-required',
      version: '0.10.5',
    });
    // 15 分钟后再打开设置页不再翻旧账
    assert.deepEqual(pendingUpdateState({ version: '0.10.5', at: now - 16 * 60 * 1000 }, '0.10.4', now), {
      status: 'stale',
    });
    // 坏数据/无法解析的版本号当没有标记
    assert.deepEqual(pendingUpdateState({ version: 'latest', at: now }, '0.10.4', now), { status: 'none' });
    assert.deepEqual(pendingUpdateState({ version: '0.10.5', at: 'x' }, '0.10.4', now), { status: 'stale' });
  });

  it('版本相等判断接受 v 前缀', () => {
    const client = loadClient();
    const { sameVersion } = client.__testing;
    assert.equal(sameVersion('v0.10.5', '0.10.5'), true);
    assert.equal(sameVersion('0.10.5', '0.10.4'), false);
    assert.equal(sameVersion('latest', '0.10.5'), false);
  });
});
