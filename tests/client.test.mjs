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
  const titleRegs = [];
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
        if (definition.name === 'sidebar.right.pane.tab.title') titleRegs.push({ definition, component });
        return () => {};
      },
    },
    sidebarRight: { openTab: (kind, options) => openedTabs.push({ kind, options }) },
    sidebarRightTabs: { register: () => () => {} },
    webTerminals,
  };
  return { ctx, paneRegs, titleRegs, effects, openedTabs };
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

  it('连接后复用原生终端 view 设置主机标题', async () => {
    const { ctx, paneRegs } = makeCtx();
    const plugin = loaded.factory(requireStub);
    const tabs = [];
    const originalOpenTab = ctx.sidebarRight.openTab;
    ctx.sidebarRight.tabsIn = () => tabs;
    ctx.sidebarRight.openTab = (kind, options) => {
      originalOpenTab(kind, options);
      tabs.push({ id: 'tab-1', kind, contentId: 'terminal-content-1' });
    };
    let snapshot = { phase: 'creating', info: undefined };
    const listeners = new Set();
    const renamed = [];
    const view = {
      state: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      rename: async (title) => renamed.push(title),
    };
    let viewArgs;
    ctx.webTerminals.view = (...args) => {
      viewArgs = args;
      return view;
    };
    plugin.apply(ctx);
    const hostPane = paneRegs.find((entry) => entry.definition.key === 'dsh-remote-console/ssh-hosts');
    hostPane.definition.inject('session-1').connect('/tmp/dsh-ssh-alpha', 'session-1', 'alpha');
    assert.deepEqual(viewArgs, ['session-1', 'tab-1', 'terminal-content-1', undefined, '/tmp/dsh-ssh-alpha']);
    snapshot = { phase: 'connected', info: { id: 'terminal-1' } };
    for (const listener of [...listeners]) listener();
    await Promise.resolve();
    assert.deepEqual(renamed, ['终端 · alpha']);
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
  const { readHostPrefs, writeHostPrefs, togglePinned, setHostGroup, hostMetaMap, groupShells, findConsoleForHost, consoleDisplayName, compactHostLabel, terminalTitleForHost, renameTerminalWhenReady } = plugin.__testing;

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

  it('在线与最近连接进入优先组，不重复出现在命名组', () => {
    const now = 1_800_000_000_000;
    const prefs = { pinned: ['cache-02'], groups: { 'db-01': '生产' } };
    const groups = groupShells(shells, prefs, {
      consoles: [{ pid: '42', host: 'web-01' }],
      recent: { '/ssh-b': now - 60_000 },
      now,
    });
    assert.deepEqual(groups.map((group) => group.name), ['置顶', '已连接', '最近连接']);
    assert.deepEqual(groups.map((group) => group.shells[0].path), ['/ssh-c', '/ssh-a', '/ssh-b']);
    assert.ok(groups.every((group) => group.priority));
  });

  it('最近连接最多展开 5 台，其余留在折叠组', () => {
    const now = 1_800_000_000_000;
    const many = Array.from({ length: 7 }, (_, index) => ({ path: `/ssh-${index}`, name: `SSH host-${index}` }));
    const recent = Object.fromEntries(many.map((shell, index) => [shell.path, now - index * 1000]));
    const groups = groupShells(many, { pinned: [], groups: {} }, { recent, now });
    assert.deepEqual(groups.map((group) => group.name), ['最近连接', '未分组']);
    assert.equal(groups[0].shells.length, 5);
    assert.equal(groups[1].shells.length, 2);
    assert.equal(groups[1].priority, false);
  });

  it('主机连接只按完整别名匹配，并生成可区分的短标题', () => {
    const consoles = [{ pid: '41', host: 'demo-1' }, { pid: '42', host: 'demo-2' }];
    assert.equal(findConsoleForHost(consoles, 'demo-2').pid, '42');
    assert.equal(findConsoleForHost(consoles, 'demo'), undefined);
    assert.equal(compactHostLabel('demo-1'), 'demo-1');
    assert.equal(compactHostLabel('demo@127.0.0.1:2222'), ':2222 · …1');
    assert.equal(terminalTitleForHost('demo-1'), '终端 · demo-1');
    assert.equal(terminalTitleForHost('demo@127.0.0.1:2223'), '终端 · :2223 · …1');
  });

  it('直连目标按 user/host/port 匹配在线终端并进入已连接组', () => {
    const direct = [
      { pid: '51', host: '127.0.0.1', user: 'demo', port: '2222' },
      { pid: '52', host: '127.0.0.1', user: 'demo', port: '2223' },
      { pid: '53', host: '127.0.0.1', user: 'demo', port: '22' },
    ];
    assert.equal(findConsoleForHost(direct, 'demo@127.0.0.1:2222').pid, '51');
    assert.equal(findConsoleForHost(direct, 'demo@127.0.0.1:2223').pid, '52');
    assert.equal(findConsoleForHost(direct, 'demo@127.0.0.1').pid, '53', '缺省端口就是 22');
    assert.equal(findConsoleForHost(direct, 'demo@127.0.0.1:22').pid, '53');
    assert.equal(findConsoleForHost(direct, 'other@127.0.0.1:2222'), undefined);
    assert.equal(consoleDisplayName(direct[1]), 'demo@127.0.0.1:2223');
    const directShell = [{ path: '/ssh-direct', name: 'SSH demo@127.0.0.1:2222' }];
    const groups = groupShells(directShell, { pinned: [], groups: {} }, { consoles: direct, recent: {}, now: 1_800_000_000_000 });
    assert.deepEqual(groups.map((group) => group.name), ['已连接']);
  });

  it('原生终端创建完成后才重命名，并释放状态监听', async () => {
    let snapshot = { phase: 'idle', info: undefined };
    const listeners = new Set();
    const titles = [];
    const view = {
      state: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      rename: async (title) => titles.push(title),
    };
    const cleanup = renameTerminalWhenReady(view, '终端 · demo-1');
    assert.equal(titles.length, 0);
    assert.equal(listeners.size, 1);
    snapshot = { phase: 'connected', info: { id: 'terminal-1' } };
    for (const listener of [...listeners]) listener();
    await Promise.resolve();
    assert.deepEqual(titles, ['终端 · demo-1']);
    assert.equal(listeners.size, 0);
    cleanup();
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
  const { joinRemotePath, parentRemotePath, basenameRemotePath, isRemotePathWithin, remoteBreadcrumbs, displayRemotePath, safeUploadName, PANEL_UPLOAD_LIMIT_BYTES, uploadLimitMessage, RemoteFiles, RemoteFilesTitle } = plugin.__testing;

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

  it('文件入口携带主机名，并注册动态文件 Tab 标题', () => {
    const { ctx, paneRegs, titleRegs, openedTabs } = makeCtx();
    plugin.apply(ctx);
    const hostPane = paneRegs.find((entry) => entry.definition.key === 'dsh-remote-console/ssh-hosts');
    hostPane.definition.inject('session-1').openFiles('4242', 'demo-1');
    assert.deepEqual(openedTabs[0], { kind: 'ssh-files', options: { params: { pid: '4242', host: 'demo-1' } } });
    const title = titleRegs.find((entry) => entry.definition.key === 'dsh-remote-console/ssh-files');
    assert.ok(title, '远程文件 Tab 标题必须注册');
    assert.equal(title.component, RemoteFilesTitle);
  });

  it('同一文件 Tab 的导航参数变化会同步内部 pid', () => {
    const states = [];
    const refs = [];
    const effects = [];
    let stateIndex = 0;
    let refIndex = 0;
    const react = {
      createElement: () => ({}),
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (update) => { states[index] = typeof update === 'function' ? update(states[index]) : update; }];
      },
      useRef: (initial) => {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useMemo: (fn) => fn(),
      useEffect: (fn, deps) => effects.push({ fn, deps }),
    };
    const localPlugin = loaded.factory((name) => name === 'react' ? react : requireStub(name));
    const tab = {
      navigation: { params: { pid: '41', host: 'demo@127.0.0.1:2222' }, revision: 0 },
      params: { pid: '41' },
      actions: { openTab: () => {} },
    };
    const render = () => {
      stateIndex = 0;
      refIndex = 0;
      effects.length = 0;
      localPlugin.__testing.RemoteFiles({ useTabInfo: () => ({ tab }) });
    };
    render();
    assert.equal(states[2], '41');
    tab.navigation = { params: { pid: '52', host: 'demo@127.0.0.1:2223' }, revision: 1 };
    tab.params = { pid: '52' };
    render();
    assert.deepEqual(effects[0].deps, [tab.navigation.params.pid, tab.navigation.revision]);
    effects[0].fn();
    assert.equal(states[2], '52');
  });

  it('面板上传上限与宿主一致（32 MiB）', () => {
    assert.equal(PANEL_UPLOAD_LIMIT_BYTES, 32 * 1024 * 1024);
  });

  it('超限提示保留精确字节数，不被四舍五入藏掉', () => {
    const message = uploadLimitMessage(32 * 1024 * 1024 + 1);
    assert.match(message, /33,554,433 字节/u);
    assert.match(message, /未发送/u);
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

  it('home 内使用波浪线路径，home 外保留绝对路径面包屑', () => {
    assert.deepEqual(remoteBreadcrumbs('/home/demo/project/src', '/home/demo'), [
      { label: '~', path: '/home/demo' },
      { label: 'project', path: '/home/demo/project' },
      { label: 'src', path: '/home/demo/project/src' },
    ]);
    assert.deepEqual(remoteBreadcrumbs('/tmp/a', '/home/demo'), [
      { label: '/', path: '/' },
      { label: 'tmp', path: '/tmp' },
      { label: 'a', path: '/tmp/a' },
    ]);
    assert.deepEqual(remoteBreadcrumbs('/', '/home/demo'), [{ label: '/', path: '/' }]);
    assert.equal(displayRemotePath('/home/demo/project/notes.txt', '/home/demo'), '~/project/notes.txt');
    assert.equal(displayRemotePath('/tmp/notes.txt', '/home/demo'), '/tmp/notes.txt');
  });

  it('目录包含关系按完整路径段判断', () => {
    assert.equal(isRemotePathWithin('/home/demo', '/home/demo/project'), true);
    assert.equal(isRemotePathWithin('/home/demo', '/home/demo2'), false);
    assert.equal(isRemotePathWithin('/', '/tmp'), true);
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

describe('结构化远程文件阅读与编辑', () => {
  const plugin = loaded.factory(requireStub);
  const {
    fileLanguage,
    languageLabel,
    validateFileContent,
    formatJson,
    safeMarkdownHref,
    markdownInline,
    markdownBlocks,
    tokenizeCodeLine,
  } = plugin.__testing;

  const renderReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
  };
  const renderPlugin = loaded.factory((name) => name === 'react' ? renderReact : requireStub(name));
  const walk = (node, visit) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    visit(node);
    walk(node.props?.children, visit);
  };

  it('按扩展名选择 Markdown、JSON、YAML 或纯文本', () => {
    assert.equal(fileLanguage('/srv/README.md'), 'markdown');
    assert.equal(fileLanguage('/srv/CHANGELOG.MARKDOWN'), 'markdown');
    assert.equal(fileLanguage('/srv/app.json'), 'json');
    assert.equal(fileLanguage('/srv/app.yaml'), 'yaml');
    assert.equal(fileLanguage('/srv/app.YML'), 'yaml');
    assert.equal(fileLanguage('/srv/notes.txt'), 'text');
    assert.equal(languageLabel('yaml'), 'YAML');
  });

  it('JSON 使用严格解析，错误带行列', () => {
    assert.equal(validateFileContent('{"name":"demo","ok":true}', 'json').valid, true);
    const invalid = validateFileContent('{\n  "name": "demo",\n  "ok": true,\n}', 'json');
    assert.equal(invalid.valid, false);
    assert.ok(invalid.line >= 3, `应定位到末行附近，实际 ${invalid.line}`);
    assert.ok(invalid.column >= 1);
    assert.equal(validateFileContent('{name: demo}', 'json').valid, false, 'JSON 不接受无引号键');
  });

  it('JSON 格式化只在有效内容上进行', () => {
    assert.equal(formatJson('{"name":"demo","ok":true}'), '{\n  "name": "demo",\n  "ok": true\n}\n');
    assert.equal(formatJson('{bad'), undefined);
  });

  it('YAML 接受常见映射、列表、flow、注释与块标量', () => {
    const source = [
      'name: demo',
      'servers:',
      '  - host: 127.0.0.1',
      '    port: 2222',
      '    tags: [ssh, demo]',
      '  - host: localhost',
      '    enabled: true',
      'note: "a # quoted value"',
      'description: |',
      '  第一行 # 仍属于文本',
      '    更深的缩进与 [ 括号也只是文本',
      'next: ok',
      '',
    ].join('\n');
    const result = validateFileContent(source, 'yaml');
    assert.equal(result.valid, true, result.message);
  });

  it('YAML 支持多行引号和 indentless sequence', () => {
    const source = 'items:\n- one\n- two\ndescription: "first\n  second"\nnext: ok\n';
    assert.equal(validateFileContent(source, 'yaml').valid, true);
  });

  it('YAML 拒绝 Tab 缩进和不一致的回退层级', () => {
    const tab = validateFileContent('root:\n\tchild: value\n', 'yaml');
    assert.equal(tab.valid, false);
    assert.equal(tab.line, 2);
    assert.match(tab.message, /Tab/u);
    const dedent = validateFileContent('root:\n  child: value\n    grandchild: ok\n  sibling: ok\n broken: true\n', 'yaml');
    assert.equal(dedent.valid, false);
    assert.equal(dedent.line, 5);
    assert.match(dedent.message, /缩进层级/u);
  });

  it('YAML 报告未闭合引号与 flow 括号', () => {
    const bracket = validateFileContent('tags: [one, two\n', 'yaml');
    assert.equal(bracket.valid, false);
    assert.equal(bracket.line, 1);
    assert.match(bracket.message, /没有闭合/u);
    const quoted = validateFileContent('name: "demo\n', 'yaml');
    assert.equal(quoted.valid, false);
    assert.match(quoted.message, /引号/u);
    const mismatch = validateFileContent('tags: [one}\n', 'yaml');
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.message, /没有匹配/u);
  });

  it('JSON 高亮区分键、字符串、数字、关键字且保留原文', () => {
    const line = '  "port": 2222, "enabled": true, "note": "demo"';
    const tokens = tokenizeCodeLine(line, 'json');
    assert.equal(tokens.map((entry) => entry.text).join(''), line);
    assert.ok(tokens.some((entry) => entry.type === 'key' && entry.text === '"port"'));
    assert.ok(tokens.some((entry) => entry.type === 'number' && entry.text === '2222'));
    assert.ok(tokens.some((entry) => entry.type === 'keyword' && entry.text === 'true'));
    assert.ok(tokens.some((entry) => entry.type === 'string' && entry.text === '"demo"'));
  });

  it('YAML 高亮区分键、列表、字符串和注释且保留原文', () => {
    const line = '  - host: "demo" # 注释';
    const tokens = tokenizeCodeLine(line, 'yaml');
    assert.equal(tokens.map((entry) => entry.text).join(''), line);
    assert.ok(tokens.some((entry) => entry.type === 'punctuation' && entry.text.includes('-')));
    assert.ok(tokens.some((entry) => entry.type === 'key' && entry.text === 'host'));
    assert.ok(tokens.some((entry) => entry.type === 'string' && entry.text === '"demo"'));
    assert.equal(tokens.at(-1).type, 'comment');
  });

  it('Markdown 生成标题、列表、表格、引用和代码块结构', () => {
    const source = [
      '# 远程部署',
      '',
      '使用 **同一终端** 阅读 [项目](https://example.com/docs)。',
      '',
      '- 检查配置',
      '- 保存文件',
      '',
      '| 主机 | 端口 |',
      '| :--- | ---: |',
      '| demo | 2222 |',
      '',
      '> 不建立第二条连接',
      '',
      '```yaml',
      'enabled: true',
      '```',
    ].join('\n');
    const blocks = markdownBlocks(source);
    assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'table', 'quote', 'code']);
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[2].items.length, 2);
    assert.deepEqual(blocks[3].head, ['主机', '端口']);
    assert.deepEqual(blocks[3].aligns, ['left', 'right']);
    assert.equal(blocks[5].language, 'yaml');
  });

  it('Markdown 行内语法保留代码、强调和安全链接', () => {
    const nodes = markdownInline('**保存** `file.md` [文档](https://example.com) ~~旧方式~~');
    assert.deepEqual(nodes.map((node) => node.type), ['strong', 'text', 'code', 'text', 'link', 'text', 'delete']);
    assert.equal(nodes[4].href, 'https://example.com');
  });

  it('Markdown 原始 HTML 与危险链接不会变成可执行节点', () => {
    const blocks = markdownBlocks('<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))');
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks[0].text, '<script>alert(1)</script>');
    const link = markdownInline('[危险链接](javascript:alert(1))')[0];
    assert.equal(link.type, 'link');
    assert.equal(link.href, undefined, '危险协议不得进入可点击 href');
    assert.equal(safeMarkdownHref('javascript:alert(1)'), undefined);
    assert.equal(safeMarkdownHref('https://example.com/a'), 'https://example.com/a');
  });

  it('Markdown 图片只显示说明，不自动发起远程或外部资源请求', () => {
    const nodes = markdownInline('![网络拓扑](https://example.com/topology.png)');
    assert.deepEqual(nodes, [{ type: 'image', alt: '网络拓扑', href: 'https://example.com/topology.png' }]);
  });

  it('Markdown 组件不生成 script、img 或 HTML 注入入口', () => {
    const tree = renderPlugin.__testing.MarkdownView({ content: '# 标题\n\n<script>alert(1)</script>\n\n![图](https://example.com/a.png)' });
    const types = [];
    walk(tree, (node) => {
      types.push(node.type);
      assert.equal(node.props.dangerouslySetInnerHTML, undefined);
    });
    assert.ok(types.includes('h1'));
    assert.ok(!types.includes('script'));
    assert.ok(!types.includes('img'));
  });

  it('源码组件渲染行号、错误行，并让保存快捷键进入统一回调', () => {
    let saves = 0;
    const tree = renderPlugin.__testing.CodeEditor({
      content: '{\n  "ok": true\n}',
      language: 'json',
      errorLine: 2,
      disabled: false,
      label: '编辑 app.json',
      onChange: () => {},
      onSave: () => { saves += 1; },
    });
    let textarea;
    let badLines = 0;
    walk(tree, (node) => {
      if (node.type === 'textarea') textarea = node;
      if (String(node.props.className ?? '').includes('rfCodeLineBad')) badLines += 1;
    });
    assert.equal(textarea.props.value, '{\n  "ok": true\n}');
    assert.equal(badLines, 1);
    const event = { metaKey: true, ctrlKey: false, key: 's', preventDefault: () => {} };
    textarea.props.onKeyDown(event);
    assert.equal(saves, 1);
  });
});
