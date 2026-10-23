/**
 * 插件市场索引（format 1）校验：用 DSH 自带的 `parseMarketIndex` 解析仓库里的
 * `market/index.json`，确保用户把索引 URL 配进「发现 → 添加索引源」时能被接受。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const INDEX_URL = 'https://raw.githubusercontent.com/cccodder/dsh-remote-console/main/market/index.json';
const raw = JSON.parse(readFileSync(new URL('../market/index.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('market/index.json（format 1）', () => {
  it('能通过 parseMarketIndex 校验', () => {
    const index = parseMarketIndex(raw, INDEX_URL);
    assert.equal(index.format, 1);
    assert.equal(index.plugins.length, 1);
  });

  it('条目与 package.json 对齐', () => {
    const index = parseMarketIndex(raw, INDEX_URL);
    const plugin = index.plugins[0];
    assert.equal(plugin.name, pkg.name);
    const current = plugin.versions.find((entry) => entry.version === pkg.version);
    assert.ok(current !== undefined, `索引里缺少当前版本 ${pkg.version}`);
    assert.deepEqual(current.source, { type: 'npm' });
    if (typeof pkg.engines?.dsh === 'string') assert.equal(current.engines.dsh, pkg.engines.dsh);
  });

  it('版本不重复且最新的排在最前', () => {
    const index = parseMarketIndex(raw, INDEX_URL);
    const versions = index.plugins[0].versions.map((entry) => entry.version);
    assert.equal(new Set(versions).size, versions.length);
    assert.equal(versions[0], pkg.version, '最新发布版本应排在最前');
  });
});
