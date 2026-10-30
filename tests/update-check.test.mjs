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
      assert.equal(result.source, 'unknown');
      assert.equal(store.size, 0, 'unknown 只是这一次没问出来，不能缓存');
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
