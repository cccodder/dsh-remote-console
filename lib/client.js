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
    const VERSION = '0.10.3';
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
.${MOD}-form{display:flex;flex-direction:column;gap:8px}
.${MOD}-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:12px/1.5 var(--dsw-font-mono,ui-monospace,monospace);padding:8px 10px;resize:vertical;min-height:120px}
.${MOD}-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${MOD}-save{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:inherit;border-radius:6px;padding:4px 12px;font:inherit;cursor:pointer}
.${MOD}-save:disabled{opacity:.5;cursor:default}
.${MOD}-hosts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.${MOD}-hostRow{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1)}
.${MOD}-hostName{font:12px/1.5 var(--dsw-font-mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${MOD}-hostRemove{border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;flex:none}
.${MOD}-hostRemove:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:12px/1.5 var(--dsw-font-mono,ui-monospace,monospace);padding:6px 10px}
.${MOD}-empty{color:var(--dsw-alias-label-tertiary);font-size:12px}
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
          h('span', { title: 'agent 执行过的命令、审批、传输、转发会跨会话记在数据目录 audit/ 下' }, '审计：audit/'),
          h(
            'span',
            { title: '主机列表：侧栏「插件」→ 点开 dsh-remote-console 包 → 「主机列表」；也可以直接让 agent 添加（remote_host_add）' },
            '主机：插件页配置',
          ),
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

    /** 设置页里的主机列表：逐条显示、可增删，保存后宿主重新生成侧栏启动器。 */
    const CONFIG_NAMESPACE = 'dsh-remote-console';

    /** 多行文本 → 行数组（保留注释行，丢弃空行）。 */
    function hostsLinesFromValue(value) {
      return String(value ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    }

    function hostsValueFromLines(lines) {
      return lines.join('\n');
    }

    /**
     * 单文件传输上限（MB），对应宿主 Config 的 maxTransferMB。客户端不能 import 宿主代码，
     * 所以重复一份默认值和边界；tests/settings-client.test.mjs 会断言与宿主一致。
     */
    const DEFAULT_MAX_TRANSFER_MB = 256;
    const MIN_MAX_TRANSFER_MB = 1;
    const MAX_MAX_TRANSFER_MB = 2048;

    /** 读当前生效值：没配置过就是默认 256，越界/非数字夹回范围内。 */
    function transferLimitMBFromValue(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return DEFAULT_MAX_TRANSFER_MB;
      return Math.min(MAX_MAX_TRANSFER_MB, Math.max(MIN_MAX_TRANSFER_MB, Math.round(number)));
    }

    /**
     * 保存主机列表（顺带保存单文件传输上限）。不传 expectedRevision：冲突判断交给服务端
     * 的最新修订号，第一次被拒（通常是本地快照落后）时稍等重试一次。
     * maxTransferMB 为 undefined 时只写主机列表（保持旧调用方行为）。
     */
    async function saveHosts(form, lines, refresh, maxTransferMB) {
      const value = hostsValueFromLines(lines);
      const limit = typeof maxTransferMB === 'number' && Number.isFinite(maxTransferMB) ? maxTransferMB : undefined;
      const ops = [{ op: 'set', path: ['hosts'], value }];
      if (limit !== undefined) ops.push({ op: 'set', path: ['maxTransferMB'], value: limit });
      const refreshSnapshot = async () => {
        if (typeof refresh !== 'function') return;
        try {
          // eslint-disable-next-line no-await-in-loop
          await refresh();
        } catch {
          /* 刷新失败就让写入自己报错 */
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      };
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // 修订号会随宿主重载/其它写入变化；每轮都先拉一次最新快照，避免拿旧号硬撞冲突
        // eslint-disable-next-line no-await-in-loop
        await refreshSnapshot();
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await form.mutate(ops);
          if (ok) return { ok: true, attempts: attempt, mode: 'mutate' };
          // mutate 被拒但不抛错（例如 form 已 dispose）时也要留下原因，别让诊断串结尾是空的
          lastError = 'mutate 返回 false（DSH 没有接受写入）';
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        if (attempt === 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      // 最后一个兜底：单字段写入走另一条代码路径（同样先刷新快照）
      await refreshSnapshot();
      if (typeof form.set === 'function') {
        try {
          let ok = await form.set('hosts', value);
          if (ok && limit !== undefined) ok = await form.set('maxTransferMB', limit);
          if (ok) return { ok: true, attempts: 3, mode: 'set' };
          lastError = 'set 返回 false（DSH 没有接受写入）';
        } catch (error) {
          return { ok: false, attempts: 3, mode: 'set', error: String(error?.message ?? error) };
        }
      }
      return {
        ok: false,
        attempts: 2,
        mode: 'mutate',
        ...(lastError === undefined ? {} : { error: String(lastError?.message ?? lastError) }),
      };
    }

    function HostsConfigCard({ view, form, refresh }) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState(undefined);
      const [input, setInput] = React.useState('');
      const [limitDraft, setLimitDraft] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
      if (view === 'summary') return '管理侧栏 SSH 面板里的远端主机与单文件传输上限';

      const accepted = hostsLinesFromValue(snapshot.value?.hosts);
      const lines = draft === undefined ? accepted : draft;
      const acceptedLimit = transferLimitMBFromValue(snapshot.value?.maxTransferMB);
      const limitText = limitDraft === undefined ? String(acceptedLimit) : limitDraft;
      const readOnly = snapshot.writable !== true;
      const hostsDirty = draft !== undefined && hostsValueFromLines(lines) !== hostsValueFromLines(accepted);
      const limitDirty = limitDraft !== undefined && transferLimitMBFromValue(limitDraft) !== acceptedLimit;
      const dirty = hostsDirty || limitDirty;

      const add = () => {
        const spec = input.trim();
        if (spec.length === 0) return;
        setDraft([...(draft ?? accepted), spec]);
        setInput('');
        setError(undefined);
      };
      const removeAt = (index) => {
        setDraft((draft ?? accepted).filter((_line, position) => position !== index));
        setError(undefined);
      };
      const save = async () => {
        const parsedLimit = Number(limitText);
        if (!Number.isInteger(parsedLimit) || parsedLimit < MIN_MAX_TRANSFER_MB || parsedLimit > MAX_MAX_TRANSFER_MB) {
          setError(`单文件传输上限要填 ${MIN_MAX_TRANSFER_MB}–${MAX_MAX_TRANSFER_MB} 之间的整数（MB）`);
          return;
        }
        setSaving(true);
        setError(undefined);
        try {
          const result = await saveHosts(form, lines, refresh, parsedLimit);
          if (result.ok) {
            setDraft(undefined);
            setLimitDraft(undefined);
          } else {
            const snapshot2 = form.getSnapshot();
            const diagnostics = `status=${String(snapshot2?.status)} revision=${String(snapshot2?.revision)} writable=${String(snapshot2?.writable)} mode=${result.mode ?? '-'} attempts=${String(result.attempts ?? '-')}`;
            console.warn('dsh-remote-console: saving hosts failed', diagnostics, result.error ?? '');
            const conflict = /changed since it was read|revision/iu.test(String(result.error ?? ''));
            setError(
              conflict
                ? `配置修订号刚变过（保存前已自动刷新并重试，仍被拒）。点「重新加载」会刷新页面（当前草稿会丢），重载后再添加并保存。诊断：${diagnostics}`
                : `保存没有被接受（${result.error ?? 'DSH 没有返回错误信息'}）。点「重新加载」会刷新页面（当前草稿会丢），重载后再添加并保存。诊断：${diagnostics}`,
            );
          }
        } catch (failure) {
          setError(`保存失败：${String(failure?.message ?? failure)}`);
        } finally {
          setSaving(false);
        }
      };

      return h(
        'div',
        { className: `${MOD}-form` },
        h(
          'div',
          { className: `${MOD}-hint` },
          '每行一台远端：ssh 配置里的别名，或 user@host[:port]；# 开头为注释。保存后侧栏「SSH 远程」里立即多出对应入口。',
        ),
        lines.length === 0
          ? h('div', { className: `${MOD}-empty` }, '还没有主机，添加第一台：')
          : h(
              'ul',
              { className: `${MOD}-hosts` },
              ...lines.map((line, index) =>
                h(
                  'li',
                  { key: `${index}-${line}`, className: `${MOD}-hostRow` },
                  h('code', { className: `${MOD}-hostName` }, line),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `${MOD}-hostRemove`,
                      disabled: readOnly,
                      'aria-label': `删除 ${line}`,
                      onClick: () => removeAt(index),
                    },
                    '删除',
                  ),
                ),
              ),
            ),
        h(
          'div',
          { className: `${MOD}-row` },
          h('input', {
            className: `${MOD}-input`,
            type: 'text',
            spellCheck: false,
            disabled: readOnly,
            value: input,
            placeholder: 'deploy@10.0.0.5:22 或 nas',
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            },
          }),
          h(
            'button',
            { type: 'button', className: `${MOD}-refresh`, disabled: readOnly || input.trim() === '', onClick: add },
            '添加',
          ),
        ),
        h(
          'div',
          { className: `${MOD}-row` },
          h('label', { className: `${MOD}-hint`, htmlFor: 'dshrc-max-transfer' }, '单文件传输上限（MB）'),
          h('input', {
            id: 'dshrc-max-transfer',
            className: `${MOD}-input`,
            type: 'number',
            min: MIN_MAX_TRANSFER_MB,
            max: MAX_MAX_TRANSFER_MB,
            step: 1,
            disabled: readOnly,
            value: limitText,
            style: { flex: '0 0 96px', minWidth: '96px' },
            onChange: (event) => {
              setLimitDraft(event.target.value);
              setError(undefined);
            },
          }),
          h('span', { className: `${MOD}-hint` }, `${MIN_MAX_TRANSFER_MB}–${MAX_MAX_TRANSFER_MB}`),
        ),
        h(
          'div',
          { className: `${MOD}-hint` },
          '只影响 remote_upload / remote_download（默认 256 MB）；没有 ControlMaster 的 PTY 通道固定最多 1 MiB。',
        ),
        h(
          'div',
          { className: `${MOD}-row` },
          h(
            'button',
            {
              type: 'button',
              className: `${MOD}-save`,
              disabled: readOnly || saving || !dirty,
              onClick: () => void save(),
            },
            saving ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `${MOD}-refresh`,
              disabled: saving || !dirty,
              onClick: () => {
                setDraft(undefined);
                setLimitDraft(undefined);
                setError(undefined);
              },
            },
            '取消',
          ),
          h(
            'button',
            { type: 'button', className: `${MOD}-refresh`, onClick: () => window.location.reload() },
            '重新加载',
          ),
          readOnly ? h('span', { className: `${MOD}-error` }, '本部署的设置为只读') : null,
          error === undefined ? null : h('span', { className: `${MOD}-error` }, error),
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

      // 插件配置页：宿主服务了本插件的 settings 命名空间时才注册。
      // 注意用 ctx.inject 等服务出现，而不是在 apply 时 ctx.get 一次——客户端插件可能先于
      // 设置服务加载，一次性读取会永远拿到 undefined（这正是 0.10.0 里「找不到入口」的原因）。
      // 同时注册两个 slot：
      //  - plugins.bundle.config（key 是包名）：插件包详情页顶部直接出现，最容易找到；
      //  - plugins.row.config（key 是 `<包名>#<行 id>`）：本插件那一行的「配置」按钮。
      const mountSettingsPage = (scope) => {
        const configForms = typeof scope.get === 'function' ? scope.get('configForms') : scope.configForms;
        if (configForms === undefined || typeof configForms.get !== 'function') return;
        const form = configForms.get(CONFIG_NAMESPACE);
        // form 是 configForms 提供并缓存的共享实例，生命周期归它所有：这里绝不能 dispose。
        // 插件行禁用再启用（客户端插件重载）会触发本插件的 effect 清理；一旦把宿主这个 form
        // dispose 掉，重新挂载时 configForms.get() 仍返回同一个已 dispose 的实例，mutate 一律
        // 返回 false（revision 还冻结不动），表现为「插件重载后设置页保存必失败」。
        // 卸载时只清理本插件自己的 slot 注册，form 交给 configForms。
        if (typeof configForms.whileServed !== 'function') return;
        scope.effect(
          () =>
            configForms.whileServed([CONFIG_NAMESPACE], () => {
              const disposers = [];
              const register = (slot, key) =>
                scope.slots.inject(slot, () =>
                  scope.slots.register(
                    {
                      name: slot,
                      key,
                      order: 60,
                      label: () => '主机列表',
                      inject: () => ({
                        form,
                        refresh: () => {
                          try {
                            return configForms.describe().load();
                          } catch {
                            return Promise.resolve();
                          }
                        },
                      }),
                    },
                    HostsConfigCard,
                  ),
                );
              disposers.push(register('plugins.bundle.config', CONFIG_NAMESPACE));
              disposers.push(register('plugins.row.config', `${CONFIG_NAMESPACE}#${CONFIG_NAMESPACE}`));
              return () => {
                for (const dispose of disposers) {
                  if (typeof dispose === 'function') dispose();
                }
              };
            }),
          'remote-console.client.settings-page',
        );
      };
      if (typeof ctx.inject === 'function') {
        // 可选依赖：没有该服务的部署不注册，也不影响终端功能
        ctx.inject(['configForms'], (scope) => {
          try {
            mountSettingsPage(scope);
          } catch (error) {
            // 设置页失败不能拖垮终端
            console.warn('dsh-remote-console: settings page registration failed', error);
          }
        });
      } else {
        mountSettingsPage(ctx);
      }

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
    exported.__testing = {
      compareVersions,
      parseVersion,
      PLUGIN_VERSION: VERSION,
      hostsLinesFromValue,
      hostsValueFromLines,
      transferLimitMBFromValue,
      DEFAULT_MAX_TRANSFER_MB,
      MIN_MAX_TRANSFER_MB,
      MAX_MAX_TRANSFER_MB,
      saveHosts,
    };
    return exported;
  },
});
