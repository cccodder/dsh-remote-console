/**
 * 更新检查的缓存与安装来源识别。
 *
 * 背景（0.10.6 真机问题）：
 *  - 查询失败（超时/不可达）也被写进 10 分钟缓存，网络恢复后还在显示失败；
 *  - 插件管理器比设置页晚挂上时读到 unknown，同样被缓存，CLI 安装的用户就再也看不到更新入口。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-update-'));

const PACKAGE = 'dsh-remote-console';
const CACHE_KEY = 'dsh-remote-console.update-check.v2';

/** client.js 是手写 bundle：用假 ModuleLoader 把它 load 出来拿内部函数。 */
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

/** 假浏览器存储 + 假 fetch；测完还原全局，避免互相影响。 */
async function withEnv(run, { fetchImpl } = {}) {
  const store = new Map();
  const prevStorage = globalThis.localStorage;
  const prevFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.fetch = fetchImpl ?? (async () => ({ ok: true, json: async () => ({ version: '0.10.7' }) }));
  try {
    return await run(store);
  } finally {
    globalThis.localStorage = prevStorage;
    globalThis.fetch = prevFetch;
  }
}

const bundlesWith = (source) => ({ listBundles: async () => [{ name: PACKAGE, source }] });

describe('更新检查的缓存（只有结论才写）', () => {
  it('查询失败（超时/不可达）不写缓存，下次会重新查', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    let calls = 0;
    await withEnv(
      async (store) => {
        const manager = bundlesWith(`${PACKAGE}@0.10.6`);
        const first = await checkForUpdate(manager);
        assert.equal(first.source, 'registry');
        assert.equal(first.latest, undefined, '没查到就没有 latest');
        assert.equal(store.size, 0, '失败不能写缓存');
        const second = await checkForUpdate(manager);
        assert.equal(second.source, 'registry');
        assert.ok(calls >= 4, `两次检查都应真的发请求，实际 fetch ${calls} 次`);
      },
      {
        fetchImpl: async () => {
          calls += 1;
          throw new Error('The operation was aborted due to timeout');
        },
      },
    );
  });

  it('缓存里没有 definitive 标记的条目被忽略（旧版本的毒缓存）', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    let calls = 0;
    await withEnv(
      async (store) => {
        store.set(CACHE_KEY, JSON.stringify({ source: 'unknown', at: Date.now() }));
        const result = await checkForUpdate(bundlesWith(`${PACKAGE}@0.10.6`));
        assert.equal(result.source, 'registry', '不能被旧条目带偏');
        assert.equal(result.latest, '0.10.7');
        assert.equal(calls, 1);
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => ({ version: '0.10.7' }) };
        },
      },
    );
  });

  it('拿到结果才写缓存，第二次直接复用不再发请求', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    let calls = 0;
    await withEnv(
      async (store) => {
        const manager = bundlesWith(`${PACKAGE}@0.10.6`);
        const first = await checkForUpdate(manager);
        assert.equal(first.latest, '0.10.7');
        const cached = JSON.parse(store.get(CACHE_KEY));
        assert.equal(cached.definitive, true);
        assert.equal(cached.latest, '0.10.7');
        const before = calls;
        const second = await checkForUpdate(manager);
        assert.equal(second.latest, '0.10.7');
        assert.equal(calls, before, '命中缓存后不应再发请求');
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => ({ version: '0.10.7' }) };
        },
      },
    );
  });

  it('本地目录 / link 安装：结论可缓存，且不发网络请求', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    let calls = 0;
    await withEnv(
      async (store) => {
        const result = await checkForUpdate(bundlesWith('link:/tmp/dev/dsh-remote-console'));
        assert.equal(result.source, 'path');
        assert.equal(calls, 0);
        assert.equal(JSON.parse(store.get(CACHE_KEY)).definitive, true);
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => ({ version: '0.10.7' }) };
        },
      },
    );
  });

  it('读不到插件管理器时不写缓存', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    await withEnv(async (store) => {
      const result = await checkForUpdate(undefined);
      assert.equal(result.source, 'no-manager');
      assert.equal(store.size, 0, 'no-manager 是确定结论但也不缓存（以后装了管理器要能立刻生效）');
    });
  });
});

