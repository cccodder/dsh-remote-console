/**
 * 生成 DSH 插件市场索引（format 1）里本插件的条目。
 *
 * 用法：npm run market:index [-- --timestamp <unix秒>]
 *
 * - 从 package.json 读 name/version/engines.dsh/描述/仓库地址；
 * - 从 npm registry 读该版本的发布时间（拿不到就用当前时间）；
 * - 保留 market/index.json 里已有的历史版本，按 SemVer 降序输出；
 * - 只声明 npm 源（本项目同时发布到 npm），Git 源不写进索引，避免两套来源不一致。
 *
 * 索引 URL（给用户在「发现 → 添加索引源」里填；GitHub Pages，随 main 自动重建）：
 *   https://cccodder.github.io/dsh-remote-console/market/index.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outFile = join(root, 'market', 'index.json');

const INDEX_URL = 'https://cccodder.github.io/dsh-remote-console/market/index.json';
const REGISTRY = 'https://registry.npmjs.org';

function parseArgs(argv) {
  const args = { timestamp: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--timestamp') args.timestamp = Number(argv[index + 1]);
  }
  return args;
}

/** 读 npm registry 的版本表与发布时间；离线时返回 undefined（调用方回退到本地历史）。 */
async function registryMeta() {
  try {
    const response = await fetch(`${REGISTRY}/${encodeURIComponent(pkg.name)}`);
    if (!response.ok) return undefined;
    const data = await response.json();
    const versions = new Set(Object.keys(data?.versions ?? {}));
    const time = data?.time ?? {};
    return { versions, time };
  } catch {
    return undefined;
  }
}

function readExisting() {
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const existing = readExisting();
const previousVersions = Array.isArray(existing?.plugins?.[0]?.versions) ? existing.plugins[0].versions : [];
const meta = await registryMeta();

// 只保留真的发布到 npm 的历史版本：索引里的条目必须能装上。
// （registry 不可达时保守保留本地历史，避免离线生成把历史清空。）
const known = previousVersions.filter(
  (entry) => entry?.version !== pkg.version && (meta === undefined || meta.versions.has(entry.version)),
);
const publishedAt = meta?.time?.[pkg.version];
const parsedTimestamp = typeof publishedAt === 'string' ? Math.floor(Date.parse(publishedAt) / 1000) : undefined;
const timestamp =
  args.timestamp !== undefined && Number.isFinite(args.timestamp)
    ? Math.floor(args.timestamp)
    : (Number.isFinite(parsedTimestamp) ? parsedTimestamp : Math.floor(Date.now() / 1000));

if (meta !== undefined && !meta.versions.has(pkg.version)) {
  console.warn(`警告：npm 上还没有 ${pkg.name}@${pkg.version}，索引条目会指向一个装不上的版本。先 npm publish。`);
}

const versionEntry = {
  version: pkg.version,
  publishTimestamp: timestamp,
  source: { type: 'npm' },
  ...(typeof pkg.engines?.dsh === 'string' ? { engines: { dsh: pkg.engines.dsh } } : {}),
};

const versions = [...known, versionEntry].sort((left, right) => {
  const a = left.version.split('.').map(Number);
  const b = right.version.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
});

const index = {
  format: 1,
  title: {
    en: 'dsh-remote-console',
    zh: 'dsh-remote-console（SSH 远程终端）',
  },
  description: {
    en: 'Right-sidebar SSH remote console for DeepSeek Harness: the agent works inside the same PTY you are watching.',
    zh: 'DSH 右侧栏的 SSH 远程终端：agent 在你正在看的同一个 PTY 里工作。',
  },
  metadata: {
    categories: {
      remote: { title: { en: 'Remote access', zh: '远程访问' } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: 'SSH Remote Console',
        zh: 'SSH 远程终端',
      },
      description: {
        en: 'SSH hosts in the right sidebar; the agent reads and writes the same PTY, with a unified human+agent log.',
        zh: '右侧栏列 SSH 主机；agent 读写同一个 PTY，人与 agent 共用一条日志。',
      },
      author: 'cccodder',
      homepage: pkg.homepage ?? 'https://github.com/cccodder/dsh-remote-console',
      repository: {
        url: 'https://github.com/cccodder/dsh-remote-console',
      },
      metadata: {
        category: 'remote',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        labels: [],
        sortKeys: {},
      },
      versions,
    },
  ],
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${outFile}`);
console.log(`version ${pkg.version} @ ${new Date(timestamp * 1000).toISOString()}`);
console.log(`index URL: ${INDEX_URL}`);
