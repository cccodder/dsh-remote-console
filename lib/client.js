/**
 * dsh-remote-console — client half.
 *
 * 两半：
 *  - 引导页入口：完全照抄 DSH 自带 `TerminalGuide` 的卡片结构（图标 + 标题 + ▾ 菜单），
 *    菜单里列出各远端启动器；选中即开原生终端 tab（xterm 渲染/输入/关闭全部复用 DSH 实现）
 *  - 面板正文：远端列表 tab（点卡片主区域进入），选中同样开原生终端 tab
 *
 * 手写 client bundle（发布包没有前端构建链），格式与 DSH 自带 client 插件一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-console',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const TAB_ID = 'dsh-remote-console/ssh-hosts';
    const KIND = 'ssh-hosts';

    /* ---- 版本与更新检查 ---- */
    // 手写 bundle 没有构建链，版本号在这里维护；tests/client.test.mjs 会断言它与
    // package.json 的 version 一致，避免发版时漏改。
    const VERSION = '0.6.6';
    const RELEASES_API = 'https://api.github.com/repos/cccodder/dsh-remote-console/releases/latest';
    const UPDATE_CACHE_KEY = 'dsh-remote-console.latest-release';
    const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

    function parseVersion(text) {
      const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(text ?? '').trim());
      if (match === null) return undefined;
      return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
    }

    /** SemVer 优先级比较：a>b 返回正数；无法解析时返回 0。 */
    function compareVersions(a, b) {
      const pa = parseVersion(a);
      const pb = parseVersion(b);
      if (pa === undefined || pb === undefined) return 0;
      for (let index = 0; index < 3; index += 1) {
        if (pa.numbers[index] !== pb.numbers[index]) return pa.numbers[index] - pb.numbers[index];
      }
      if (pa.pre === undefined && pb.pre === undefined) return 0;
      if (pa.pre === undefined) return 1;
      if (pb.pre === undefined) return -1;
      return pa.pre === pb.pre ? 0 : pa.pre > pb.pre ? 1 : -1;
    }

    /** 读 6 小时内的缓存结果，避免每次开面板都打 GitHub API（未认证 60 次/小时）。 */
    function readCachedRelease() {
      try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(UPDATE_CACHE_KEY);
        if (raw === null) return undefined;
        const cached = JSON.parse(raw);
        if (typeof cached?.tag !== 'string' || typeof cached?.url !== 'string') return undefined;
        if (!Number.isFinite(cached.at) || Date.now() - cached.at > UPDATE_CACHE_TTL_MS) return undefined;
        return cached;
      } catch {
        return undefined;
      }
    }

    function writeCachedRelease(info) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(info));
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
    }

    /** 查 GitHub 最新 release；失败（离线、限流、CORS）就当没有更新，不打扰用户。 */
    async function fetchLatestRelease() {
      try {
        const response = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
        if (!response.ok) return undefined;
        const data = await response.json();
        if (typeof data?.tag_name !== 'string' || typeof data?.html_url !== 'string') return undefined;
        return { tag: data.tag_name, url: data.html_url, at: Date.now() };
      } catch {
        return undefined;
      }
    }

    /* ---- 样式：规则文本与 DSH 自带 TerminalGuide.module.css 一致，只换了类名前缀 ---- */
    const MOD = 'dshrc';
    const CSS = `
.${MOD}-entry{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsl-guide-entry-radius);background:var(--dsw-alias-bg-layer-1);align-items:center;gap:14px;width:100%;min-height:56px;padding:14px 20px;display:flex;position:relative;overflow:hidden}
.${MOD}-main{border-radius:0;width:100%;height:100%;position:absolute;inset:0}
.${MOD}-main:focus-visible{outline-offset:-1px}
.${MOD}-icon{width:26px;height:26px;color:var(--dsw-alias-label-secondary);pointer-events:none;flex:none;justify-content:center;align-items:center;display:flex;position:relative}
.${MOD}-globe{color:var(--dsw-alias-state-accent-primary,var(--dsw-alias-label-secondary))}
.${MOD}-globe svg{width:26px;height:26px}
.${MOD}-text{pointer-events:none;flex-direction:column;flex:1;gap:3px;min-width:0;display:flex;position:relative}
.${MOD}-titleRow{align-items:center;gap:4px;min-width:0;display:flex}
.${MOD}-title{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:14px;line-height:1.4;overflow:hidden}
.${MOD}-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:1.4;overflow:hidden}
.${MOD}-trigger{border-radius:4px;flex:none;width:20px;height:20px;padding:0}
.${MOD}-trigger svg{width:14px;height:14px;color:var(--dsw-alias-label-tertiary)}
.${MOD}-menu{pointer-events:auto;flex:none;display:flex}
.${MOD}-root{display:flex;flex-direction:column;gap:8px;padding:12px;height:100%;overflow:auto;font:13px/1.5 var(--dsw-font-sans,system-ui,sans-serif);color:var(--dsw-alias-label-primary);box-sizing:border-box}
.${MOD}-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.${MOD}-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;text-align:left;font:inherit}
.${MOD}-item:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-itemTitle{font-weight:600}
.${MOD}-itemSub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.${MOD}-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px}
.${MOD}-refresh{border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit}
.${MOD}-refresh:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
`;

    const CSS_TAG = 'dsh-remote-console/guide.css';
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-remote-console';
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function label(shell) {
      return String(shell?.name ?? shell?.path ?? '');
    }

    function isSshShell(shell) {
      const name = label(shell);
      return /^ssh\s+/iu.test(name) || name.startsWith('dsh-ssh');
    }

    /** 菜单里显示的主机名：去掉启动器名字前缀，只留 host。 */
    function shortLabel(shell) {
      return label(shell).replace(/^SSH\s+/u, '');
    }

    function genericShell(shells) {
      return shells.find((shell) => {
        const name = label(shell);
        return name === 'SSH 新建会话' || name === 'dsh-ssh 远程';
      });
    }

    /** 识别「本插件注入进 shell 列表」的条目，用于从原生「新建终端」下拉里滤掉。 */
    function isOurShell(shell) {
      const name = label(shell);
      return name === 'dsh-ssh 远程' || name.startsWith('SSH ');
    }

    /**
     * 引导页入口卡片：地球图标 + 标题 + 描述，点整张卡片打开远端列表面板。
     * 不做就地下拉（主机选择统一在面板里，逻辑只留一份）。
     */
    function SshGuide({ title, description, useTabInfo }) {
      const { tab } = useTabInfo();
      return h(
        'div',
        { className: `${MOD}-entry`, 'data-sidebar-right-guide-entry': KIND },
        h(primitives.Button, {
          variant: 'ghost',
          className: `${MOD}-main`,
          'aria-label': description === undefined ? title : `${title} ${description}`,
          onClick: () => tab.actions.openTab(KIND, { replaceTab: true }),
        }),
        h(
          'span',
          { className: `${MOD}-icon ${MOD}-globe`, 'aria-hidden': 'true' },
          h(primitives.IconGlobeOutlineRegular, {}),
        ),
        h(
          'span',
          { className: `${MOD}-text` },
          h(
            'span',
            { className: `${MOD}-titleRow` },
            h('span', { className: `${MOD}-title`, 'aria-hidden': 'true' }, title),
          ),
          description !== undefined && h('span', { className: `${MOD}-description`, 'aria-hidden': 'true' }, description),
        ),
      );
    }

    /** 面板正文：远端列表（点卡片主区域进入）。 */
    function HostList({ loadShells, connect }) {
      const [state, setState] = React.useState({ phase: 'loading', shells: [], error: null });
      const [attempt, setAttempt] = React.useState(0);
      const [latest, setLatest] = React.useState(undefined);

      // 更新检查：优先用缓存，后台失败静默（离线/限流/CORS 都不该打扰用户）。
      React.useEffect(() => {
        const cached = readCachedRelease();
        if (cached !== undefined) {
          setLatest(cached);
          return undefined;
        }
        let live = true;
        void fetchLatestRelease().then((info) => {
          if (!live || info === undefined) return;
          writeCachedRelease(info);
          setLatest(info);
        });
        return () => {
          live = false;
        };
      }, []);

      React.useEffect(() => {
        const lifetime = new AbortController();
        setState({ phase: 'loading', shells: [], error: null });
        Promise.resolve(loadShells(lifetime.signal)).then(
          (result) => {
            if (lifetime.signal.aborted) return;
            const shells = Array.isArray(result?.shells) ? result.shells : [];
            setState({ phase: 'ready', shells, error: null });
          },
          (error) => {
            if (lifetime.signal.aborted) return;
            setState({ phase: 'error', shells: [], error: String(error?.message ?? error) });
          },
        );
        return () => lifetime.abort();
      }, [attempt, loadShells]);

      if (state.phase === 'loading') {
        return h('div', { className: `${MOD}-root` }, h('div', { className: `${MOD}-hint` }, '正在读取远端列表…'));
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: `${MOD}-root` },
          h('div', { className: `${MOD}-error` }, `读取失败：${state.error}`),
          h('button', { className: `${MOD}-item`, onClick: () => setAttempt((n) => n + 1) }, '重试'),
        );
      }

      const generic = genericShell(state.shells);
      const rows = [];
      for (const shell of state.shells) {
        if (!isSshShell(shell) || shell.path === generic?.path) continue;
        rows.push(
          h(
            'button',
            { key: shell.path, className: `${MOD}-item`, title: shell.path, onClick: () => connect(shell.path) },
            h('span', { className: `${MOD}-itemTitle` }, shortLabel(shell)),
            h('span', { className: `${MOD}-itemSub` }, '点击打开终端，然后输入密码'),
          ),
        );
      }
      if (generic !== undefined) {
        rows.push(
          h(
            'button',
            { key: 'generic', className: `${MOD}-item`, title: generic.path, onClick: () => connect(generic.path) },
            h('span', { className: `${MOD}-itemTitle` }, '新建会话'),
            h('span', { className: `${MOD}-itemSub` }, '输入 user@ip，直接进 ssh'),
          ),
        );
      }

      const newer = latest !== undefined && compareVersions(latest.tag, VERSION) > 0;

      return h(
        'div',
        { className: `${MOD}-root` },
        h(
          'div',
          { className: `${MOD}-hint`, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('span', {}, '选择远端：'),
          h(
            'button',
            { type: 'button', className: `${MOD}-refresh`, onClick: () => setAttempt((n) => n + 1) },
            '刷新',
          ),
        ),
        ...rows,
        h(
          'div',
          { className: `${MOD}-hint`, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', {}, '密码只在终端里输入，DSH 不保存。'),
          h(
            'span',
            { style: { whiteSpace: 'nowrap' }, title: '更新方式：侧栏「插件」→ 卸载 → 重新安装新版' },
            `v${VERSION}`,
            newer
              ? h(
                  'a',
                  {
                    href: latest.url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    style: { marginLeft: '6px', color: 'inherit', textDecoration: 'underline' },
                  },
                  `有新版本 ${latest.tag}`,
                )
              : null,
          ),
        ),
      );
    }

    function apply(ctx) {
      /**
       * 原生「新建终端」下拉读的是同一份 shells 列表，我们注入的 SSH 条目会在那里重复出现。
       * 客户端把这份列表过滤掉，远端就只出现在「SSH 远程」卡片的下拉里。
       * 注意宿主侧 shells() 必须保留这些条目：controller.create 会用 shellPath 在 shells() 里校验
       * （dsh-api-terminal-controller/lib/index.js:984），所以不能从源头删。
       *
       * 服务对象是跨插件实例共享的，插件热更新（HMR）会再次执行 apply，而旧包装还留在
       * ctx.webTerminals 上。所以这里必须幂等：用原始方法当基线、只包一层、dispose 时还原。
       * 否则第二次 apply 会把「未过滤的列表」也过滤掉，SSH 面板就变成空的（没有主机、没有新建会话）。
       */
      const launchAll = ctx.webTerminals.launchShells.__dshRcInner ?? ctx.webTerminals.launchShells.bind(ctx.webTerminals);

      // 清掉历史遗留：早期版本把 SSH 启动器写进了全局「上次选择的 shell」偏好
      // （localStorage 键 dsh.terminal.shell，见 dsh-api-terminal-controller 的 shell-preference），
      // 导致原生「新建终端」开成远端。只在值确实是我们自己的启动器时才删。
      try {
        if (typeof localStorage !== 'undefined') {
          const KEY = 'dsh.terminal.shell';
          const saved = localStorage.getItem(KEY);
          if (saved !== null && /(^|\/)dsh-ssh($|-)/u.test(saved)) localStorage.removeItem(KEY);
        }
      } catch {
        /* 浏览器禁用存储时忽略 */
      }

      /** 本地 shell 的路径（从最近一次 shells 列表里缓存），用于把偏好纠正回去。 */
      let localShellPath;

      /**
       * 我们的列表：读未过滤的 shells（含远端启动器）。
       * 顺手做一次纠正：如果全局「上次选择的 shell」被写成了 SSH 启动器，
       * 就把它改回第一个本地 shell，保证原生「新建终端」开的是本地终端。
       */
      const loadShellsForUs = async (sessionId, signal) => {
        const result = await launchAll(sessionId, signal);
        const shells = Array.isArray(result?.shells) ? result.shells : [];
        const local = shells.find((shell) => !isOurShell(shell));
        if (local !== undefined) localShellPath = local.path;
        const selected = shells.find((shell) => shell.path === result?.selectedShell);
        if (selected !== undefined && isOurShell(selected)) {
          if (local !== undefined) {
            try {
              ctx.webTerminals.selectShell(local.path);
            } catch {
              /* 纠正失败不影响列表 */
            }
          }
        }
        return result;
      };
      // 过滤包装放在 effect 里：dispose 时还原，HMR 重复 apply 也不会叠加过滤。
      ctx.effect(() => {
        const current = ctx.webTerminals.launchShells;
        if (current.__dshRcFilter === true) return () => {};
        const inner = current.bind(ctx.webTerminals);
        const patched = async (sessionId, signal) => {
          const result = await inner(sessionId, signal);
          const shells = Array.isArray(result?.shells) ? result.shells : [];
          const hidden = new Set(shells.filter(isOurShell).map((shell) => shell.path));
          if (hidden.size === 0) return result;
          const visible = shells.filter((shell) => !hidden.has(shell.path));
          const selectedShell = hidden.has(result?.selectedShell) ? visible[0]?.path : result?.selectedShell;
          return { ...result, shells: visible, selectedShell };
        };
        patched.__dshRcFilter = true;
        patched.__dshRcInner = inner;
        ctx.webTerminals.launchShells = patched;
        return () => {
          if (ctx.webTerminals.launchShells === patched) ctx.webTerminals.launchShells = inner;
        };
      }, 'remote-console.client.shell-filter');

      const SHELL_KEY = 'dsh.terminal.shell';

      /**
       * 原生终端 controller 在创建终端时会**无条件** rememberShell(path)
       * （dsh-api-terminal-controller/lib/client.js 的 TerminalView.refresh：`if (path !== void 0) rememberShell(path)`）。
       * 所以打开远端终端后，全局偏好会被写成 SSH 启动器；点原生「新建终端」就会跟着开远端。
       * 这里在打开后的一小段时间内把它纠正回本地 shell。
       */
      const restoreShellPreference = () => {
        const fix = () => {
          try {
            if (typeof localStorage === 'undefined') return;
            const saved = localStorage.getItem(SHELL_KEY);
            if (saved === null || !/(^|\/)dsh-ssh($|-)/u.test(saved)) return;
            if (localShellPath !== undefined) localStorage.setItem(SHELL_KEY, localShellPath);
            else localStorage.removeItem(SHELL_KEY);
          } catch {
            /* 浏览器禁用存储时忽略 */
          }
        };
        // 创建终端是异步的（mount → refresh → create），多打几次稳一点
        for (const delay of [300, 900, 2000]) setTimeout(fix, delay).unref?.();
      };

      const openRemoteTerminal = (shellPath, replaceTab) => {
        ctx.sidebarRight.openTab('terminal', {
          ...(replaceTab ? { replaceTab: true } : {}),
          params: { shellPath },
        });
        restoreShellPreference();
      };

      const connect = (shellPath) => openRemoteTerminal(shellPath, false);

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => 'SSH 远程',
            guide: [
              {
                id: 'new',
                order: 21,
                title: () => 'SSH 远程',
                description: () => '选择远端并登录',
              },
            ],
          }),
        'remote-console.client.type',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.guide.entry',
                key: TAB_ID,
                inject: () => ({}),
              },
              SshGuide,
            ),
          ),
        'remote-console.client.guide',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                inject: (sessionId) => ({
                  loadShells: (signal) => loadShellsForUs(sessionId, signal),
                  connect,
                }),
              },
              HostList,
            ),
          ),
        'remote-console.client.body',
      );
    }

    const exported = {};
    exported.apply = apply;
    exported.inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'webTerminals'];
    /* 只给仓库测试用（loader 只读 apply/inject）。 */
    exported.__testing = { compareVersions, parseVersion, PLUGIN_VERSION: VERSION };
    return exported;
  },
});