describe('安装来源识别', () => {
  it('管理器晚挂上：第一次读不到时重试一次能读到', async () => {
    const client = loadClient();
    const { installSpecOf } = client.__testing;
    let calls = 0;
    const manager = {
      listBundles: async () => {
        calls += 1;
        return calls === 1 ? [] : [{ name: PACKAGE, source: `${PACKAGE}@0.10.6` }];
      },
    };
    const spec = await installSpecOf(manager, { retryMs: 5 });
    assert.equal(spec, `${PACKAGE}@0.10.6`);
    assert.equal(calls, 2);
  });

  it('一直读不到就返回 undefined，不瞎猜来源', async () => {
    const client = loadClient();
    const { installSpecOf } = client.__testing;
    const manager = { listBundles: async () => [] };
    assert.equal(await installSpecOf(manager, { retryMs: 5 }), undefined);
  });
});

/** 让 useEffect 真的执行：专门抓「effect 里调用了不存在的函数」这类首开崩溃。 */
function loadClientWithEffects() {
  const effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (factory) => {
      const cleanup = factory();
      if (typeof cleanup === 'function') effects.push(cleanup);
    },
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
  const client = captured.factory(require);
  client.__cleanups = effects;
  return client;
}

describe('侧栏面板首开（回归：fetchLatestRelease 被删但仍在调用）', () => {
  it('全新浏览器首开面板不抛异常，提示写进独立缓存', async () => {
    let calls = 0;
    await withEnv(
      async (store) => {
        const client = loadClientWithEffects();
        assert.equal(typeof client.__testing.fetchLatestRelease, 'function', '面板调用的函数必须存在');
        // 以前这里会直接 ReferenceError：整块「SSH 远程」面板空白
        assert.doesNotThrow(() => client.__testing.HostList({ loadShells: async () => ({ shells: [] }), connect: () => {} }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(calls, 1);
        const cached = JSON.parse(store.get('dsh-remote-console.panel-update.v1'));
        assert.equal(cached.tag, '0.10.7');
        for (const cleanup of client.__cleanups) cleanup();
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return {
            ok: true,
            json: async () => ({
              tag_name: 'v0.10.7',
              html_url: 'https://github.com/cccodder/dsh-remote-console/releases/tag/v0.10.7',
            }),
          };
        },
      },
    );
  });

  it('离线/限流时静默失败，不写缓存', async () => {
    await withEnv(
      async (store) => {
        const client = loadClientWithEffects();
        const info = await client.__testing.fetchLatestRelease();
        assert.equal(info, undefined);
        assert.equal(store.size, 0);
        for (const cleanup of client.__cleanups) cleanup();
      },
      {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      },
    );
  });

  it('面板缓存 30 分钟后过期', async () => {
    const client = loadClient();
    const { readPanelHint, writePanelHint } = client.__testing;
    await withEnv(async () => {
      writePanelHint({ tag: '0.10.7', url: 'https://example.invalid', at: Date.now() });
      assert.equal(readPanelHint().tag, '0.10.7');
      writePanelHint({ tag: '0.10.7', url: 'https://example.invalid', at: Date.now() - 31 * 60 * 1000 });
      assert.equal(readPanelHint(), undefined);
    });
  });
});


describe('安装来源：Remote 返回 {ok, value} 包膜（0.10.6/0.10.7 的真 bug）', () => {
  it('包膜解包后能拿到 source，更新检查正常工作', async () => {
    const client = loadClient();
    const { checkForUpdate, readInstallSpec } = client.__testing;
    let calls = 0;
    await withEnv(
      async (store) => {
        const manager = {
          listBundles: async () => ({ ok: true, value: [{ name: PACKAGE, version: '0.10.7', source: `${PACKAGE}@0.10.7` }] }),
        };
        assert.deepEqual(await readInstallSpec(manager, { retryMs: 5 }), { status: 'ok', spec: `${PACKAGE}@0.10.7` });
        const result = await checkForUpdate(manager);
        assert.equal(result.source, 'registry');
        assert.equal(result.latest, '0.10.8');
        assert.equal(calls, 1);
        assert.equal(JSON.parse(store.get(CACHE_KEY)).definitive, true);
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => ({ version: '0.10.8' }) };
        },
      },
    );
  });

  it('source 缺失但有 version 时按 registry 处理', async () => {
    const client = loadClient();
    const { readInstallSpec } = client.__testing;
    const manager = { listBundles: async () => ({ ok: true, value: [{ name: PACKAGE, version: '0.10.7' }] }) };
    assert.deepEqual(await readInstallSpec(manager, { retryMs: 5 }), { status: 'ok', spec: `${PACKAGE}@0.10.7` });
  });

  it('管理器返回 ok:false → read-failed，页面提示可重试、且不写缓存', async () => {
    const client = loadClient();
    const { checkForUpdate } = client.__testing;
    await withEnv(async (store) => {
      const manager = { listBundles: async () => ({ ok: false, error: { message: 'denied' } }) };
      const result = await checkForUpdate(manager);
      assert.equal(result.source, 'unreadable');
      assert.equal(store.size, 0);
    });
  });

  it('没有管理器 → no-manager（确定结论：只能手动更新）', async () => {
    const client = loadClient();
    const { readInstallSpec } = client.__testing;
    assert.deepEqual(await readInstallSpec(undefined), { status: 'no-manager' });
    assert.deepEqual(await readInstallSpec(null), { status: 'no-manager' });
  });
});


