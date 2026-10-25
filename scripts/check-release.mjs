/**
 * 发版元数据自检：CI 和 release workflow 都跑它。
 *
 * 校验的是「同一个版本号在四个地方一致」——package.json、客户端 bundle、CHANGELOG、
 * 插件市场索引。任何一处漂移都会让 npm 上的包、GitHub Release、市场里的条目对不上。
 *
 * 用法：node scripts/check-release.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
check(typeof version === 'string' && SEMVER.test(version), `package.json 的 version 不是合法 SemVer：${String(version)}`);
check(pkg.private !== true, 'package.json 不能是 private，否则 npm publish 会失败');
check(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0, 'package.json 缺少 engines.dsh');

// 客户端 bundle 是手写文件，版本号只能写死在 lib/client.js；这里和测试一起兜住漂移。
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const clientVersion = /const VERSION = '([^']+)';/u.exec(client)?.[1];
check(clientVersion === version, `lib/client.js 的 VERSION 是 ${String(clientVersion)}，package.json 是 ${version}`);

// CHANGELOG：Keep a Changelog 结构，当前版本必须有段落，且保留 Unreleased。
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
check(/^## \[Unreleased\]/mu.test(changelog), 'CHANGELOG.md 缺少 `## [Unreleased]` 段');
check(new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'mu').test(changelog), `CHANGELOG.md 没有 ${version} 的段落`);
check(new RegExp(`^\\[${version.replaceAll('.', '\\.')}\\]:`, 'mu').test(changelog), `CHANGELOG.md 没有 ${version} 的 compare 链接`);

// 插件市场索引：只列当前版本也行，但必须能解析、版本对得上、npm 源。
let index;
try {
  index = JSON.parse(readFileSync(join(root, 'market', 'index.json'), 'utf8'));
} catch (error) {
  failures.push(`market/index.json 读不出来：${String(error.message)}`);
}
if (index !== undefined) {
  check(index.format === 1, `market/index.json 的 format 是 ${String(index.format)}，应为 1`);
  const plugin = Array.isArray(index.plugins) ? index.plugins[0] : undefined;
  check(plugin?.name === pkg.name, `market/index.json 的插件名是 ${String(plugin?.name)}，package.json 是 ${pkg.name}`);
  const entry = Array.isArray(plugin?.versions) ? plugin.versions.find((candidate) => candidate.version === version) : undefined;
  check(entry !== undefined, `market/index.json 没有 ${version} 这个版本（先跑 npm run market:index）`);
  if (entry !== undefined) {
    check(entry.source?.type === 'npm', 'market/index.json 的版本应使用 npm 源');
    if (typeof pkg.engines?.dsh === 'string') {
      check(entry.engines?.dsh === pkg.engines.dsh, 'market/index.json 的 engines.dsh 与 package.json 不一致');
    }
  }
}

if (failures.length > 0) {
  console.error('发版元数据检查失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`发版元数据一致：${pkg.name}@${version}（客户端、CHANGELOG、市场索引）`);
