/**
 * 测试前置：把 DSH 安装目录里的 peer 包软链到本包 node_modules，让 `lib/index.js`
 * 能按真实 DSH 依赖解析（peerDependencies 在开发目录里本来不该装一份）。
 *
 * 顺序：$DSH_INSTALL_DIR → `npm root -g` → `which dsh` 反推。
 * 找不到就明确报错，不静默跳过。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PEERS = ['dsh-home-paths', 'dsh-tools'];

/** `lib/bin.js` → 包根目录。 */
function dshPackageRoot(binPath) {
  return resolve(dirname(realpathSync(binPath)), '..');
}

function candidates() {
  const list = [];
  if (process.env.DSH_INSTALL_DIR) list.push(resolve(process.env.DSH_INSTALL_DIR));
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (npmRoot.length > 0) list.push(join(npmRoot, '@deepseek-ai', 'dsh'));
  } catch {
    /* npm 不可用 */
  }
  try {
    const which = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which.length > 0) list.push(dshPackageRoot(which));
  } catch {
    /* 没有 dsh 命令 */
  }
  return list;
}

function findInstall() {
  for (const base of candidates()) {
    const nodeModules = join(base, 'node_modules', '@deepseek-ai');
    if (PEERS.every((peer) => existsSync(join(nodeModules, peer, 'package.json')))) return nodeModules;
  }
  return undefined;
}

const nodeModules = findInstall();
if (nodeModules === undefined) {
  console.error(
    '[link-peers] 找不到 DSH 安装目录。请先 `npm i -g @deepseek-ai/dsh`，或设置 DSH_INSTALL_DIR 指向 @deepseek-ai/dsh 包目录。',
  );
  process.exit(1);
}

const targetDir = join(root, 'node_modules', '@deepseek-ai');
mkdirSync(targetDir, { recursive: true });
for (const peer of PEERS) {
  const link = join(targetDir, peer);
  rmSync(link, { force: true, recursive: true });
  symlinkSync(join(nodeModules, peer), link, 'dir');
  console.log(`[link-peers] ${peer} -> ${join(nodeModules, peer)}`);
}
