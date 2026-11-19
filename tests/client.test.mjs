/**
 * 客户端 bundle 的幂等性测试：插件热更新会再执行一次 apply，而 ctx.webTerminals
 * 是共享服务。SSH 面板必须始终拿到「未过滤」的 shells 列表——包括启动器和新建会话。
 *
 * 不启浏览器：给 client.js 一个最小的 window/document/React/localStorage 替身，
 * 捕获它注册的 slot，然后直接调 inject(...).loadShells()。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module;
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: () => {} },
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

await import('../lib/client.js');

const BASE_SHELLS = [
  { path: '/bin/bash', name: 'bash', args: ['-i'] },
  { path: '/tmp/dsh-ssh-alpha', name: 'SSH alpha', args: [] },
  { path: '/tmp/dsh-ssh-new', name: 'SSH 新建会话', args: [] },
];

function makeCtx() {
  const paneRegs = [];
  const openedTabs = [];
  const effects = [];
  const webTerminals = {
    launchShells: async () => ({ shells: BASE_SHELLS, selectedShell: '/bin/bash' }),
    selectShell: () => {},
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(definition, component) {
        if (definition.name === 'sidebar.right.pane.tab') paneRegs.push({ definition, component });
        return () => {};
      },
    },
    sidebarRight: { openTab: (kind, options) => openedTabs.push({ kind, options }) },
    sidebarRightTabs: { register: () => () => {} },
    webTerminals,
  };
  return { ctx, paneRegs, effects, openedTabs };
}

const requireStub = (name) => {
  if (name === 'react') return { createElement: () => ({}) };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  return {};
};

describe('client apply 幂等性（插件热更新）', () => {
  it('连续 apply 两次后，SSH 面板仍拿到完整列表', async () => {
    const { ctx, paneRegs } = makeCtx();
    const plugin = loaded.factory(requireStub);

    plugin.apply(ctx); // 正常加载
    plugin.apply(ctx); // 模拟 HMR：同一个 ctx 上再跑一次 apply

    const hostPane = paneRegs.findLast((entry) => entry.definition.key === 'dsh-remote-console/ssh-hosts');
    assert.ok(hostPane, 'SSH 主机面板必须注册');
    const loadShells = hostPane.definition.inject('session-1').loadShells;
    const result = await loadShells(undefined);

    const names = result.shells.map((shell) => shell.name);
    assert.ok(names.includes('SSH alpha'), `面板丢了主机启动器：${names.join(',')}`);
    assert.ok(names.includes('SSH 新建会话'), `面板丢了新建会话：${names.join(',')}`);
    assert.ok(names.includes('bash'), '本地 shell 也要保留');
  });

  it('原生终端下拉仍然只看到本地 shell', async () => {
    const { ctx } = makeCtx();
    const plugin = loaded.factory(requireStub);
    plugin.apply(ctx);

    const visible = await ctx.webTerminals.launchShells('session-1');
    const names = visible.shells.map((shell) => shell.name);
    assert.deepEqual(names, ['bash']);
    assert.equal(visible.selectedShell, '/bin/bash');
  });

  it('dispose 后还原原生 launchShells', async () => {
    const { ctx, effects } = makeCtx();
    const plugin = loaded.factory(requireStub);
    plugin.apply(ctx);
    const patched = ctx.webTerminals.launchShells;
    for (const dispose of effects) dispose();
    assert.notEqual(ctx.webTerminals.launchShells, patched);
    const visible = await ctx.webTerminals.launchShells('session-1');
    assert.equal(visible.shells.length, BASE_SHELLS.length);
  });
});

describe('更新检查', () => {
  const plugin = loaded.factory(requireStub);
  const { compareVersions, PLUGIN_VERSION } = plugin.__testing;

  it('客户端版本号与 package.json 同步（发版时不能漏改）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(PLUGIN_VERSION, pkg.version);
  });

  it('SemVer 比较', () => {
    assert.ok(compareVersions('v0.7.0', '0.6.3') > 0);
    assert.ok(compareVersions('0.6.3', 'v0.7.0') < 0);
    assert.equal(compareVersions('v0.6.3', '0.6.3'), 0);
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0, '按数字而不是字符串比较');
    assert.ok(compareVersions('0.6.3', '0.6.3-rc.1') > 0, '正式版高于预发布版');
    assert.equal(compareVersions('not-a-version', '0.6.3'), 0);
  });
});

describe('面板：最近连接、过滤与错误翻译', () => {
  const plugin = loaded.factory(requireStub);
  const { relativeTime, filterShells, orderShells, friendlyError, readRecent, noteRecent, formatSize, shortSessionId, clockRange } = plugin.__testing;

  it('相对时间只在一个月内展示', () => {
    const now = 1_800_000_000_000;
    assert.equal(relativeTime(now, now - 30_000), '刚刚');
    assert.equal(relativeTime(now, now - 5 * 60_000), '5 分钟前');
    assert.equal(relativeTime(now, now - 3 * 3600_000), '3 小时前');
    assert.equal(relativeTime(now, now - 2 * 86400_000), '2 天前');
    assert.equal(relativeTime(now, now - 31 * 86400_000), null, '超过保留期不显示');
    assert.equal(relativeTime(now, now + 1000), null, '未来时间不显示');
    assert.equal(relativeTime(Number.NaN, now), null);
  });

  it('过滤按名字和路径，大小写不敏感', () => {
    const shells = [
      { path: '/tmp/dsh-ssh-alpha', name: 'SSH alpha' },
      { path: '/tmp/dsh-ssh-beta', name: 'SSH beta' },
    ];
    assert.deepEqual(filterShells(shells, 'ALPHA').map((s) => s.name), ['SSH alpha']);
    assert.deepEqual(filterShells(shells, 'dsh-ssh-beta').map((s) => s.name), ['SSH beta']);
    assert.deepEqual(filterShells(shells, '  ').map((s) => s.name), ['SSH alpha', 'SSH beta']);
  });

  it('最近连过的排前面，其余保持宿主顺序', () => {
    const shells = [
      { path: '/a', name: 'SSH a' },
      { path: '/b', name: 'SSH b' },
      { path: '/c', name: 'SSH c' },
    ];
    const ordered = orderShells(shells, { '/b': 2_000, '/c': 1_000 });
    assert.deepEqual(ordered.map((s) => s.path), ['/b', '/c', '/a']);
  });

  it('记录最近连接时保留有限条数', () => {
    const store = new Map();
    const storage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    };
    for (let index = 0; index < 25; index += 1) noteRecent(`/h${index}`, 1000 + index, storage);
    const recent = readRecent(storage);
    assert.equal(Object.keys(recent).length, 20);
    assert.equal(recent['/h24'], 1024, '最新的留下');
    assert.equal(recent['/h0'], undefined, '最旧的被挤掉');
  });

  it('常见 ssh 报错翻成下一步动作', () => {
    assert.match(friendlyError('Permission denied (publickey,password).'), /密钥/);
    assert.match(friendlyError('ssh: connect to host x port 22: Connection refused'), /端口/);
    assert.match(friendlyError('Could not resolve hostname foo'), /主机名/);
    assert.match(friendlyError('something unusual'), /^读取失败：something unusual$/);
  });
});

describe('文件与活动视图的格式化', () => {
  const plugin = loaded.factory(requireStub);
  const { formatSize, shortSessionId, clockRange } = plugin.__testing;

  it('文件大小只留一位小数', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatSize(undefined), '');
  });

  it('长会话 id 收缩成可分辨的头尾', () => {
    assert.equal(shortSessionId('short'), 'short');
    assert.match(shortSessionId('session-89c5d492-c5c4-4f64-a45a-cd04d290b1f5'), /^session-…cd04d290$/);
  });

  it('同一天只显示时分，跨天带日期', () => {
    const base = new Date('2026-11-17T10:00:00');
    const sameDay = clockRange(base.getTime(), base.getTime() + 3600_000);
    assert.match(sameDay, /^10:00–11:00$/);
    const crossDay = clockRange(base.getTime(), base.getTime() + 26 * 3600_000);
    assert.match(crossDay, /^11\/17 10:00–12:00$/);
  });
});

describe('主机分组与置顶', () => {
  const plugin = loaded.factory(requireStub);
  const { readHostPrefs, writeHostPrefs, togglePinned, setHostGroup, hostMetaMap, groupShells } = plugin.__testing;

  const store = () => {
    const data = new Map();
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, value),
    };
  };
  const shells = [
    { path: '/ssh-a', name: 'SSH web-01' },
    { path: '/ssh-b', name: 'SSH db-01' },
    { path: '/ssh-c', name: 'SSH cache-02' },
  ];

  it('偏好读写容错：坏数据不该让面板崩', () => {
    assert.deepEqual(readHostPrefs({ getItem: () => 'not json' }), { pinned: [], groups: {} });
    assert.deepEqual(readHostPrefs({ getItem: () => null }), { pinned: [], groups: {} });
  });

  it('置顶与分组写入后可读回', () => {
    const storage = store();
    let prefs = readHostPrefs(storage);
    prefs = togglePinned('web-01', prefs, storage);
    prefs = setHostGroup('db-01', '生产', prefs, storage);
    assert.deepEqual(prefs.pinned, ['web-01']);
    assert.equal(prefs.groups['db-01'], '生产');
    assert.deepEqual(readHostPrefs(storage), prefs);
  });

  it('取消置顶 / 清空分组', () => {
    const storage = store();
    let prefs = setHostGroup('db-01', '生产', readHostPrefs(storage), storage);
    prefs = togglePinned('web-01', prefs, storage);
    prefs = togglePinned('web-01', prefs, storage); // 再点一次取消
    prefs = setHostGroup('db-01', '', prefs, storage); // 空名清掉分组
    assert.deepEqual(prefs.pinned, []);
    assert.equal(prefs.groups['db-01'], undefined);
  });

  it('置顶组在最前，命名组按序，未分组垫底', () => {
    const prefs = { pinned: ['cache-02'], groups: { 'db-01': '生产' } };
    const groups = groupShells(shells, prefs);
    assert.deepEqual(groups.map((group) => group.name), ['置顶', '生产', '未分组']);
    assert.equal(groups[0].shells[0].path, '/ssh-c');
    assert.equal(groups[1].shells[0].path, '/ssh-b');
    assert.equal(groups[2].shells[0].path, '/ssh-a');
  });

  it('元信息按别名索引，链路字段直接可取', () => {
    const map = hostMetaMap([
      { host: 'db-01', jumpChain: ['bastion'], jumpOk: true },
      { host: 'bad', jumpChain: [], jumpOk: false, jumpProblem: '成环' },
    ]);
    assert.deepEqual(map.get('db-01').jumpChain, ['bastion']);
    assert.equal(map.get('bad').jumpOk, false);
  });
});


describe('独立远程文件页', () => {
  const plugin = loaded.factory(requireStub);
  const { joinRemotePath, parentRemotePath, basenameRemotePath, safeUploadName, PANEL_UPLOAD_LIMIT_BYTES, RemoteFiles } = plugin.__testing;

  it('注册独立文件 Tab，并从终端行带着 pid 打开', () => {
    const { ctx, paneRegs, openedTabs } = makeCtx();
    plugin.apply(ctx);
    const filesPane = paneRegs.find((entry) => entry.definition.key === 'dsh-remote-console/ssh-files');
    assert.ok(filesPane, '远程文件 Tab 必须注册');
    assert.equal(filesPane.component, RemoteFiles);
    const hostPane = paneRegs.find((entry) => entry.definition.key === 'dsh-remote-console/ssh-hosts');
    hostPane.definition.inject('session-1').openFiles('4242');
    assert.deepEqual(openedTabs, [{ kind: 'ssh-files', options: { params: { pid: '4242' } } }]);
  });

  it('面板上传上限与宿主一致（32 MiB）', () => {
    assert.equal(PANEL_UPLOAD_LIMIT_BYTES, 32 * 1024 * 1024);
  });

  it('远端路径拼接、父目录与文件名', () => {
    assert.equal(joinRemotePath('/', 'etc'), '/etc');
    assert.equal(joinRemotePath('/srv/app/', 'a.txt'), '/srv/app/a.txt');
    assert.equal(parentRemotePath('/srv/app/a.txt'), '/srv/app');
    assert.equal(parentRemotePath('/a'), '/');
    assert.equal(parentRemotePath('/'), '/');
    assert.equal(basenameRemotePath('/srv/a.txt'), 'a.txt');
    assert.equal(basenameRemotePath('/'), 'download');
  });

  it('上传文件名不伪装成路径', () => {
    assert.equal(safeUploadName('notes.txt'), true);
    assert.equal(safeUploadName('../x'), false, '带路径的上传名必须拒绝');
    assert.equal(safeUploadName('..x'), true, '以点开头的普通文件名仍合法');
    assert.equal(safeUploadName('a/b'), false);
    assert.equal(safeUploadName('a\\b'), false);
    assert.equal(safeUploadName(''), false);
    assert.equal(safeUploadName('..'), false);
  });
});