describe('registryPlan 的 Remote 包膜', () => {
  it('{ok,value} 包膜里的 resolved 会被采用（本地/镜像 registry）', async () => {
    const client = loadClient();
    const { registryPlan } = client.__testing;
    const plan = await registryPlan({
      registries: async () => ({ ok: true, value: { registry: null, resolved: 'http://127.0.0.1:4873/' } }),
    });
    assert.equal(plan[0], 'http://127.0.0.1:4873/');
  });

  it('ok:false 时回退官方 registry', async () => {
    const client = loadClient();
    const { registryPlan } = client.__testing;
    const plan = await registryPlan({ registries: async () => ({ ok: false, error: { message: 'nope' } }) });
    assert.deepEqual(plan, ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']);
  });

  it('裸返回值（老版本）仍然可用', async () => {
    const client = loadClient();
    const { registryPlan } = client.__testing;
    const plan = await registryPlan({ registries: async () => ({ registry: 'http://127.0.0.1:4874/' }) });
    assert.equal(plan[0], 'http://127.0.0.1:4874/');
  });
});


describe('更新失败/中断的提示（组件被销毁后仍留得住）', () => {
  it('失败的更新状态会落盘，刷新后能读出来并给出原因', async () => {
    const client = loadClient();
    const { writeUpdateAttempt, readUpdateAttempt, updateAttemptNotice, clearUpdateAttempt } = client.__testing;
    await withEnv(async () => {
      writeUpdateAttempt({ phase: 'failed', target: '0.10.10', error: 'registry 404' });
      const attempt = readUpdateAttempt();
      assert.equal(attempt.phase, 'failed');
      const notice = updateAttemptNotice(attempt, '0.10.9');
      assert.equal(notice.status, 'failed');
      assert.match(String(notice.error), /404/u);
      clearUpdateAttempt();
      assert.equal(readUpdateAttempt(), undefined);
    });
  });

  it('长时间停在 installing 且版本没变 → 中断提示', async () => {
    const client = loadClient();
    const { updateAttemptNotice } = client.__testing;
    const now = Date.now();
    assert.equal(
      updateAttemptNotice({ phase: 'installing', target: '0.10.10', at: now - 120 * 1000 }, '0.10.9', now).status,
      'interrupted',
    );
    // 刚点下去 10 秒内不打扰
    assert.equal(
      updateAttemptNotice({ phase: 'installing', target: '0.10.10', at: now - 10 * 1000 }, '0.10.9', now).status,
      'none',
    );
    // 已经变成目标版本：不再提示
    assert.equal(
      updateAttemptNotice({ phase: 'installing', target: '0.10.10', at: now - 120 * 1000 }, '0.10.10', now).status,
      'none',
    );
    // 过期不翻旧账
    assert.equal(
      updateAttemptNotice({ phase: 'failed', target: '0.10.10', error: 'x', at: now - 61 * 60 * 1000 }, '0.10.9', now).status,
      'none',
    );
  });
});
