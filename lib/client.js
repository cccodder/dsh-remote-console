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
    const FILES_TAB_ID = 'dsh-remote-console/ssh-files';
    const FILES_KIND = 'ssh-files';

    /* ---- 版本与更新检查 ---- */
    // 手写 bundle 没有构建链，版本号在这里维护；tests/client.test.mjs 会断言它与
    // package.json 的 version 一致，避免发版时漏改。
    const VERSION = '0.14.0';
    const PACKAGE_NAME = 'dsh-remote-console';
    // 设置页底部的 Star 引导（唯一的外部链接，纯展示，不发网络请求）
    const PROJECT_URL = 'https://github.com/cccodder/dsh-remote-console';
    // v2：只缓存「有结论」的结果。v1 会把超时/读不到来源也写进缓存，10 分钟内一直显示失败。
    const UPDATE_CACHE_KEY = 'dsh-remote-console.update-check.v2';
    // 对齐 ds-bot：打开设置页就查，10 分钟内复用上次结果（GitHub/npm 都不是高频接口）
    const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;
    const UPDATE_FETCH_TIMEOUT_MS = 8000;
    const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
    const MIRROR_REGISTRY = 'https://registry.npmmirror.com/';
    // 「刚点过更新」的标记：reload 回来用它判断客户端 bundle 到底换没换。
    const PENDING_UPDATE_KEY = 'dsh-remote-console.pending-update';
    const PENDING_UPDATE_TTL_MS = 15 * 60 * 1000;
    // 更新过程中插件会被卸载/重装，设置页组件可能被销毁；失败状态必须落盘才留得住。
    const UPDATE_ATTEMPT_KEY = 'dsh-remote-console.update-attempt';
    const UPDATE_ATTEMPT_TTL_MS = 60 * 60 * 1000;

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
        // 只有真正得出结论的检查才能复用：unknown（管理器没就绪）和各种查询失败都不算。
        if (cached?.definitive !== true || typeof cached?.source !== 'string' || !Number.isFinite(cached.at)) return undefined;
        if (Date.now() - cached.at > UPDATE_CHECK_TTL_MS) return undefined;
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

    /** 记下「刚点了更新到哪个版本」，reload 后据此自检客户端 bundle 有没有真的换掉。 */
    function readPendingUpdate() {
      try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(PENDING_UPDATE_KEY);
        if (raw === null) return undefined;
        const pending = JSON.parse(raw);
        if (typeof pending?.version !== 'string' || !Number.isFinite(pending?.at)) return undefined;
        return { version: pending.version, at: pending.at };
      } catch {
        return undefined;
      }
    }

    function writePendingUpdate(target) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify({ version: String(target), at: Date.now() }));
        }
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
    }

    function readUpdateAttempt() {
      try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(UPDATE_ATTEMPT_KEY);
        if (raw === null) return undefined;
        const attempt = JSON.parse(raw);
        if (typeof attempt?.phase !== 'string' || !Number.isFinite(attempt?.at)) return undefined;
        return attempt;
      } catch {
        return undefined;
      }
    }

    function writeUpdateAttempt(attempt) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(UPDATE_ATTEMPT_KEY, JSON.stringify({ ...attempt, at: Date.now() }));
        }
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
    }

    function clearUpdateAttempt() {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(UPDATE_ATTEMPT_KEY);
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
    }

    /**
     * 上次更新留下的状态：失败要把原文留给用户（组件可能在「卸载 → 安装」期间被销毁），
     * 长时间停在 installing 说明中断了，也要提示。
     */
    function updateAttemptNotice(attempt, currentVersion, now = Date.now()) {
      if (attempt === undefined || attempt === null) return { status: 'none' };
      const age = now - attempt.at;
      if (!Number.isFinite(age) || age < 0 || age > UPDATE_ATTEMPT_TTL_MS) return { status: 'none' };
      if (attempt.phase === 'failed') {
        return { status: 'failed', target: String(attempt.target ?? ''), error: String(attempt.error ?? '未知原因') };
      }
      if (attempt.phase === 'installing' && age > 90 * 1000 && !sameVersion(attempt.target, currentVersion)) {
        return { status: 'interrupted', target: String(attempt.target ?? '') };
      }
      return { status: 'none' };
    }

    function clearPendingUpdate() {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(PENDING_UPDATE_KEY);
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
    }

    /** 版本相等（允许 tag 带 v 前缀）。 */
    function sameVersion(left, right) {
      return parseVersion(left) !== undefined && compareVersions(left, right) === 0;
    }

    /**
     * 更新后自检：宿主的 HMR 会就地重载 Host 插件，但客户端 bundle 图是按**启动时解析到的路径**
     * 缓存的（dsh-client-modules 的 sourceKey = baseUrl + 包名，路径变了也不重建）。
     * 所以升级如果换了安装来源（本地目录 / link → npm），浏览器只能继续跑旧 bundle。
     * 这里在 reload 回来后判断一次，如实提示「需要重启 DSH」，不假装更新成功。
     */
    function pendingUpdateState(pending, currentVersion, now = Date.now()) {
      if (pending === undefined || pending === null) return { status: 'none' };
      const age = now - pending.at;
      if (!Number.isFinite(age) || age < 0 || age > PENDING_UPDATE_TTL_MS) return { status: 'stale' };
      if (parseVersion(pending.version) === undefined) return { status: 'none' };
      if (sameVersion(pending.version, currentVersion)) return { status: 'applied', version: pending.version };
      return { status: 'restart-required', version: pending.version };
    }

    const cleanVersion = (value) => {
      const parsed = parseVersion(value);
      if (parsed === undefined) return undefined;
      return `${parsed.numbers.join('.')}${parsed.pre === undefined ? '' : `-${parsed.pre}`}`;
    };

    /** 安装 spec → 来源（对齐 ds-bot 的 sourceOf）：registry / git / path / tarball / unknown。 */
    function sourceOf(spec) {
      const text = typeof spec === 'string' ? spec.trim() : '';
      if (text === '') return { kind: 'unknown' };
      if (/^(link|file):/iu.test(text) || /^([a-z]:[\\/]|[\\/]|~|\.)/iu.test(text)) return { kind: 'path' };
      const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.*))?$/iu.exec(text);
      const gitLike = /^(git\+|git:|git@|github:|gitlab:|bitbucket:)/iu.test(text) || /\.git(#|$)/u.test(text);
      if (github !== null && (gitLike || !text.startsWith('@'))) {
        const parts = String(github[3] ?? '').split('&').filter(Boolean);
        const ref = parts.find((part) => !part.includes(':')) ?? '';
        return {
          kind: 'git',
          owner: github[1],
          repo: github[2],
          ...(cleanVersion(ref) === undefined ? {} : { ref }),
          rest: parts.filter((part) => part !== ref),
        };
      }
      if (gitLike) return { kind: 'git' };
      if (/^https?:/iu.test(text)) return { kind: 'tarball' };
      return { kind: 'registry' };
    }

    const normalizeRegistry = (url) => `${String(url).trim().replace(/\/+$/u, '')}/`;
    const encodePackageName = (name) =>
      name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

    /**
     * 安装 registry 的询问顺序（对齐 ds-bot）：DSH/pnpm 配置的第一顺位优先（这样镜像用户查到的
     * 就是镜像里的版本，而不是官方 registry 的），再跟它的 fallback。
     */
    async function registryPlan(manager) {
      let configured;
      try {
        // registries() 同样是 Remote 调用：返回 { ok, value } 包膜，不解包就会永远回退官方 npmjs，
        // 本地/镜像 registry 用户的更新检查就查错了地方。
        configured = unwrapRemote(await manager?.registries?.());
      } catch {
        configured = undefined;
      }
      // 读取失败（包膜 ok:false）当作没配置，官方与镜像都问一遍，别把用户锁在一条路上
      if (configured?.error !== undefined) configured = undefined;
      if (configured === undefined || configured === null) return [OFFICIAL_REGISTRY, MIRROR_REGISTRY];
      const fallbacks = (configured.fallbackRegistries ?? []).map(normalizeRegistry);
      const own = typeof configured.resolved === 'string' ? normalizeRegistry(configured.resolved) : null;
      const first = typeof configured.registry === 'string' ? normalizeRegistry(configured.registry) : (own ?? OFFICIAL_REGISTRY);
      const isPublic = first === OFFICIAL_REGISTRY || fallbacks.includes(first);
      return isPublic ? [...new Set([first, ...fallbacks])] : [first];
    }

    async function fetchJson(url, headers = {}) {
      const timeout =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS)
          : undefined;
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        ...(timeout === undefined ? {} : { signal: timeout }),
      });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.json();
    }

    /** 这个 profile 是从哪装的：插件管理器报告的 source；读不到就是 unknown（不提供更新）。 */
    /**
     * 读一次 listBundles。DSH 的 Remote 调用返回的是 `{ ok, value }` 包膜（官方插件管理器
     * 自己也是 `bundles.value.map(...)`），不是裸数组——0.10.6/0.10.7 按裸数组解析，
     * 导致有管理器也永远读不到来源、更新检查整条失效。
     */
    async function installSpecOfOnce(manager) {
      try {
        const raw = await manager?.listBundles?.();
        if (raw !== undefined && raw !== null && raw.ok === false) return undefined;
        const bundles = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.value)
            ? raw.value
            : Array.isArray(raw?.bundles)
              ? raw.bundles
              : undefined;
        const own = Array.isArray(bundles) ? bundles.find((bundle) => bundle?.name === PACKAGE_NAME) : undefined;
        if (typeof own?.source === 'string' && own.source.length > 0) return own.source;
        // source 是 API 的可选字段：缺失但知道版本时，按 registry 的 spec 处理（npm/市场安装的常见形态）
        if (typeof own?.version === 'string' && own.version.length > 0) return `${PACKAGE_NAME}@${own.version}`;
      } catch {
        /* 读不到来源就不猜 */
      }
      return undefined;
    }

    /**
     * 读安装来源并区分三种情况：`no-manager`（这个 DSH 没有插件管理服务，只能是手动更新）、
     * `read-failed`（管理器在但这次没读出来，值得让用户重试）、`ok`（拿到 spec）。
     */
    async function readInstallSpec(manager, { retryMs = 400 } = {}) {
      if (manager === undefined || manager === null) return { status: 'no-manager' };
      const first = await installSpecOfOnce(manager);
      if (first !== undefined) return { status: 'ok', spec: first };
      await wait(retryMs);
      const second = await installSpecOfOnce(manager);
      if (second !== undefined) return { status: 'ok', spec: second };
      return { status: 'read-failed' };
    }

    /**
     * 这个 profile 是从哪装的：插件管理器报告的 source。
     * 管理器服务可能比设置页晚一点挂上，刚装完 bundle 也可能还没进列表——读不到时短暂重试一次，
     * 否则会把「暂时读不到」当成「没有更新源」，CLI 安装的用户就永久看不到「更新到」按钮。
     */
    async function installSpecOf(manager, { retryMs = 400 } = {}) {
      const first = await installSpecOfOnce(manager);
      if (first !== undefined) return first;
      if (manager === undefined || manager === null) return undefined;
      await wait(retryMs);
      return await installSpecOfOnce(manager);
    }

    async function newestFromRegistry(manager) {
      for (const registry of await registryPlan(manager)) {
        try {
          const data = await fetchJson(`${registry}${encodePackageName(PACKAGE_NAME)}/latest`);
          const version = cleanVersion(data?.version);
          if (version !== undefined) return { version, spec: `${PACKAGE_NAME}@${version}`, registry };
        } catch {
          /* 不可达或那个 registry 还没有这个包：问下一个 */
        }
      }
      return undefined;
    }

    async function newestFromGitHub(source) {
      const repo = `${source.owner}/${source.repo}`;
      const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, {
        'user-agent': `${PACKAGE_NAME}/${VERSION}`,
      });
      const version = cleanVersion(release?.tag_name);
      if (version === undefined) return undefined;
      const fragment = [release.tag_name, ...(source.rest ?? [])].join('&');
      return {
        version,
        spec: `github:${repo}#${fragment}`,
        ...(typeof release?.html_url === 'string' ? { notesUrl: release.html_url } : {}),
      };
    }

    /**
     * 查更新（对齐 ds-bot）：先看「当初是怎么装的」——registry 安装查 npm（含镜像 fallback），
     * 带版本 tag 的 git 安装查 GitHub release；link/本地目录不提供一键更新，免得把开发目录覆盖掉。
     * 10 分钟内复用上次结果，点「重新检查」强制刷新。
     */
    async function checkForUpdate(manager, { force = false } = {}) {
      if (force !== true) {
        const cached = readCachedRelease();
        if (cached !== undefined) return cached;
      }
      const install = await readInstallSpec(manager);
      if (install.status === 'no-manager') return { source: 'no-manager', at: Date.now() };
      if (install.status === 'read-failed') return { source: 'unreadable', at: Date.now() };
      const installSpec = install.spec;
      const source = sourceOf(installSpec);
      const lookupKind = source.kind === 'registry' || (source.kind === 'git' && source.ref !== undefined);
      let found;
      try {
        if (source.kind === 'registry') found = await newestFromRegistry(manager);
        else if (source.kind === 'git' && source.ref !== undefined) found = await newestFromGitHub(source);
      } catch {
        found = undefined;
      }
      const result = {
        source: source.kind,
        ...(typeof installSpec === 'string' ? { installSpec } : {}),
        ...(found === undefined
          ? {}
          : { latest: found.version, spec: found.spec, registry: found.registry, notesUrl: found.notesUrl }),
        at: Date.now(),
      };
      // 有结论的才算数：path/tarball/无 tag 的 git 是「确实不提供一键更新」；
      // unknown（管理器没就绪）和 registry/git 查询失败（超时、不可达）都只是这一次没问出来，
      // 不能写缓存，否则网络恢复后 10 分钟内还在显示失败。
      const definitive =
        source.kind === 'path' || source.kind === 'tarball' || (source.kind === 'git' && !lookupKind) || (lookupKind && found !== undefined);
      if (definitive) writeCachedRelease({ ...result, definitive: true });
      return result;
    }

    /**
     * DSH 的 Remote 调用返回的是 `{ ok, value }` 包膜，plugin-manager 的 installBundle /
     * removeBundle / listBundles 也一样。只读顶层字段会把 `value.error` 当成成功——误判成功
     * 比报错危险得多（会写 pending 标记、刷新页面，实际什么都没装）。
     */
    function unwrapRemote(result) {
      if (result === undefined || result === null) return undefined;
      if (result.ok === false) return { error: result.error ?? { message: 'Remote 调用失败' } };
      if (result.ok === true && result.value !== undefined) return result.value;
      // 老版本 / 非包膜返回值原样透传
      return result;
    }

    const INSTALL_FAILED = (raw) => {
      const result = unwrapRemote(raw);
      return (
        result === undefined ||
        result === null ||
        result.error !== undefined ||
        result.application === 'failed' ||
        result.application === 'cancelled'
      );
    };

    /**
     * 把各种形态的错误变成一句人话：DSH 的 error 可能是字符串、`{ message }`、
     * `{ code, diagnostic }` 或嵌套对象，直接 String() 会渲染成 `[object Object]`。
     */
    function errorText(value) {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      if (typeof value?.message === 'string' && value.message.length > 0) return value.message;
      if (typeof value?.diagnostic === 'string' && value.diagnostic.length > 0) return value.diagnostic;
      if (typeof value?.code === 'string' && value.code.length > 0) return value.code;
      try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
      } catch {
        return String(value);
      }
    }

    /**
     * 失败原因摘要：pnpm / registry 的错误常常是多行原文，整段塞进红字会把界面撑爆。
     * 取最有用的一行（优先 ERR_* 或 HTTP 4xx/5xx），其余放 title 里让用户 hover 看全文。
     */
    function summarizeError(value, limit = 180) {
      const full = errorText(value).replace(/\s+/gu, ' ').trim();
      if (full.length === 0) return '';
      const parts = full.split(' ').filter((part) => part.length > 0);
      const keyIndex = parts.findIndex((part) => /ERR_[A-Z0-9_]+/u.test(part) || /HTTP \d{3}/iu.test(part));
      const merged = full;
      const summary = keyIndex >= 0 ? parts.slice(keyIndex, keyIndex + 6).join(' ') : parts.slice(0, 12).join(' ');
      const text = summary.length > 0 ? summary : merged;
      return text.length > limit ? `${text.slice(0, limit)}…` : text;
    }

    const INSTALL_ERROR = (raw) => {
      const result = unwrapRemote(raw);
      return errorText(result?.error) || '安装新版本失败';
    };

    /**
     * 一键热更新（对齐 ds-bot 的安装顺序）：先直接安装目标版本（非 HMR 的部署可原地升级）；
     * 被 already-installed 拒绝（HMR 下 profile 已依赖该包）时退成「卸载 → 安装」。
     * 失败时尽量装回当前版本，不能让用户手里没有插件。
     */
    async function runHotUpdate(manager, plan, currentVersion) {
      const spec = typeof plan?.spec === 'string' ? plan.spec : undefined;
      if (
        manager === undefined ||
        manager === null ||
        typeof manager.installBundle !== 'function' ||
        typeof manager.removeBundle !== 'function'
      ) {
        return { ok: false, reason: 'NO_PLUGIN_MANAGER', error: '当前 DSH 没有提供插件管理服务，请手动更新' };
      }
      if (spec === undefined) return { ok: false, reason: 'NO_TARGET', error: '没有可安装的目标版本' };
      const options = typeof plan?.registry === 'string' ? { saveExact: true, registry: plan.registry } : { saveExact: true };
      const done = (raw) => {
        const result = unwrapRemote(raw);
        return {
          ok: true,
          application: String(result?.application ?? 'applied'),
          ...(result?.restartReason === undefined ? {} : { restartReason: String(result.restartReason) }),
        };
      };

      /** 从 registry spec 里取出目标版本；git/path spec 不解析，返回 undefined。 */
      const targetVersion = (() => {
        const prefix = `${PACKAGE_NAME}@`;
        if (!spec.startsWith(prefix)) return undefined;
        return cleanVersion(spec.slice(prefix.length));
      })();

      /**
       * 安装完再问管理器：真的把目标版本装上了才算成功，避免「包膜里失败、界面报成功」。
       * profile 清单可能有几百毫秒延迟，所以最多轮询 4 次（约 750ms）再下结论，避免误报失败。
       */
      const installedVersion = async () => {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            const list = unwrapRemote(await manager.listBundles?.());
            if (Array.isArray(list)) return cleanVersion(list.find((bundle) => bundle?.name === PACKAGE_NAME)?.version);
          } catch {
            /* 读不到就再试一次 */
          }
          if (attempt < 4) await wait(250);
        }
        return undefined;
      };

      const confirmed = async (raw) => {
        // 没有 listBundles（更老的 DSH）就没有复核手段，按安装结果算
        if (targetVersion === undefined || typeof manager.listBundles !== 'function') return done(raw);
        const version = await installedVersion();
        // 读不到版本（管理器不支持/临时读失败）时按安装结果算；读到了但不是目标版本才算失败
        if (version !== undefined && version !== targetVersion) {
          return {
            ok: false,
            reason: 'INSTALL_UNCONFIRMED',
            error: `已发起安装 v${targetVersion}，但插件管理器报告的仍是 v${version ?? '未知'}`,
          };
        }
        return done(raw);
      };

      // 1) 直接安装：非 HMR 的部署走这条路就地升级，不会先把自己卸掉
      let first;
      try {
        first = await manager.installBundle(spec, options);
      } catch (error) {
        first = { error: { message: String(error?.message ?? error) } };
      }
      if (!INSTALL_FAILED(first)) return await confirmed(first);
      const firstValue = unwrapRemote(first);
      if (firstValue?.error?.code !== 'already-installed') {
        return { ok: false, reason: 'INSTALL_FAILED', error: INSTALL_ERROR(first) };
      }

      // 2) HMR 下 profile 已依赖该包：只能卸载再装（DSH 官方对第三方插件的更新方式）
      try {
        const removed = await manager.removeBundle(PACKAGE_NAME);
        if (INSTALL_FAILED(removed)) {
          return {
            ok: false,
            reason: 'REMOVE_FAILED',
            error: errorText(unwrapRemote(removed)?.error) || '卸载旧版本失败',
          };
        }
      } catch (error) {
        return { ok: false, reason: 'REMOVE_FAILED', error: String(error?.message ?? error) };
      }

      let installed;
      try {
        installed = await manager.installBundle(spec, options);
      } catch (error) {
        installed = { error: { message: String(error?.message ?? error) } };
      }
      if (!INSTALL_FAILED(installed)) return await confirmed(installed);

      // 3) 回滚：装回当前版本（git/path 安装用原来的 spec，registry 用当前版本号 pin 住）
      let rollback = 'unknown';
      const restoreSpec =
        typeof plan?.currentSpec === 'string' && plan.currentSpec.length > 0
          ? plan.currentSpec
          : `${PACKAGE_NAME}@${currentVersion}`;
      try {
        const restored = await manager.installBundle(restoreSpec, options);
        rollback = INSTALL_FAILED(restored) ? 'failed' : 'ok';
      } catch (rollbackError) {
        rollback = `failed：${String(rollbackError?.message ?? rollbackError)}`;
      }
      // 卸载成功、安装失败时插件可能停在「停用」状态：尽量启用回来，别让用户手里没插件
      let reenabled;
      try {
        if (typeof manager.setBundleEnabled === 'function') {
          const answer = unwrapRemote(await manager.setBundleEnabled(PACKAGE_NAME, true));
          reenabled = answer?.error === undefined;
        }
      } catch {
        reenabled = false;
      }
      return {
        ok: false,
        reason: 'INSTALL_FAILED',
        error: INSTALL_ERROR(installed),
        rollback,
        ...(reenabled === undefined ? {} : { reenabled }),
      };
    }
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
.${MOD}-warning{color:var(--dsw-alias-state-warning-primary,#f5a524);font-size:12px}
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
.${MOD}-star{margin-top:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:12px}
.${MOD}-star a{color:var(--dsw-alias-label-secondary);text-decoration:none;border-bottom:1px dotted var(--dsw-alias-border-l3);cursor:pointer}
.${MOD}-star a:hover{color:var(--dsw-alias-label-primary)}
.${MOD}-panelHead{display:flex;align-items:center;gap:8px;padding:2px 2px 0}
.${MOD}-panelTitle{font-size:12px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.${MOD}-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.${MOD}-panelHead .${MOD}-refresh{margin-left:auto}
.${MOD}-group{display:flex;flex-direction:column;gap:4px;margin-bottom:6px}
.${MOD}-groupHead{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:3px 2px;border:0;background:transparent;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}
.${MOD}-groupHead:disabled{cursor:default;opacity:1}
.${MOD}-groupHead:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-groupLabel{display:flex;align-items:center;gap:5px;min-width:0}
.${MOD}-groupChevron{width:12px;flex:none;color:var(--dsw-alias-label-tertiary)}
.${MOD}-groupBody{display:flex;flex-direction:column;gap:4px}
.${MOD}-hostEntry{display:flex;flex-direction:column;gap:3px}
.${MOD}-hostRowItem{position:relative;display:flex;align-items:center;gap:3px}
.${MOD}-hostRowItem .${MOD}-item{flex:1;width:auto;min-width:0;padding-right:8px}
.${MOD}-rowTools{display:flex;align-items:center;gap:2px;flex:none}
.${MOD}-tool{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 6px;font:inherit;font-size:11px;line-height:1.4;cursor:pointer;min-height:26px;white-space:nowrap}
.${MOD}-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-tool:disabled{opacity:.5;cursor:default}
.${MOD}-tool:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-connectAction{color:var(--dsw-alias-label-primary);font-weight:600}
.${MOD}-toolOn{color:var(--dsw-alias-state-accent-primary,#4d6bfe)}
.${MOD}-hostMenu{position:relative;display:flex}
.${MOD}-hostMenu summary{list-style:none;display:flex;align-items:center;justify-content:center;min-width:26px;box-sizing:border-box}
.${MOD}-hostMenu summary::-webkit-details-marker{display:none}
.${MOD}-hostMenu[open] summary{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-hostMenuPanel{position:absolute;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;gap:2px;min-width:180px;box-sizing:border-box;padding:5px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lg,0 8px 24px rgb(0 0 0 / 12%))}
.${MOD}-hostMenuItem{border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 8px;font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.${MOD}-hostMenuItem:hover,.${MOD}-hostMenuItem:focus-visible{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));outline:0}
.${MOD}-hostMenuDiagnostic{max-width:240px;padding:7px 8px;border-top:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:normal;overflow-wrap:anywhere}
.${MOD}-groupEditor{display:flex;align-items:center;gap:8px;padding:2px 4px 6px}
.${MOD}-groupInput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-state-accent-primary,#4d6bfe);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;padding:5px 8px}
.${MOD}-itemTitleLine{display:flex;align-items:center;gap:8px;min-width:0}
.${MOD}-hostConnected{flex:none;color:var(--dsw-alias-state-success-primary,#247b50);font-size:11px;font-weight:400;white-space:nowrap}
.${MOD}-jumpOk{color:var(--dsw-alias-label-secondary)}
.${MOD}-jumpBad{color:var(--dsw-alias-state-warning-primary,#92400e)}
.${MOD}-rfRoot{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:13px/1.5 var(--dsw-font-sans,system-ui,sans-serif);background:var(--dsw-alias-bg-layer-1)}
.${MOD}-rfHeader{display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);box-sizing:border-box;flex-wrap:wrap}
.${MOD}-rfHeader .${MOD}-rfPath{flex:1;min-width:0}
.${MOD}-rfSession{display:flex;align-items:center;gap:8px;flex:1;min-width:120px}
.${MOD}-rfEditorSession{display:flex;align-items:center;gap:7px;min-width:0;max-width:45%}
.${MOD}-rfHostName{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${MOD}-rfLive{flex:none;color:var(--dsw-alias-state-success-primary,#247b50);font-size:11px;white-space:nowrap}
.${MOD}-rfHeaderActions{display:flex;align-items:center;gap:5px;flex:none}
.${MOD}-rfHostSelect{max-width:150px;min-width:0;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px}
.${MOD}-rfHostSelect:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-rfPathBar{display:flex;align-items:center;gap:5px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.${MOD}-rfBreadcrumbs{display:flex;align-items:center;gap:1px;flex:1;min-width:120px;overflow-x:auto;white-space:nowrap;scrollbar-width:thin}
.${MOD}-rfCrumb{border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px;cursor:pointer;flex:none}
.${MOD}-rfCrumb:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-rfCrumb:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-rfCrumbCurrent{color:var(--dsw-alias-label-primary);font-weight:600}
.${MOD}-rfCrumbSeparator{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}
.${MOD}-rfPathEdit{display:flex;align-items:center;gap:6px;flex:1;min-width:180px}
.${MOD}-rfPathInput{flex:1;min-width:120px;box-sizing:border-box;border:0;border-bottom:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;font:12px/1.5 var(--dsw-font-mono,ui-monospace,monospace);padding:5px 2px}
.${MOD}-rfPathInput:focus-visible{outline:0;border-bottom-color:var(--dsw-alias-state-accent-primary,#4d6bfe)}
.${MOD}-rfHint{padding:5px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${MOD}-rfNotice{padding:4px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:pre-wrap}
.${MOD}-rfTree{flex:1;min-height:0;overflow:auto;padding:4px 6px 16px}
.${MOD}-rfLevel{list-style:none;margin:0;padding:0}
.${MOD}-rfRow{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;min-height:32px;padding:5px 10px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left}
button.${MOD}-rfRow{cursor:pointer}
button.${MOD}-rfRow:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
button.${MOD}-rfRowActive{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
button.${MOD}-rfRow:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:-2px}
.${MOD}-rfName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${MOD}-rfFolder{width:16px;height:16px;flex:none;color:var(--dsw-alias-label-secondary)}
.${MOD}-rfFileIcon{flex:none}
.${MOD}-rfSize{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.${MOD}-rfOther{color:var(--dsw-alias-label-tertiary)}
.${MOD}-rfState{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.${MOD}-rfEditor .${MOD}-rfHeader{gap:12px}
.${MOD}-rfToolbar{display:flex;align-items:center;gap:10px;padding:6px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.${MOD}-rfHost{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${MOD}-rfLanguage{flex:none;color:var(--dsw-alias-label-secondary);font-weight:600}
.${MOD}-rfViewTabs{display:flex;align-items:center;gap:2px;padding:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-rfViewTab{min-height:24px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 9px;font:inherit;font-size:11px;cursor:pointer}
.${MOD}-rfViewTab:hover{color:var(--dsw-alias-label-primary)}
.${MOD}-rfViewTabActive{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.${MOD}-rfViewTab:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-rfDirty{color:var(--dsw-alias-state-warning-primary,#b7791f);white-space:nowrap}
.${MOD}-rfCode{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:13px/1.65 var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);padding:16px 18px;tab-size:2}
.${MOD}-rfCode:focus{outline:0}
.${MOD}-rfCodeEditor{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.${MOD}-rfHighlight,.${MOD}-rfCodeInput{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;border:0;border-radius:0;font:13px/22px var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);tab-size:2;white-space:pre}
.${MOD}-rfHighlight{overflow:hidden;pointer-events:none;padding:12px 16px 12px 0;color:var(--dsw-alias-label-primary)}
.${MOD}-rfCodeInput{flex:none;min-height:0;resize:none;overflow:auto;padding:12px 16px 12px 58px;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);-webkit-text-fill-color:transparent}
.${MOD}-rfCodeInput::selection{background:var(--dsw-alias-state-accent-secondary,rgb(77 107 254 / 20%))}
.${MOD}-rfCodeLine{display:flex;align-items:flex-start;min-width:max-content;min-height:22px;box-sizing:border-box}
.${MOD}-rfCodeLine code{flex:1;min-width:max-content;white-space:pre;font:inherit}
.${MOD}-rfLineNumber{display:inline-block;flex:none;width:44px;box-sizing:border-box;padding-right:14px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;user-select:none}
.${MOD}-rfCodeLineBad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c4242a) 10%,transparent)}
.${MOD}-rfCodeLineBad .${MOD}-rfLineNumber{color:var(--dsw-alias-state-error-primary,#c4242a);font-weight:600}
.${MOD}-rfToken-key{color:var(--dsw-alias-state-accent-primary,#4d6bfe)}
.${MOD}-rfToken-string{color:var(--dsw-alias-state-success-primary,#247b50)}
.${MOD}-rfToken-number{color:var(--dsw-alias-state-warning-primary,#925e0b)}
.${MOD}-rfToken-keyword{color:var(--dsw-alias-label-primary);font-weight:600}
.${MOD}-rfToken-comment{color:var(--dsw-alias-label-tertiary);font-style:italic}
.${MOD}-rfToken-punctuation{color:var(--dsw-alias-label-secondary)}
.${MOD}-rfCodeRead{flex:1;min-height:0;overflow:auto;padding:12px 16px 12px 0;background:var(--dsw-alias-bg-layer-1);font:13px/22px var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);tab-size:2}
.${MOD}-rfValidation{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.${MOD}-rfValidationBad{color:var(--dsw-alias-state-error-primary,#c4242a)}
.${MOD}-rfMarkdown{flex:1;min-height:0;overflow:auto;padding:24px 30px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1)}
.${MOD}-rfMarkdownBody{max-width:880px;margin:0 auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.75;overflow-wrap:break-word}
.${MOD}-rfMarkdownBody h1,.${MOD}-rfMarkdownBody h2,.${MOD}-rfMarkdownBody h3,.${MOD}-rfMarkdownBody h4,.${MOD}-rfMarkdownBody h5,.${MOD}-rfMarkdownBody h6{margin:1.4em 0 .55em;line-height:1.3;letter-spacing:-.015em;color:var(--dsw-alias-label-primary)}
.${MOD}-rfMarkdownBody h1{margin-top:0;font-size:26px}
.${MOD}-rfMarkdownBody h2{font-size:21px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.${MOD}-rfMarkdownBody h3{font-size:17px}
.${MOD}-rfMarkdownBody h4,.${MOD}-rfMarkdownBody h5,.${MOD}-rfMarkdownBody h6{font-size:14px}
.${MOD}-rfMarkdownBody p{margin:.75em 0;white-space:pre-line}
.${MOD}-rfMarkdownBody ul,.${MOD}-rfMarkdownBody ol{margin:.65em 0;padding-left:24px}
.${MOD}-rfMarkdownBody li{margin:.25em 0;padding-left:2px;white-space:pre-line}
.${MOD}-rfMarkdownBody a{color:var(--dsw-alias-state-accent-primary,#4d6bfe);text-decoration:none;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3))}
.${MOD}-rfMarkdownBody a:hover{text-decoration:underline;border-bottom-color:transparent}
.${MOD}-rfMarkdownBody hr{border:0;border-top:1px solid var(--dsw-alias-border-l3);margin:24px 0}
.${MOD}-rfMarkdownBody blockquote{margin:16px 0;padding:2px 0 2px 14px;border-left:3px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3));color:var(--dsw-alias-label-secondary)}
.${MOD}-rfMarkdownBody blockquote p{margin:.35em 0}
.${MOD}-rfMdInlineCode{padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));font:12px/1.5 var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.${MOD}-rfMdCode{margin:16px 0;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))}
.${MOD}-rfMdCode figcaption{padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px}
.${MOD}-rfMdCode pre{margin:0;padding:12px 14px;overflow:auto;font:12px/1.65 var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre}
.${MOD}-rfMdCode code{font:inherit}
.${MOD}-rfMdTableScroll{max-width:100%;margin:16px 0;overflow:auto}
.${MOD}-rfMarkdownBody table{border-collapse:collapse;min-width:45%;font-size:13px}
.${MOD}-rfMarkdownBody th,.${MOD}-rfMarkdownBody td{padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);vertical-align:top}
.${MOD}-rfMarkdownBody th{color:var(--dsw-alias-label-secondary);font-weight:600}
.${MOD}-rfMdImage{display:inline-block;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px}
.${MOD}-rfMdEmpty{color:var(--dsw-alias-label-tertiary)}
.${MOD}-rfSaved{color:var(--dsw-alias-state-success-primary,#2f9e44);font-size:11px}
.${MOD}-rfFooter{display:flex;align-items:center;gap:12px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.${MOD}-rfShortcut{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.${MOD}-rfEmpty{align-items:flex-start;justify-content:center;padding:28px;gap:12px;box-sizing:border-box}
.${MOD}-status{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 2px}
.${MOD}-search{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:12px/1.4 var(--dsw-font-sans,system-ui,sans-serif);padding:6px 10px}
.${MOD}-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.${MOD}-search:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-item{flex-direction:row;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-color:transparent;background:transparent;border-radius:8px}
.${MOD}-item:hover{background:var(--dsw-alias-bg-layer-1)}
.${MOD}-item:focus-visible{outline:2px solid var(--dsw-alias-state-accent-primary,#4d6bfe);outline-offset:1px}
.${MOD}-itemBody{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.${MOD}-itemTitle{font-size:13px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.${MOD}-itemSub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.${MOD}-chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1}
.${MOD}-item:hover .${MOD}-chevron{color:var(--dsw-alias-label-primary)}
.${MOD}-itemGhost{border-style:dashed;background:transparent}
.${MOD}-emptyBox{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.${MOD}-emptyTitle{font-size:12px;font-weight:600}
.${MOD}-emptyText{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${MOD}-linkButton{align-self:flex-start;border:0;background:transparent;color:var(--dsw-alias-state-accent-primary,#4d6bfe);font:inherit;font-size:11px;padding:0;cursor:pointer}
.${MOD}-linkButton:hover{text-decoration:underline}
.${MOD}-linkButton:disabled{opacity:.45;cursor:default;text-decoration:none}
.${MOD}-section{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3)}
.${MOD}-sectionHead{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.${MOD}-sectionRow{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px}
.${MOD}-sectionMain{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${MOD}-sectionMeta{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.${MOD}-fileName{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${MOD}-importRow{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-primary)}
.${MOD}-footer{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.${MOD}-footer .${MOD}-dot{opacity:.6}
.${MOD}-spacer{flex:1}
@media (max-width: 420px){
.${MOD}-root{padding:10px;gap:6px}
.${MOD}-panelHead{flex-wrap:wrap}
.${MOD}-search{font-size:16px;padding:8px 10px}
.${MOD}-item{padding:10px}
.${MOD}-itemTitle{font-size:14px}
.${MOD}-itemSub{font-size:11px}
.${MOD}-tool{min-height:36px;padding:4px 7px}
.${MOD}-hostMenu summary{min-width:32px}
.${MOD}-groupEditor{align-items:flex-start;flex-direction:column;gap:4px}
.${MOD}-groupInput{width:100%;flex:none}
.${MOD}-rfHeader{align-items:flex-start}
.${MOD}-rfSession{min-width:150px}
.${MOD}-rfHeaderActions{margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.${MOD}-rfHint{white-space:normal;overflow-wrap:anywhere}
.${MOD}-rfToolbar{gap:7px;padding:6px 10px}
.${MOD}-rfViewTab{min-height:32px;padding:4px 10px}
.${MOD}-rfMarkdown{padding:18px 16px}
.${MOD}-rfMarkdownBody h1{font-size:22px}
.${MOD}-rfMarkdownBody h2{font-size:19px}
.${MOD}-rfShortcut{display:none}
.${MOD}-rfFooter{gap:9px;padding:8px 10px}
.${MOD}-footer{font-size:11px;gap:4px}
.${MOD}-spacer{display:none}
}
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
    function SshGuide({ title, description, useTabInfo, kind = KIND }) {
      const { tab } = useTabInfo();
      return h(
        'div',
        { className: `${MOD}-entry`, 'data-sidebar-right-guide-entry': kind },
        h(primitives.Button, {
          variant: 'ghost',
          className: `${MOD}-main`,
          'aria-label': description === undefined ? title : `${title} ${description}`,
          onClick: () => tab.actions.openTab(kind, { replaceTab: true }),
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

        /** 最近一次连接的时间，只存在浏览器本地：面板用它排序、显示「上次连接」。 */
    const RECENT_KEY = 'dsh-remote-console.recent-hosts.v1';
    // 宿主注册的只读状态路由（ctx.webServer）；拿不到就静默不显示
    const STATUS_ROUTE = '/plugins/dsh-remote-console/state.json';
    const FILES_ROUTE = '/plugins/dsh-remote-console/files.json';
    const FILES_DOWNLOAD_ROUTE = '/plugins/dsh-remote-console/files/download';
    const FILES_UPLOAD_ROUTE = '/plugins/dsh-remote-console/files/upload';
    const FILES_DELETE_ROUTE = '/plugins/dsh-remote-console/files/delete';
    const FILES_READ_ROUTE = '/plugins/dsh-remote-console/files/read';
    const FILES_HOME_ROUTE = '/plugins/dsh-remote-console/files/home';
    const PANEL_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
    const SSH_CONFIG_ROUTE = '/plugins/dsh-remote-console/ssh-config.json';
    const HOSTS_META_ROUTE = '/plugins/dsh-remote-console/hosts-meta.json';
    const HOST_PREFS_KEY = 'dsh-remote-console.host-prefs.v1';
    const RECENT_MAX = 20;
    // 超过一个月的时间不再展示：陈旧信息比没有信息更误导
    const RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    function readRecent(storage = globalThis.localStorage) {
      try {
        const raw = storage?.getItem(RECENT_KEY);
        if (typeof raw !== 'string' || raw === '') return {};
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const kept = {};
        for (const [path, at] of Object.entries(parsed)) {
          if (typeof path === 'string' && Number.isFinite(at)) kept[path] = at;
        }
        return kept;
      } catch {
        return {};
      }
    }

    function noteRecent(path, at = Date.now(), storage = globalThis.localStorage) {
      if (typeof path !== 'string' || path === '') return readRecent(storage);
      const recent = readRecent(storage);
      recent[path] = at;
      const next = Object.fromEntries(
        Object.entries(recent)
          .sort((left, right) => right[1] - left[1])
          .slice(0, RECENT_MAX),
      );
      try {
        storage?.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // 隐私模式禁用 localStorage 时退化成「不记忆」，面板照常可用
      }
      return next;
    }

    /** 相对时间副标题；超出保留期或时间异常返回 null。 */
    function relativeTime(now, then) {
      if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
      const delta = now - then;
      if (delta < 0 || delta > RECENT_TTL_MS) return null;
      if (delta < 60 * 1000) return '刚刚';
      const minutes = Math.floor(delta / (60 * 1000));
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.floor(hours / 24)} 天前`;
    }

    /** 按标题或路径过滤，空查询原样返回。 */
    function filterShells(shells, query) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (needle === '') return shells;
      return shells.filter((shell) => `${label(shell)} ${shell?.path ?? ''}`.toLowerCase().includes(needle));
    }

    /** 最近连过的排前面；从未连过的保持宿主给的顺序（排序是稳定的）。 */
    function orderShells(shells, recent) {
      const at = (shell) => Number(recent?.[shell?.path]) || 0;
      return [...shells].sort((left, right) => at(right) - at(left));
    }

    /** 面板里的分组与置顶：纯用户偏好，只存浏览器本地，不写宿主配置。 */
    function readHostPrefs(storage = globalThis.localStorage) {
      try {
        const raw = storage?.getItem(HOST_PREFS_KEY);
        if (typeof raw !== 'string' || raw === '') return { pinned: [], groups: {} };
        const parsed = JSON.parse(raw);
        const pinned = Array.isArray(parsed?.pinned) ? parsed.pinned.filter((item) => typeof item === 'string') : [];
        const groups = {};
        if (parsed?.groups !== null && typeof parsed.groups === 'object' && !Array.isArray(parsed.groups)) {
          for (const [alias, name] of Object.entries(parsed.groups)) {
            if (typeof alias === 'string' && typeof name === 'string' && name.trim() !== '') groups[alias] = name.trim();
          }
        }
        return { pinned, groups };
      } catch {
        return { pinned: [], groups: {} };
      }
    }

    function writeHostPrefs(prefs, storage = globalThis.localStorage) {
      try {
        storage?.setItem(HOST_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 隐私模式禁用 localStorage：退化为「本次会话有效」，面板照常用
      }
      return prefs;
    }

    function togglePinned(alias, prefs, storage = globalThis.localStorage) {
      const pinned = prefs.pinned.includes(alias)
        ? prefs.pinned.filter((item) => item !== alias)
        : [...prefs.pinned, alias];
      return writeHostPrefs({ ...prefs, pinned }, storage);
    }

    function setHostGroup(alias, name, prefs, storage = globalThis.localStorage) {
      const groups = { ...prefs.groups };
      if (name.trim() === '') delete groups[alias];
      else groups[alias] = name.trim();
      return writeHostPrefs({ ...prefs, groups }, storage);
    }

    /** 别名 → 元信息；meta 里可能有 user@host:port，用短别名也能匹配上。 */
    function hostMetaMap(meta) {
      const map = new Map();
      if (!Array.isArray(meta)) return map;
      for (const entry of meta) {
        if (entry !== null && typeof entry === 'object' && typeof entry.host === 'string') map.set(entry.host, entry);
      }
      return map;
    }

    /**
     * 先呈现当前要用的会话，再呈现用户自己的分组。
     * 置顶优先级最高，其次是在线终端和最近连接；没有活动信息时保持原有分组行为。
     */
    function groupShells(shells, prefs, activity = {}) {
      const pinnedSet = new Set(prefs.pinned);
      const consoles = activity.consoles ?? [];
      const now = activity.now ?? Date.now();
      const pinned = shells.filter((shell) => pinnedSet.has(shortLabel(shell)));
      const afterPinned = shells.filter((shell) => !pinnedSet.has(shortLabel(shell)));
      const online = afterPinned.filter((shell) => findConsoleForHost(consoles, shortLabel(shell)) !== undefined);
      const afterOnline = afterPinned.filter((shell) => findConsoleForHost(consoles, shortLabel(shell)) === undefined);
      const recentCandidates = afterOnline.filter((shell) => relativeTime(now, activity.recent?.[shell.path]) !== null);
      const recent = recentCandidates.slice(0, 5);
      const recentPaths = new Set(recent.map((shell) => shell.path));
      const rest = afterOnline.filter((shell) => !recentPaths.has(shell.path));
      const buckets = new Map();
      for (const shell of rest) {
        const key = prefs.groups[shortLabel(shell)] ?? '';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(shell);
      }
      const groups = [];
      if (pinned.length > 0) groups.push({ name: '置顶', kind: 'pinned', priority: true, shells: pinned });
      if (online.length > 0) groups.push({ name: '已连接', kind: 'connected', priority: true, shells: online });
      if (recent.length > 0) groups.push({ name: '最近连接', kind: 'recent', priority: true, shells: recent });
      const named = [...buckets.keys()].filter((key) => key !== '').sort((left, right) => left.localeCompare(right));
      for (const key of named) groups.push({ name: key, kind: 'named', priority: false, shells: buckets.get(key) });
      if (buckets.has('')) groups.push({ name: '未分组', kind: 'ungrouped', priority: false, shells: buckets.get('') });
      return groups;
    }

    function consoleDisplayName(entry) {
      if (entry === undefined || entry === null) return '远端';
      if (typeof entry.host !== 'string' || entry.host === '') return entry.user ?? entry.pid ?? '远端';
      const user = typeof entry.user === 'string' && entry.user !== '' ? `${entry.user}@` : '';
      const port = typeof entry.port === 'string' && entry.port !== '' ? `:${entry.port}` : '';
      return `${user}${entry.host}${port}`;
    }

    function directTargetKey(value) {
      const text = String(value ?? '').trim();
      if (!text.includes('@') && !text.includes(':')) return null;
      let user = '';
      let host = text;
      const at = text.indexOf('@');
      if (at >= 0) {
        user = text.slice(0, at);
        host = text.slice(at + 1);
      }
      let port = '';
      if ((host.match(/:/gu) ?? []).length === 1) {
        const index = host.indexOf(':');
        port = host.slice(index + 1);
        host = host.slice(0, index);
      }
      if (host === '') return null;
      return `${user}\u0000${host}\u0000${port === '' ? '22' : port}`;
    }

    function consoleTargetKey(entry) {
      if (typeof entry?.host !== 'string' || entry.host === '') return null;
      const user = typeof entry.user === 'string' ? entry.user : '';
      const port = typeof entry.port === 'string' && entry.port !== '' ? entry.port : '22';
      return `${user}\u0000${entry.host}\u0000${port}`;
    }

    function findConsoleForHost(consoles, host) {
      const targetKey = directTargetKey(host);
      return (consoles ?? []).find((entry) => {
        if (entry?.host === host) return true;
        return targetKey !== null && consoleTargetKey(entry) === targetKey;
      });
    }

    /** 直连 Tab 把端口放到前面；完整目标仍由主机行和文件页头展示。 */
    function compactHostLabel(host) {
      let value = String(host ?? '').trim();
      if (value.length > 16 && value.includes('@')) value = value.slice(value.indexOf('@') + 1);
      const ipv4 = /^(?:\d{1,3}\.){3}(\d{1,3}):(\d{1,5})$/u.exec(value);
      if (ipv4 !== null) return `:${ipv4[2]} · …${ipv4[1]}`;
      return value;
    }

    function terminalTitleForHost(host) {
      const label = compactHostLabel(host);
      return label === '' ? 'SSH 终端' : `终端 · ${label}`;
    }

    /** 原生终端创建完成后重命名；失败或超时只放弃美化，不影响连接。 */
    function renameTerminalWhenReady(view, title, pending) {
      if (view === undefined || typeof view.rename !== 'function' || typeof view.state?.subscribe !== 'function') return () => {};
      let done = false;
      let unsubscribe;
      let timer;
      const cleanup = () => {
        if (done) return;
        done = true;
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        pending?.delete(cleanup);
      };
      pending?.add(cleanup);
      const check = () => {
        if (done) return;
        const state = view.state.getSnapshot();
        if (state.info !== undefined) {
          cleanup();
          Promise.resolve(view.rename(title)).catch(() => {});
        } else if (state.phase === 'failed' || state.phase === 'closed') cleanup();
      };
      unsubscribe = view.state.subscribe(check);
      if (done) unsubscribe?.();
      check();
      if (!done && typeof setTimeout === 'function') {
        timer = setTimeout(cleanup, 15000);
        timer.unref?.();
      }
      return cleanup;
    }

    // 把 ssh 的原始报错翻译成下一步该做什么；识别不了就原样带上
    const ERROR_HINTS = [
      [/permission denied[^]*publickey/iu, '主机拒绝了这把机器的密钥：确认公钥已加到远端账号'],
      [/permission denied/iu, '认证失败：检查用户名、密码或密钥权限'],
      [/could not resolve hostname/iu, '解析不到主机名：检查别名拼写或 DNS'],
      [/connection refused/iu, '端口没有开放：确认 sshd 在跑、端口号正确'],
      [/no route to host/iu, '网络不可达：检查网络或防火墙'],
      [/host key verification failed/iu, '主机指纹变了：确认不是中间人，再更新 known_hosts'],
      [/timed out|timeout/iu, '连接超时：检查网络、端口或跳板机'],
    ];

    /** 会话 id 太长：面板里只留可分辨的头尾。 */
    function shortSessionId(value) {
      const text = String(value ?? '');
      if (text.length <= 14) return text;
      const parts = text.split('-');
      if (parts.length > 2) return `${parts[0]}-…${parts[parts.length - 1].slice(0, 8)}`;
      return `${text.slice(0, 6)}…${text.slice(-4)}`;
    }

    /** 审计窗口显示成本地时间；跨天时带日期。 */
    function clockRange(start, end) {
      const pad = (n) => String(n).padStart(2, '0');
      const time = (value) => {
        const date = new Date(Number(value));
        return Number.isFinite(date.getTime()) ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '?';
      };
      const first = new Date(Number(start));
      const sameDay = Number.isFinite(first.getTime()) && new Date(Number(end)).toDateString() === first.toDateString();
      return sameDay
        ? `${time(start)}–${time(end)}`
        : `${first.getMonth() + 1}/${first.getDate()} ${time(start)}–${time(end)}`;
    }

    /** 文件大小：面板窄，只留一位小数和单位。 */
    function formatSize(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '';
      if (value < 1024) return `${String(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let size = value / 1024;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return `${size.toFixed(1)} ${units[unit]}`;
    }

    function friendlyError(message) {
      const text = String(message ?? '');
      for (const [pattern, hint] of ERROR_HINTS) {
        if (pattern.test(text)) return hint;
      }
      return `读取失败：${text}`;
    }

    /** 面板正文：远端列表（点卡片主区域进入）。 */
    function HostList({ loadShells, connect, openFiles, sessionId }) {
      const [state, setState] = React.useState({ phase: 'loading', shells: [], error: null });
      const [attempt, setAttempt] = React.useState(0);
      const [query, setQuery] = React.useState('');
      const [recent, setRecent] = React.useState(() => readRecent());
      const [status, setStatus] = React.useState(null);
      const [hostMeta, setHostMeta] = React.useState([]);
      const [prefs, setPrefs] = React.useState(() => readHostPrefs());
      const [groupDraft, setGroupDraft] = React.useState({ alias: null, value: '' });
      const [groupOpenOverrides, setGroupOpenOverrides] = React.useState({});
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
      React.useEffect(() => {
        const lifetime = new AbortController();
        if (typeof fetch !== 'function') return () => lifetime.abort();
        const refresh = () => {
          fetch(STATUS_ROUTE, { signal: lifetime.signal, headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (!lifetime.signal.aborted && data !== null && typeof data === 'object') setStatus(data);
            })
            .catch(() => {
              // 宿主没有 webServer（headless/TUI）时这条路由不存在：面板照常工作
            });
        };
        refresh();
        // 面板开着才轮询；页面隐藏时跳过，回来时由下一次 tick 补上
        const timer =
          typeof setInterval === 'function'
            ? setInterval(() => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
                refresh();
              }, 15000)
            : undefined;
        return () => {
          if (timer !== undefined) clearInterval(timer);
          lifetime.abort();
        };
      }, [attempt]);

      React.useEffect(() => {
        if (typeof fetch !== 'function') return;
        const lifetime = new AbortController();
        fetch(HOSTS_META_ROUTE, { signal: lifetime.signal, headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!lifetime.signal.aborted && data !== null && Array.isArray(data.hosts)) setHostMeta(data.hosts);
          })
          .catch(() => {
            // 没有 webServer 时静默：面板仍能按 shell 列表显示主机
          });
        return () => lifetime.abort();
      }, [attempt]);

      const generic = state.phase === 'ready' ? genericShell(state.shells) : undefined;
      const sshShells =
        state.phase === 'ready'
          ? state.shells.filter((shell) => isSshShell(shell) && shell.path !== generic?.path)
          : [];
      const visible = filterShells(orderShells(sshShells, recent), query);
      const now = Date.now();

      const openShell = (shell) => {
        setRecent(noteRecent(shell.path, now));
        const host = shell.path === generic?.path ? undefined : shortLabel(shell);
        connect(shell.path, sessionId, host);
      };

      const meta = hostMetaMap(hostMeta);
      const consoles = Array.isArray(status?.consoleList) ? status.consoleList : [];
      const renderRow = (shell) => {
        const alias = shortLabel(shell);
        const info = meta.get(alias);
        const pinned = prefs.pinned.includes(alias);
        const connectedConsole = findConsoleForHost(consoles, alias);
        const last = relativeTime(now, recent[shell.path]);
        let sub;
        if (info !== undefined && info.jumpOk === false && typeof info.jumpProblem === 'string') {
          sub = h('span', { className: `${MOD}-jumpBad`, title: info.jumpProblem }, '跳板配置需检查');
        } else if (info !== undefined && Array.isArray(info.jumpChain) && info.jumpChain.length > 0) {
          sub = h(
            'span',
            { className: `${MOD}-jumpOk`, title: `经跳板 ${info.jumpChain.join(' → ')}` },
            `经 ${info.jumpChain.join(' → ')}`,
          );
        } else {
          sub = last === null ? '打开终端后输入密码' : `上次连接 · ${last}`;
        }
        const editingGroup = groupDraft.alias === alias;
        const closeMenu = (event) => {
          const details = event.currentTarget.closest('details');
          if (details !== null) details.open = false;
        };
        return h(
          'div',
          { key: shell.path, className: `${MOD}-hostEntry` },
          h(
            'div',
            { className: `${MOD}-hostRowItem` },
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-item`,
                title: shell.path,
                'aria-label': `连接 ${alias}`,
                onClick: () => openShell(shell),
              },
              h(
                'span',
                { className: `${MOD}-itemBody` },
                h(
                  'span',
                  { className: `${MOD}-itemTitleLine` },
                  h('span', { className: `${MOD}-itemTitle` }, alias),
                  connectedConsole !== undefined ? h('span', { className: `${MOD}-hostConnected` }, '● 已连接') : null,
                ),
                h('span', { className: `${MOD}-itemSub` }, sub),
              ),
            ),
            h(
              'span',
              { className: `${MOD}-rowTools` },
              h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-tool ${MOD}-connectAction`,
                  'aria-label': `连接 ${alias}`,
                  onClick: () => openShell(shell),
                },
                '连接',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-tool`,
                  disabled: connectedConsole === undefined,
                  title: connectedConsole === undefined ? '先连接并登录，再浏览文件' : `浏览 ${alias} 的文件`,
                  'aria-label': `打开 ${alias} 的文件`,
                  onClick: () => {
                    if (connectedConsole !== undefined) openFiles(connectedConsole.pid, alias);
                  },
                },
                '文件',
              ),
              h(
                'details',
                { className: `${MOD}-hostMenu` },
                h('summary', { className: `${MOD}-tool`, title: '更多操作', 'aria-label': `更多操作 ${alias}` }, '⋯'),
                h(
                  'div',
                  { className: `${MOD}-hostMenuPanel`, role: 'menu' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `${MOD}-hostMenuItem`,
                      role: 'menuitem',
                      onClick: (event) => {
                        setPrefs((current) => togglePinned(alias, current));
                        closeMenu(event);
                      },
                    },
                    pinned ? '取消置顶' : '置顶这台主机',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `${MOD}-hostMenuItem`,
                      role: 'menuitem',
                      onClick: (event) => {
                        setGroupDraft({ alias, value: prefs.groups[alias] ?? '' });
                        closeMenu(event);
                      },
                    },
                    prefs.groups[alias] === undefined ? '设置分组' : `分组：${prefs.groups[alias]}`,
                  ),
                  info !== undefined && info.jumpOk === false
                    ? h('div', { className: `${MOD}-hostMenuDiagnostic`, role: 'note' }, `跳板异常：${info.jumpProblem}`)
                    : null,
                  info !== undefined && info.jumpOk !== false && Array.isArray(info.jumpChain) && info.jumpChain.length > 0
                    ? h('div', { className: `${MOD}-hostMenuDiagnostic`, role: 'note' }, `跳板链路：${info.jumpChain.join(' → ')}`)
                    : null,
                ),
              ),
            ),
          ),
          editingGroup
            ? h(
                'div',
                { className: `${MOD}-groupEditor` },
                h('input', {
                  type: 'text',
                  className: `${MOD}-groupInput`,
                  value: groupDraft.value,
                  placeholder: '组名（留空取消分组）',
                  'aria-label': `${alias} 的分组名`,
                  autoFocus: true,
                  onChange: (event) => setGroupDraft((current) => ({ ...current, value: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      setPrefs((current) => setHostGroup(alias, groupDraft.value, current));
                      setGroupDraft({ alias: null, value: '' });
                    } else if (event.key === 'Escape') {
                      setGroupDraft({ alias: null, value: '' });
                    }
                  },
                }),
                h('span', { className: `${MOD}-hint` }, '回车保存 · Esc 取消'),
              )
            : null,
        );
      };

      const grouped = groupShells(visible, prefs, { recent, consoles, now });
      const searching = query.trim() !== '';
      const rows = grouped.map((group) => {
        const groupKey = `${group.kind}-${group.name}`;
        const onlyUngrouped = grouped.length === 1 && group.kind === 'ungrouped';
        const defaultOpen = group.priority || onlyUngrouped || searching;
        const open = searching || (groupOpenOverrides[groupKey] ?? defaultOpen);
        const showHead = !onlyUngrouped;
        const bodyId = `dshrc-group-${group.kind}-${encodeURIComponent(group.name)}`;
        return h(
          'div',
          { key: `group-${groupKey}`, className: `${MOD}-group` },
          showHead
            ? h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-groupHead`,
                  'aria-expanded': open,
                  'aria-controls': bodyId,
                  disabled: searching,
                  onClick: () => setGroupOpenOverrides((current) => ({ ...current, [groupKey]: !open })),
                },
                h(
                  'span',
                  { className: `${MOD}-groupLabel` },
                  h('span', { className: `${MOD}-groupChevron`, 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                  group.name,
                ),
                h('span', { className: `${MOD}-count` }, `${String(group.shells.length)} 台`),
              )
            : null,
          open
            ? h('div', { id: bodyId, className: `${MOD}-groupBody` }, ...group.shells.map(renderRow))
            : null,
        );
      });

      const filteredOut = sshShells.length > 0 && visible.length === 0;

      return h(
        'div',
        { className: `${MOD}-root` },
        h(
          'div',
          { className: `${MOD}-panelHead` },
          h('span', { className: `${MOD}-panelTitle` }, '远端'),
          state.phase === 'ready' && sshShells.length > 0
            ? h('span', { className: `${MOD}-count` }, `${sshShells.length} 台`)
            : null,
          h(
            'button',
            {
              type: 'button',
              className: `${MOD}-refresh`,
              onClick: () => setAttempt((n) => n + 1),
              'aria-label': '重新读取远端列表',
            },
            '刷新',
          ),
        ),
        status === null
          ? null
          : h(
              'div',
              { className: `${MOD}-status` },
              h('span', { title: '本会话活着的远端终端数' }, `终端 ${String(status.consoles ?? 0)}`),
              h('span', { className: `${MOD}-dot`, 'aria-hidden': 'true' }, '·'),
              h('span', { title: '当前终端的端口转发数' }, `隧道 ${String(Array.isArray(status.tunnels) ? status.tunnels.length : 0)}`),
              h('span', { className: `${MOD}-dot`, 'aria-hidden': 'true' }, '·'),
              h(
                'span',
                { title: '最近 24 小时的审计：命令数（失败数）' },
                `24h 命令 ${String(status.audit?.commands24h ?? 0)}（失败 ${String(status.audit?.failures24h ?? 0)}）`,
              ),
            ),
        sshShells.length > 4
          ? h('input', {
              type: 'search',
              className: `${MOD}-search`,
              placeholder: '搜索主机名或地址',
              value: query,
              'aria-label': '搜索主机',
              onChange: (event) => setQuery(event.target.value),
            })
          : null,
        state.phase === 'loading' ? h('div', { className: `${MOD}-hint` }, '正在读取远端列表…') : null,
        state.phase === 'error'
          ? h(
              'div',
              { className: `${MOD}-emptyBox` },
              h('div', { className: `${MOD}-error` }, friendlyError(state.error)),
              h(
                'button',
                { type: 'button', className: `${MOD}-linkButton`, onClick: () => setAttempt((n) => n + 1) },
                '重试',
              ),
            )
          : null,
        state.phase === 'ready' && sshShells.length === 0
          ? h(
              'div',
              { className: `${MOD}-emptyBox` },
              h('div', { className: `${MOD}-emptyTitle` }, '还没有配置远端'),
              h(
                'div',
                { className: `${MOD}-emptyText` },
                '在侧栏「插件」→ dsh-remote-console → 主机列表里填一行 ssh 别名或 user@host:port；保存后这里立即出现入口。',
              ),
            )
          : null,
        ...rows,
        filteredOut
          ? h(
              'div',
              { className: `${MOD}-emptyBox` },
              h('div', { className: `${MOD}-emptyTitle` }, `没有匹配「${query.trim()}」的主机`),
              h(
                'button',
                { type: 'button', className: `${MOD}-linkButton`, onClick: () => setQuery('') },
                '清空搜索',
              ),
            )
          : null,
        state.phase === 'ready' && generic !== undefined
          ? h(
              'button',
              { type: 'button', className: `${MOD}-item ${MOD}-itemGhost`, title: generic.path, onClick: () => openShell(generic) },
              h(
                'span',
                { className: `${MOD}-itemBody` },
                h('span', { className: `${MOD}-itemTitle` }, '新建会话'),
                h('span', { className: `${MOD}-itemSub` }, '临时输入 user@ip'),
              ),
              h('span', { className: `${MOD}-chevron`, 'aria-hidden': 'true' }, '›'),
            )
          : null,
        status !== null && Array.isArray(status.consoleList) && status.consoleList.length > 0
          ? h(
              'div',
              { className: `${MOD}-section` },
              h('div', { className: `${MOD}-sectionHead` }, '终端与隧道'),
              ...status.consoleList.map((entry) =>
                h(
                  'div',
                  { className: `${MOD}-sectionRow`, key: `console-${entry.pid}` },
                  h('span', { className: `${MOD}-sectionMain` }, entry.host ?? '远端'),
                  h(
                    'span',
                    { className: `${MOD}-sectionMeta` },
                    entry.user ?? '',
                    ' ',
                    h(
                      'button',
                      { type: 'button', className: `${MOD}-linkButton`, onClick: () => openFiles(entry.pid, consoleDisplayName(entry)) },
                      '文件',
                    ),
                  ),
                ),
              ),
              ...(Array.isArray(status.tunnels) ? status.tunnels : []).map((tunnel) =>
                h(
                  'div',
                  { className: `${MOD}-sectionRow`, key: tunnel.id },
                  h('span', { className: `${MOD}-sectionMain` }, `${tunnel.kind} 127.0.0.1:${String(tunnel.listen)}`),
                  h('span', { className: `${MOD}-sectionMeta` }, tunnel.target),
                ),
              ),
            )
          : null,
        status !== null && Array.isArray(status.audit?.recent) && status.audit.recent.length > 0
          ? h(
              'div',
              { className: `${MOD}-section` },
              h('div', { className: `${MOD}-sectionHead` }, '最近活动'),
              ...status.audit.recent.map((group) =>
                h(
                  'div',
                  { className: `${MOD}-sectionRow`, key: `audit-${group.session}` },
                  h('span', { className: `${MOD}-sectionMain` }, shortSessionId(group.session)),
                  h(
                    'span',
                    { className: `${MOD}-sectionMeta` },
                    `${clockRange(group.startedAt, group.endedAt)} · ${String(group.commands)} 命令${group.failed > 0 ? `（失败 ${String(group.failed)}）` : ''} · 传输 ${String(group.transfers)}`,
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: `${MOD}-footer` },
          h('span', { title: '密码由 ssh 自己在终端里索要，插件不保存任何凭据' }, '密码不落盘'),
          h('span', { className: `${MOD}-dot`, 'aria-hidden': 'true' }, '·'),
          h('span', { title: 'agent 的命令、审批、传输、转发跨会话记录在数据目录 audit/ 下' }, '审计 audit/'),
          h('span', { className: `${MOD}-dot`, 'aria-hidden': 'true' }, '·'),
          h('span', { title: '主机列表在侧栏「插件」→ dsh-remote-console → 配置；agent 也能用 remote_host_add 添加' }, '主机在插件页'),
          h('span', { className: `${MOD}-spacer` }),
          h('span', {}, `v${VERSION}`),
        ),
      );
    }

    function joinRemotePath(parent, name) {
      const base = parent === '/' ? '' : String(parent).replace(/\/$/u, '');
      return `${base}/${name}`;
    }

    function parentRemotePath(path) {
      if (path === '/') return '/';
      const parent = String(path).replace(/\/$/u, '').replace(/\/[^/]+$/u, '');
      return parent === '' ? '/' : parent;
    }

    function basenameRemotePath(path) {
      return String(path).split('/').filter(Boolean).pop() ?? 'download';
    }

    function normalizedRemotePath(path) {
      const value = String(path ?? '/');
      return value === '/' ? '/' : value.replace(/\/+$/u, '');
    }

    function isRemotePathWithin(root, path) {
      const base = normalizedRemotePath(root);
      const target = normalizedRemotePath(path);
      return base === '/' ? target.startsWith('/') : target === base || target.startsWith(`${base}/`);
    }

    /** 面包屑只负责导航显示，实际请求仍使用完整绝对路径。 */
    function remoteBreadcrumbs(path, home = '') {
      const target = normalizedRemotePath(path);
      const homePath = normalizedRemotePath(home);
      if (homePath !== '/' && homePath.startsWith('/') && isRemotePathWithin(homePath, target)) {
        const crumbs = [{ label: '~', path: homePath }];
        let current = homePath;
        for (const part of target.slice(homePath.length).split('/').filter(Boolean)) {
          current = joinRemotePath(current, part);
          crumbs.push({ label: part, path: current });
        }
        return crumbs;
      }
      if (target === '/') return [{ label: '/', path: '/' }];
      const crumbs = [{ label: '/', path: '/' }];
      let current = '/';
      for (const part of target.split('/').filter(Boolean)) {
        current = joinRemotePath(current, part);
        crumbs.push({ label: part, path: current });
      }
      return crumbs;
    }

    function displayRemotePath(path, home = '') {
      const target = normalizedRemotePath(path);
      const homePath = normalizedRemotePath(home);
      if (homePath !== '/' && homePath.startsWith('/') && isRemotePathWithin(homePath, target)) {
        return `~${target.slice(homePath.length)}`;
      }
      return target;
    }

    function uploadLimitMessage(size) {
      const bytes = Number(size);
      const exact = Number.isFinite(bytes) ? bytes.toLocaleString('en-US') : String(size);
      return `单文件上传上限 32 MB（当前 ${formatSize(size)}，${exact} 字节），未发送。`;
    }

    function safeUploadName(name) {
      return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/u.test(name);
    }

    function fileLanguage(path) {
      const name = basenameRemotePath(path).toLowerCase();
      if (/\.(?:md|markdown)$/u.test(name)) return 'markdown';
      if (name.endsWith('.json')) return 'json';
      if (/\.(?:ya?ml)$/u.test(name)) return 'yaml';
      return 'text';
    }

    function languageLabel(language) {
      return { markdown: 'Markdown', json: 'JSON', yaml: 'YAML', text: '纯文本' }[language] ?? '纯文本';
    }

    function textLineColumn(content, position) {
      const offset = Math.max(0, Math.min(String(content).length, Number(position) || 0));
      const before = String(content).slice(0, offset);
      return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
    }

    function structuredError(language, message, line, column) {
      return { valid: false, language, message, ...(line === undefined ? {} : { line, column }) };
    }

    function validateJson(content) {
      try {
        JSON.parse(content);
        return { valid: true, language: 'json' };
      } catch (error) {
        const detail = String(error?.message ?? error);
        const lineMatch = /line\s+(\d+)\s+column\s+(\d+)/iu.exec(detail);
        const positionMatch = /position\s+(\d+)/iu.exec(detail);
        const location = lineMatch !== null
          ? { line: Number(lineMatch[1]), column: Number(lineMatch[2]) }
          : positionMatch !== null
            ? textLineColumn(content, Number(positionMatch[1]))
            : {};
        return structuredError('json', detail, location.line, location.column);
      }
    }

    /**
     * YAML 的客户端检查刻意保持保守：缩进层级、Tab、引号和 flow 括号是确定性错误；
     * 普通标量、多行文本和块标量不做 schema 推断，避免把合法配置误判为错误。
     */
    function validateYaml(content) {
      const lines = String(content).replace(/^\uFEFF/u, '').split('\n');
      const flow = [];
      const indents = [];
      let quote;
      let escaped = false;
      let previousIndent = 0;
      let blockScalarParent;

      for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const raw = lines[index];
        const indentMatch = /^[ \t]*/u.exec(raw)[0];
        if (blockScalarParent !== undefined) {
          if (raw.trim() === '') continue;
          const blockIndent = /^ */u.exec(raw)[0].length;
          if (blockIndent > blockScalarParent || /^\t/u.test(raw)) continue;
          blockScalarParent = undefined;
        }
        const continuedQuote = quote !== undefined;
        if (!continuedQuote && indentMatch.includes('\t')) {
          const column = indentMatch.indexOf('\t') + 1;
          return structuredError('yaml', '缩进不能使用 Tab，请改用空格', lineNumber, column);
        }

        let code = '';
        for (let columnIndex = 0; columnIndex < raw.length; columnIndex += 1) {
          const char = raw[columnIndex];
          const next = raw[columnIndex + 1];
          if (quote !== undefined) {
            if (quote === '"' && escaped) {
              escaped = false;
              continue;
            }
            if (quote === '"' && char === '\\') {
              escaped = true;
              continue;
            }
            if (char === quote) {
              if (quote === "'" && next === "'") {
                columnIndex += 1;
              } else {
                quote = undefined;
              }
            }
            continue;
          }
          if (char === '#' && (columnIndex === 0 || /\s/u.test(raw[columnIndex - 1]))) break;
          code += char;
          if (char === '"' || char === "'") {
            quote = char;
            escaped = false;
            continue;
          }
          if (char === '[' || char === '{') flow.push({ char, line: lineNumber, column: columnIndex + 1 });
          if (char === ']' || char === '}') {
            const expected = char === ']' ? '[' : '{';
            const opened = flow.pop();
            if (opened?.char !== expected) {
              return structuredError('yaml', `括号 ${char} 没有匹配的开始括号`, lineNumber, columnIndex + 1);
            }
          }
        }

        const trimmed = code.trim();
        if (!continuedQuote && trimmed !== '' && trimmed !== '---' && trimmed !== '...' && !trimmed.startsWith('%')) {
          const indent = /^ */u.exec(raw)[0].length;
          if (indents.length === 0) {
            indents.push(indent);
          } else if (indent > previousIndent) {
            indents.push(indent);
          } else if (indent < previousIndent) {
            while (indents.length > 0 && indents[indents.length - 1] > indent) indents.pop();
            if (indents.length === 0 || indents[indents.length - 1] !== indent) {
              return structuredError('yaml', '缩进层级与上级结构不一致', lineNumber, indent + 1);
            }
          }
          previousIndent = indent;
          if (/[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/u.test(trimmed)) blockScalarParent = indent;
        }
      }

      if (quote !== undefined) return structuredError('yaml', `引号 ${quote} 没有闭合`, lines.length, Math.max(1, lines.at(-1).length));
      if (flow.length > 0) {
        const opened = flow.at(-1);
        return structuredError('yaml', `括号 ${opened.char} 没有闭合`, opened.line, opened.column);
      }
      return { valid: true, language: 'yaml' };
    }

    function validateFileContent(content, language) {
      if (language === 'json') return validateJson(content);
      if (language === 'yaml') return validateYaml(content);
      return { valid: true, language };
    }

    function formatJson(content) {
      const validation = validateJson(content);
      return validation.valid ? `${JSON.stringify(JSON.parse(content), null, 2)}\n` : undefined;
    }

    function safeMarkdownHref(href) {
      const value = String(href ?? '').trim();
      return /^https?:\/\/[^\s]+$/iu.test(value) ? value : undefined;
    }

    /** 生成数据结构而不是 HTML；React 负责转义，远程 Markdown 的原始 HTML 不会执行。 */
    function markdownInline(text) {
      const source = String(text ?? '');
      const nodes = [];
      const pattern = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/gu;
      let cursor = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) nodes.push({ type: 'text', text: source.slice(cursor, match.index) });
        if (match[2] !== undefined) nodes.push({ type: 'code', text: match[2] });
        else if (match[3] !== undefined) nodes.push({ type: 'image', alt: match[3], href: match[4] });
        else if (match[5] !== undefined) nodes.push({ type: 'link', text: match[5], href: safeMarkdownHref(match[6]) });
        else if (match[7] !== undefined || match[8] !== undefined) nodes.push({ type: 'strong', text: match[7] ?? match[8] });
        else if (match[9] !== undefined) nodes.push({ type: 'delete', text: match[9] });
        else nodes.push({ type: 'emphasis', text: match[10] ?? match[11] });
        cursor = pattern.lastIndex;
      }
      if (cursor < source.length) nodes.push({ type: 'text', text: source.slice(cursor) });
      return nodes;
    }

    function markdownTableCells(line) {
      let value = line.trim();
      if (value.startsWith('|')) value = value.slice(1);
      if (value.endsWith('|')) value = value.slice(0, -1);
      return value.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll('\\|', '|'));
    }

    function markdownTableSeparator(line) {
      const cells = markdownTableCells(line);
      return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
    }

    function markdownBlockStart(lines, index) {
      const line = lines[index] ?? '';
      return /^ {0,3}(?:#{1,6}\s+|>|```|~~~)/u.test(line)
        || /^ {0,3}(?:[-+*]|\d+[.)])\s+/u.test(line)
        || /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line)
        || (index + 1 < lines.length && line.includes('|') && markdownTableSeparator(lines[index + 1]));
    }

    function markdownBlocks(content) {
      const lines = String(content ?? '').replace(/\r\n?/gu, '\n').split('\n');
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') {
          index += 1;
          continue;
        }
        const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s]*)/u.exec(line);
        if (fence !== null) {
          const marker = fence[1][0];
          const size = fence[1].length;
          const code = [];
          index += 1;
          while (index < lines.length && !new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${size},}\\s*$`, 'u').test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          blocks.push({ type: 'code', language: fence[2].toLowerCase(), text: code.join('\n') });
          continue;
        }
        const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(line);
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/u, '') });
          index += 1;
          continue;
        }
        if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line)) {
          blocks.push({ type: 'rule' });
          index += 1;
          continue;
        }
        if (/^ {0,3}>/u.test(line)) {
          const quoted = [];
          while (index < lines.length && /^ {0,3}>/u.test(lines[index])) {
            quoted.push(lines[index].replace(/^ {0,3}> ?/u, ''));
            index += 1;
          }
          blocks.push({ type: 'quote', blocks: markdownBlocks(quoted.join('\n')) });
          continue;
        }
        if (index + 1 < lines.length && line.includes('|') && markdownTableSeparator(lines[index + 1])) {
          const head = markdownTableCells(line);
          const aligns = markdownTableCells(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
          const rows = [];
          index += 2;
          while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
            rows.push(markdownTableCells(lines[index]));
            index += 1;
          }
          blocks.push({ type: 'table', head, aligns, rows });
          continue;
        }
        const list = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
        if (list !== null) {
          const ordered = /^\d/u.test(list[1]);
          const items = [];
          const itemPattern = /^ {0,3}(?:[-+*]|\d+[.)])\s+(.+)$/u;
          while (index < lines.length) {
            const item = itemPattern.exec(lines[index]);
            if (item !== null && /^\d/u.test(lines[index].trim()) === ordered) {
              items.push(item[1]);
              index += 1;
            } else if (items.length > 0 && /^\s{2,}\S/u.test(lines[index])) {
              items[items.length - 1] += `\n${lines[index].trim()}`;
              index += 1;
            } else break;
          }
          blocks.push({ type: 'list', ordered, items });
          continue;
        }
        const paragraph = [line.trim()];
        index += 1;
        while (index < lines.length && lines[index].trim() !== '' && !markdownBlockStart(lines, index)) {
          paragraph.push(lines[index].trim());
          index += 1;
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      }
      return blocks;
    }

    function token(type, text) {
      return { type, text };
    }

    function tokenizeJsonLine(line) {
      const tokens = [];
      let plain = '';
      let index = 0;
      const flush = () => {
        if (plain !== '') tokens.push(token('plain', plain));
        plain = '';
      };
      while (index < line.length) {
        const char = line[index];
        if (char === '"') {
          flush();
          let end = index + 1;
          let escaped = false;
          while (end < line.length) {
            const current = line[end];
            if (!escaped && current === '"') {
              end += 1;
              break;
            }
            if (!escaped && current === '\\') escaped = true;
            else escaped = false;
            end += 1;
          }
          const text = line.slice(index, end);
          tokens.push(token(/^\s*:/u.test(line.slice(end)) ? 'key' : 'string', text));
          index = end;
          continue;
        }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(line.slice(index));
        if (number !== null && /[-\d]/u.test(char)) {
          flush();
          tokens.push(token('number', number[0]));
          index += number[0].length;
          continue;
        }
        const keyword = /^(?:true|false|null)\b/u.exec(line.slice(index));
        if (keyword !== null) {
          flush();
          tokens.push(token('keyword', keyword[0]));
          index += keyword[0].length;
          continue;
        }
        if (/[{}\[\],:]/u.test(char)) {
          flush();
          tokens.push(token('punctuation', char));
        } else plain += char;
        index += 1;
      }
      flush();
      return tokens.length > 0 ? tokens : [token('plain', '')];
    }

    function tokenizeYamlLine(line) {
      let commentAt = line.length;
      let quote;
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== undefined) {
          if (quote === '"' && escaped) escaped = false;
          else if (quote === '"' && char === '\\') escaped = true;
          else if (char === quote) {
            if (quote === "'" && line[index + 1] === "'") index += 1;
            else quote = undefined;
          }
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
          commentAt = index;
          break;
        }
      }
      const code = line.slice(0, commentAt);
      const tokens = [];
      const prefix = /^(\s*(?:-\s+)?)(.*)$/u.exec(code);
      let rest = prefix?.[2] ?? code;
      if (prefix?.[1]) tokens.push(token(prefix[1].includes('-') ? 'punctuation' : 'plain', prefix[1]));
      const key = /^((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^:#]+?))(:)(?=\s|$)/u.exec(rest);
      if (key !== null) {
        tokens.push(token('key', key[1]), token('punctuation', key[2]));
        rest = rest.slice(key[0].length);
      }
      let index = 0;
      while (index < rest.length) {
        const char = rest[index];
        if (char === '"' || char === "'") {
          let end = index + 1;
          while (end < rest.length) {
            if (rest[end] === char) {
              if (char === "'" && rest[end + 1] === "'") end += 1;
              else if (char !== '"' || rest[end - 1] !== '\\') {
                end += 1;
                break;
              }
            }
            end += 1;
          }
          tokens.push(token('string', rest.slice(index, end)));
          index = end;
          continue;
        }
        const scalar = /^(?:true|false|null|~|yes|no|on|off)\b|^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\b/iu.exec(rest.slice(index));
        if (scalar !== null) {
          tokens.push(token(/^(?:\d|-)/u.test(scalar[0]) ? 'number' : 'keyword', scalar[0]));
          index += scalar[0].length;
          continue;
        }
        if (/[{}\[\],]/u.test(char)) tokens.push(token('punctuation', char));
        else {
          let end = index + 1;
          while (end < rest.length && !/["'{}\[\],]/u.test(rest[end])) {
            if (/^(?:true|false|null|~|yes|no|on|off)\b|^-?(?:\d+(?:\.\d+)?|\.\d+)/iu.test(rest.slice(end))) break;
            end += 1;
          }
          tokens.push(token('plain', rest.slice(index, end)));
          index = end;
          continue;
        }
        index += 1;
      }
      if (commentAt < line.length) tokens.push(token('comment', line.slice(commentAt)));
      return tokens.length > 0 ? tokens : [token('plain', '')];
    }

    function tokenizeCodeLine(line, language) {
      if (language === 'json') return tokenizeJsonLine(line);
      if (language === 'yaml') return tokenizeYamlLine(line);
      return [token('plain', line)];
    }

    function renderInline(text, prefix) {
      return markdownInline(text).map((node, index) => {
        const key = `${prefix}-${index}`;
        if (node.type === 'code') return h('code', { key, className: `${MOD}-rfMdInlineCode` }, node.text);
        if (node.type === 'strong') return h('strong', { key }, node.text);
        if (node.type === 'emphasis') return h('em', { key }, node.text);
        if (node.type === 'delete') return h('del', { key }, node.text);
        if (node.type === 'link' && node.href !== undefined) {
          return h('a', { key, href: node.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, node.text);
        }
        if (node.type === 'image') return h('span', { key, className: `${MOD}-rfMdImage` }, `[图片：${node.alt || '未命名'}]`);
        return h(React.Fragment, { key }, node.text);
      });
    }

    function MarkdownView({ content }) {
      const blocks = React.useMemo(() => markdownBlocks(content), [content]);
      const renderBlock = (block, index) => {
        const key = `md-${index}`;
        if (block.type === 'heading') return h(`h${block.level}`, { key }, renderInline(block.text, key));
        if (block.type === 'rule') return h('hr', { key });
        if (block.type === 'quote') return h('blockquote', { key }, block.blocks.map(renderBlock));
        if (block.type === 'code') {
          return h(
            'figure',
            { key, className: `${MOD}-rfMdCode` },
            block.language ? h('figcaption', {}, block.language) : null,
            h('pre', {}, h('code', {}, block.text)),
          );
        }
        if (block.type === 'list') {
          return h(block.ordered ? 'ol' : 'ul', { key }, block.items.map((item, itemIndex) => h('li', { key: `${key}-${itemIndex}` }, renderInline(item, `${key}-${itemIndex}`))));
        }
        if (block.type === 'table') {
          return h(
            'div',
            { key, className: `${MOD}-rfMdTableScroll` },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, block.head.map((cell, cellIndex) => h('th', { key: `h-${cellIndex}`, style: { textAlign: block.aligns[cellIndex] ?? 'left' } }, renderInline(cell, `${key}-h-${cellIndex}`))))),
              h('tbody', {}, block.rows.map((row, rowIndex) => h('tr', { key: `r-${rowIndex}` }, block.head.map((_, cellIndex) => h('td', { key: `c-${cellIndex}`, style: { textAlign: block.aligns[cellIndex] ?? 'left' } }, renderInline(row[cellIndex] ?? '', `${key}-${rowIndex}-${cellIndex}`)))))),
            ),
          );
        }
        return h('p', { key }, renderInline(block.text, key));
      };
      return h(
        'div',
        { className: `${MOD}-rfMarkdown`, 'data-language': 'markdown' },
        h('article', { className: `${MOD}-rfMarkdownBody` }, blocks.length > 0 ? blocks.map(renderBlock) : h('p', { className: `${MOD}-rfMdEmpty` }, '空白 Markdown 文档')),
      );
    }

    function renderCodeTokens(line, language, keyPrefix) {
      return tokenizeCodeLine(line, language).map((entry, index) => h('span', { key: `${keyPrefix}-${index}`, className: `${MOD}-rfToken-${entry.type}` }, entry.text));
    }

    function CodeReadView({ content, language, errorLine }) {
      return h(
        'div',
        { className: `${MOD}-rfCodeRead`, 'data-language': language, role: 'document', 'aria-label': `${languageLabel(language)} 只读源码` },
        ...content.split('\n').map((line, index) => h(
          'div',
          { key: `line-${index}`, className: `${MOD}-rfCodeLine${errorLine === index + 1 ? ` ${MOD}-rfCodeLineBad` : ''}` },
          h('span', { className: `${MOD}-rfLineNumber`, 'aria-hidden': 'true' }, String(index + 1)),
          h('code', {}, renderCodeTokens(line, language, `read-${index}`)),
        )),
      );
    }

    function CodeEditor({ content, language, errorLine, disabled, label, onChange, onSave }) {
      const highlightRef = React.useRef(null);
      return h(
        'div',
        { className: `${MOD}-rfCodeEditor`, 'data-language': language },
        h(
          'pre',
          { ref: highlightRef, className: `${MOD}-rfHighlight`, 'aria-hidden': 'true' },
          ...content.split('\n').map((line, index) => h(
            'div',
            { key: `line-${index}`, className: `${MOD}-rfCodeLine${errorLine === index + 1 ? ` ${MOD}-rfCodeLineBad` : ''}` },
            h('span', { className: `${MOD}-rfLineNumber` }, String(index + 1)),
            h('code', {}, renderCodeTokens(line, language, `edit-${index}`)),
          )),
        ),
        h('textarea', {
          className: `${MOD}-rfCode ${MOD}-rfCodeInput`,
          value: content,
          disabled,
          spellCheck: false,
          wrap: 'off',
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
          onScroll: (event) => {
            if (highlightRef.current !== null) {
              highlightRef.current.scrollTop = event.target.scrollTop;
              highlightRef.current.scrollLeft = event.target.scrollLeft;
            }
          },
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              onSave();
            }
          },
        }),
      );
    }

    function RemoteFilesTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      const host = tab?.navigation?.params?.host ?? tab?.params?.host ?? '';
      const title = host === '' ? '远程文件' : `文件 · ${compactHostLabel(host)}`;
      return h('span', { className: `${MOD}-rfTabTitle`, title: host === '' ? title : `${title}（${host}）` }, title);
    }

    /**
     * 独立「远程文件」页：原生 DSH 的树/文档布局，SSH 自己的数据源。
     * 一层展开才读一层；编辑器与树共用同一个活着的终端，不建立第二条连接。
     */
    function RemoteFiles({ useTabInfo }) {
      const { tab } = useTabInfo();
      const initialPid = tab?.navigation?.params?.pid ?? tab?.params?.pid ?? null;
      const initialHost = tab?.navigation?.params?.host ?? tab?.params?.host ?? '';
      const [consoles, setConsoles] = React.useState([]);
      const [token, setToken] = React.useState(undefined);
      const [pid, setPid] = React.useState(initialPid);
      const [root, setRoot] = React.useState('');
      const [homePath, setHomePath] = React.useState('');
      const [currentDir, setCurrentDir] = React.useState('');
      const [rootDraft, setRootDraft] = React.useState('');
      const [pathEditing, setPathEditing] = React.useState(false);
      const [levels, setLevels] = React.useState({});
      const [expanded, setExpanded] = React.useState({});
      const [file, setFile] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [fileMode, setFileMode] = React.useState('read');
      const uploadRef = React.useRef(null);
      const generationRef = React.useRef(0);

      const current = consoles.find((entry) => entry.pid === pid);
      const hostLabel = initialHost !== '' ? initialHost : consoleDisplayName(current);
      const language = file === null ? 'text' : fileLanguage(file.path);
      const validation = React.useMemo(
        () => file === null ? { valid: true, language: 'text' } : validateFileContent(file.content, language),
        [file?.content, language],
      );

      // 同 kind 的 DSH 页面会复用 tab；外部再次 openTab 时只更新 navigation，不会重建组件。
      React.useEffect(() => {
        setPid((currentPid) => initialPid !== null && initialPid !== currentPid ? initialPid : currentPid);
      }, [initialPid, tab?.navigation?.revision]);

      const loadLevel = async (path) => {
        if (pid === null || path === '') return;
        const generation = generationRef.current;
        setLevels((currentLevels) => ({ ...currentLevels, [path]: { ...(currentLevels[path] ?? {}), loading: true, error: null } }));
        try {
          const response = await fetch(`${FILES_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(path)}`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(await response.text());
          const data = await response.json();
          if (generation !== generationRef.current) return;
          setLevels((currentLevels) => ({
            ...currentLevels,
            [path]: { loading: false, entries: Array.isArray(data.entries) ? data.entries : [], error: null },
          }));
        } catch (error) {
          if (generation !== generationRef.current) return;
          setLevels((currentLevels) => ({
            ...currentLevels,
            [path]: { loading: false, entries: currentLevels[path]?.entries ?? [], error: String(error?.message ?? error) },
          }));
        }
      };

      React.useEffect(() => {
        let alive = true;
        const refresh = async () => {
          try {
            const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const data = await response.json();
            if (!alive) return;
            const list = Array.isArray(data.consoleList) ? data.consoleList : [];
            setConsoles(list);
            setToken(typeof data.token === 'string' ? data.token : undefined);
            setPid((currentPid) => list.some((entry) => entry.pid === currentPid) ? currentPid : list[0]?.pid ?? null);
          } catch {
            // 没有 webServer 或实例暂时不可达：保留已加载内容
          }
        };
        void refresh();
        const timer = setInterval(refresh, 15000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      React.useEffect(() => {
        generationRef.current += 1;
        setHomePath('');
        setCurrentDir('');
        setPathEditing(false);
        if (pid === null) {
          setRoot('');
          return;
        }
        let alive = true;
        setRoot('');
        setLevels({});
        setExpanded({});
        setFile(null);
        setNotice(null);
        fetch(`${FILES_HOME_ROUTE}?pid=${encodeURIComponent(pid)}`, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            if (!response.ok) throw new Error(await response.text());
            return response.json();
          })
          .then((data) => {
            if (!alive) return;
            const path = typeof data.path === 'string' && data.path.startsWith('/') ? data.path : '/';
            setHomePath(path);
            setRoot(path);
            setCurrentDir(path);
            setRootDraft(path);
          })
          .catch((error) => {
            if (!alive) return;
            setHomePath('/');
            setRoot('/');
            setCurrentDir('/');
            setRootDraft('/');
            setNotice(`无法读取远端 home，已退回根目录：${String(error?.message ?? error)}`);
          });
        return () => {
          alive = false;
        };
      }, [pid]);

      React.useEffect(() => {
        generationRef.current += 1;
        if (pid !== null && root !== '') void loadLevel(root);
        // 切换终端或根目录时重新读根层；子层在展开时读取
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pid, root]);

      const changeRoot = (requestedPath) => {
        const path = String(requestedPath ?? rootDraft).trim();
        if (!path.startsWith('/')) {
          setNotice('远端路径必须是绝对路径，例如 /home/user');
          return;
        }
        setNotice(null);
        setLevels({});
        setExpanded({});
        setFile(null);
        setRootDraft(path);
        setCurrentDir(path);
        setPathEditing(false);
        if (path === root) {
          // React 不会对相同的 root 再跑 effect；但刚才已经清空列表，必须显式重读。
          generationRef.current += 1;
          void loadLevel(path);
        } else {
          setRoot(path);
        }
      };

      const navigateDirectory = (path) => {
        if (!path.startsWith('/')) return;
        if (root !== '' && isRemotePathWithin(root, path)) {
          setNotice(null);
          setCurrentDir(path);
          setRootDraft(path);
          setPathEditing(false);
          if (levels[path] === undefined) void loadLevel(path);
        } else {
          changeRoot(path);
        }
      };

      const openFile = async (path) => {
        if (pid === null) return;
        const generation = generationRef.current;
        setFileMode(fileLanguage(path) === 'text' ? 'edit' : 'read');
        setFile({ path, content: '', original: '', loading: true, saving: false, saved: false, loadError: null, error: null });
        setConfirmDelete(false);
        try {
          const response = await fetch(`${FILES_READ_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(path)}`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(await response.text());
          const data = await response.json();
          if (generation !== generationRef.current) return;
          const content = typeof data.content === 'string' ? data.content : '';
          setFile({ path, content, original: content, loading: false, saving: false, saved: false, loadError: null, error: null });
        } catch (error) {
          if (generation !== generationRef.current) return;
          setFile({ path, content: '', original: '', loading: false, saving: false, saved: false, loadError: String(error?.message ?? error), error: null });
        }
      };

      const saveFile = async () => {
        if (file === null || pid === null || token === undefined || file.loadError !== null || file.saving) return;
        // 不能只依赖按钮 disabled：快捷键和未来的调用方也必须经过同一份内容校验。
        if (!validateFileContent(file.content, fileLanguage(file.path)).valid) return;
        setFile((currentFile) => ({ ...currentFile, saving: true, saved: false, error: null }));
        try {
          const body = typeof TextEncoder === 'function' ? new TextEncoder().encode(file.content) : file.content;
          const response = await fetch(`${FILES_UPLOAD_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(file.path)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-dsh-rc-token': token },
            body,
          });
          if (!response.ok) throw new Error(await response.text());
          setFile((currentFile) => ({ ...currentFile, original: currentFile.content, saving: false, saved: true, error: null }));
          setNotice(`已保存 ${file.path}`);
          void loadLevel(parentRemotePath(file.path));
        } catch (error) {
          setFile((currentFile) => ({ ...currentFile, saving: false, error: String(error?.message ?? error) }));
        }
      };

      const downloadPath = (path) => {
        if (pid === null || typeof document === 'undefined') return;
        const link = document.createElement('a');
        link.href = `${FILES_DOWNLOAD_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(path)}`;
        link.download = basenameRemotePath(path);
        document.body.appendChild(link);
        link.click();
        link.remove();
      };

      const deleteFile = async () => {
        if (file === null || pid === null || token === undefined) return;
        if (!confirmDelete) {
          setConfirmDelete(true);
          return;
        }
        setBusy('delete');
        try {
          const response = await fetch(`${FILES_DELETE_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(file.path)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-dsh-rc-token': token },
          });
          if (!response.ok) throw new Error(await response.text());
          const parent = parentRemotePath(file.path);
          setFile(null);
          setConfirmDelete(false);
          setNotice('已删除');
          void loadLevel(parent);
        } catch (error) {
          setNotice(String(error?.message ?? error));
        } finally {
          setBusy('');
        }
      };

      const uploadFile = async (localFile) => {
        if (localFile === undefined || pid === null || token === undefined) return;
        if (!safeUploadName(localFile.name)) {
          setNotice('文件名不能包含路径分隔符');
          return;
        }
        if (Number(localFile.size) > PANEL_UPLOAD_LIMIT_BYTES) {
          setNotice(uploadLimitMessage(localFile.size));
          return;
        }
        const targetDir = currentDir || root;
        const remotePath = joinRemotePath(targetDir, localFile.name);
        setBusy('upload');
        setNotice(null);
        try {
          const response = await fetch(`${FILES_UPLOAD_ROUTE}?pid=${encodeURIComponent(pid)}&path=${encodeURIComponent(remotePath)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-dsh-rc-token': token },
            body: localFile,
          });
          if (!response.ok) throw new Error(await response.text());
          setNotice(`已上传到 ${targetDir}`);
          void loadLevel(targetDir);
        } catch (error) {
          setNotice(String(error?.message ?? error));
        } finally {
          setBusy('');
        }
      };

      const FolderOpen = primitives.IconFolderOpenRegular;
      const FolderClosed = primitives.IconFolderCloseRegular;
      const FileTypeIcon = primitives.FileTypeIcon;
      const pathLabel = (path) => h(
        'span',
        { className: `${MOD}-rfPath`, title: path },
        displayRemotePath(path, homePath),
      );
      const fileIcon = (name) => FileTypeIcon === undefined
        ? null
        : h(FileTypeIcon, {
            kind: typeof primitives.classifyFileType === 'function' ? primitives.classifyFileType(name) : 'text',
            size: 16,
            className: `${MOD}-rfFileIcon`,
          });

      if (consoles.length === 0) {
        return h(
          'div',
          { className: `${MOD}-rfRoot ${MOD}-rfEmpty` },
          h('div', { className: `${MOD}-emptyTitle` }, '先登录一台远端'),
          h('div', { className: `${MOD}-emptyText` }, '远程文件复用已经登录的 SSH 终端。先去「SSH 远程」打开终端并输入密码，再回来浏览文件。'),
          h(
            'button',
            { type: 'button', className: `${MOD}-save`, onClick: () => tab.actions.openTab(KIND, { replaceTab: true }) },
            '打开 SSH 远程',
          ),
        );
      }

      if (file !== null) {
        const dirty = file.content !== file.original;
        const updateContent = (content) => setFile((currentFile) => ({ ...currentFile, content, saved: false, error: null }));
        const saveShortcut = () => {
          if (dirty && validation.valid && !file.saving) void saveFile();
        };
        return h(
          'div',
          {
            className: `${MOD}-rfRoot ${MOD}-rfEditor`,
            onKeyDown: (event) => {
              if (event.defaultPrevented) return;
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveShortcut();
              }
            },
          },
          h(
            'div',
            { className: `${MOD}-rfHeader` },
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-linkButton`,
                onClick: () => {
                  if (dirty && file.error !== '有未保存修改：先保存，或再点一次返回放弃修改。') setFile((currentFile) => ({ ...currentFile, error: '有未保存修改：先保存，或再点一次返回放弃修改。' }));
                  else setFile(null);
                },
              },
              '← 文件树',
            ),
            h(
              'span',
              { className: `${MOD}-rfEditorSession` },
              h('span', { className: `${MOD}-rfHostName` }, hostLabel),
              h('span', { className: `${MOD}-rfLive` }, '● 已连接'),
            ),
            pathLabel(file.path),
          ),
          h(
            'div',
            { className: `${MOD}-rfToolbar` },
            h('span', { className: `${MOD}-rfLanguage` }, languageLabel(language)),
            language !== 'text' && file.loadError === null ? h(
              'div',
              { className: `${MOD}-rfViewTabs`, role: 'tablist', 'aria-label': '文件视图' },
              ...['read', 'edit'].map((mode) => h(
                'button',
                {
                  key: mode,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': fileMode === mode,
                  className: `${MOD}-rfViewTab${fileMode === mode ? ` ${MOD}-rfViewTabActive` : ''}`,
                  onClick: () => setFileMode(mode),
                },
                mode === 'read' ? '阅读' : '编辑',
              )),
            ) : null,
            dirty ? h('span', { className: `${MOD}-rfDirty` }, '未保存') : null,
            h('span', { className: `${MOD}-spacer` }),
            language === 'json' && fileMode === 'edit' && file.loadError === null ? h(
              'button',
              {
                type: 'button',
                className: `${MOD}-linkButton`,
                disabled: file.loading || file.saving || !validation.valid,
                onClick: () => {
                  const formatted = formatJson(file.content);
                  if (formatted !== undefined) updateContent(formatted);
                },
              },
              '格式化',
            ) : null,
            h('button', { type: 'button', className: `${MOD}-linkButton`, onClick: () => downloadPath(file.path) }, '下载'),
            h(
              'button',
              { type: 'button', className: `${MOD}-linkButton`, disabled: busy === 'delete', onClick: deleteFile },
              confirmDelete ? '确认删除' : '删除',
            ),
          ),
          file.loading ? h('div', { className: `${MOD}-hint` }, '读取中…') : null,
          file.loadError !== null ? h('div', { className: `${MOD}-error`, role: 'alert' }, file.loadError) : null,
          file.error !== null ? h('div', { className: `${MOD}-error` }, file.error) : null,
          !file.loading && file.loadError === null && !validation.valid ? h(
            'div',
            { className: `${MOD}-rfValidation ${MOD}-rfValidationBad`, role: 'alert', id: 'dshrc-file-validation' },
            `${languageLabel(language)} 校验未通过${validation.line === undefined ? '' : `：第 ${validation.line} 行，第 ${validation.column} 列`} · ${validation.message}`,
          ) : null,
          !file.loading && file.loadError === null
            ? fileMode === 'read' && language === 'markdown'
              ? h(MarkdownView, { content: file.content })
              : fileMode === 'read' && language !== 'text'
                ? h(CodeReadView, { content: file.content, language, errorLine: validation.line })
                : language !== 'text'
                  ? h(CodeEditor, {
                      content: file.content,
                      language,
                      errorLine: validation.line,
                      disabled: file.saving,
                      label: `编辑 ${file.path}`,
                      onChange: updateContent,
                      onSave: saveShortcut,
                    })
                  : h('textarea', {
                      className: `${MOD}-rfCode`,
                      value: file.content,
                      disabled: file.loading || file.saving,
                      spellCheck: false,
                      'aria-label': `编辑 ${file.path}`,
                      onChange: (event) => updateContent(event.target.value),
                    })
            : null,
          h(
            'div',
            { className: `${MOD}-rfFooter` },
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-save`,
                disabled: file.loadError !== null || file.saving || !dirty || !validation.valid,
                title: validation.valid ? '保存到远端' : validation.message,
                'aria-describedby': validation.valid ? undefined : 'dshrc-file-validation',
                onClick: saveFile,
              },
              file.saving ? '保存中…' : '保存',
            ),
            file.saved === true ? h('span', { className: `${MOD}-rfSaved`, role: 'status' }, '已保存') : null,
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-linkButton`,
                onClick: () => setFile((currentFile) => ({ ...currentFile, content: currentFile.original, saved: false, error: null })),
                disabled: file.loadError !== null || !dirty,
              },
              '还原修改',
            ),
            h('span', { className: `${MOD}-spacer` }),
            h('span', { className: `${MOD}-rfShortcut` }, 'Ctrl / ⌘+S 保存'),
          ),
        );
      }

      const renderLevel = (path, depth) => {
        const level = levels[path];
        if (level === undefined) return null;
        const rows = [];
        if (level.loading) rows.push(h('li', { key: 'loading', className: `${MOD}-rfState` }, '读取中…'));
        if (level.error !== null) rows.push(h('li', { key: 'error', className: `${MOD}-error` }, level.error));
        for (const entry of level.entries ?? []) {
          const child = joinRemotePath(path, entry.name);
          if (entry.type === 'dir') {
            const open = expanded[child] === true;
            rows.push(h(
              'li',
              { key: child },
              h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-rfRow ${currentDir === child ? `${MOD}-rfRowActive` : ''}`,
                  style: { paddingLeft: `${10 + depth * 18}px` },
                  'aria-expanded': open,
                  'aria-current': currentDir === child ? 'location' : undefined,
                  onClick: async () => {
                    const next = !open;
                    setCurrentDir(child);
                    setRootDraft(child);
                    setPathEditing(false);
                    setNotice(null);
                    setExpanded((currentExpanded) => ({ ...currentExpanded, [child]: next }));
                    if (next) await loadLevel(child);
                  },
                },
                FolderClosed === undefined
                  ? h('span', { className: `${MOD}-rfFolder` }, open ? '▾' : '▸')
                  : h(open ? FolderOpen : FolderClosed, { className: `${MOD}-rfFolder` }),
                h('span', { className: `${MOD}-rfName` }, entry.name),
              ),
              open ? renderLevel(child, depth + 1) : null,
            ));
          } else {
            rows.push(h(
              'li',
              { key: child },
              h(
                entry.type === 'file' ? 'button' : 'div',
                {
                  type: entry.type === 'file' ? 'button' : undefined,
                  className: `${MOD}-rfRow ${entry.type === 'file' ? '' : `${MOD}-rfOther`}`,
                  style: { paddingLeft: `${10 + depth * 18}px` },
                  onClick: entry.type === 'file' ? () => openFile(child) : undefined,
                },
                fileIcon(entry.name),
                h('span', { className: `${MOD}-rfName` }, entry.name),
                entry.type === 'file' ? h('span', { className: `${MOD}-rfSize` }, formatSize(entry.size)) : null,
              ),
            ));
          }
        }
        if (!level.loading && level.error === null && (level.entries ?? []).length === 0) {
          rows.push(h('li', { key: 'empty', className: `${MOD}-rfState` }, '空目录'));
        }
        return h('ul', { key: path, className: `${MOD}-rfLevel` }, ...rows);
      };

      const shownDir = currentDir || root;
      const crumbs = remoteBreadcrumbs(shownDir || '/', homePath);

      return h(
        'div',
        { className: `${MOD}-rfRoot` },
        h(
          'div',
          { className: `${MOD}-rfHeader` },
          h(
            'div',
            { className: `${MOD}-rfSession` },
            h('span', { className: `${MOD}-rfHostName`, title: hostLabel }, hostLabel),
            h('span', { className: `${MOD}-rfLive` }, '● 已连接'),
          ),
          h(
            'div',
            { className: `${MOD}-rfHeaderActions` },
            consoles.length > 1
              ? h(
                  'select',
                  {
                    className: `${MOD}-rfHostSelect`,
                    value: pid ?? '',
                    'aria-label': '选择远端终端',
                    onChange: (event) => {
                      const nextPid = event.target.value;
                      const next = consoles.find((entry) => entry.pid === nextPid);
                      const host = consoleDisplayName(next);
                      setPid(nextPid);
                      if (typeof tab.actions?.openTab === 'function') {
                        tab.actions.openTab(FILES_KIND, { replaceTab: true, params: { pid: nextPid, host } });
                      } else {
                        setPid(nextPid);
                      }
                    },
                  },
                  ...consoles.map((entry) => h('option', { key: entry.pid, value: entry.pid }, consoleDisplayName(entry))),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-refresh`,
                title: '刷新当前目录',
                disabled: shownDir === '',
                onClick: () => loadLevel(shownDir),
              },
              '刷新',
            ),
            h(
              'button',
              {
                type: 'button',
                className: `${MOD}-refresh`,
                title: `上传到 ${shownDir}`,
                onClick: () => uploadRef.current?.click(),
                disabled: busy === 'upload' || shownDir === '',
              },
              busy === 'upload' ? '上传中…' : '上传',
            ),
            h('input', {
              ref: uploadRef,
              type: 'file',
              style: { display: 'none' },
              onChange: (event) => {
                void uploadFile(event.target.files?.[0]);
                event.target.value = '';
              },
            }),
          ),
        ),
        h(
          'div',
          { className: `${MOD}-rfPathBar` },
          pathEditing
            ? h(
                'div',
                { className: `${MOD}-rfPathEdit` },
                h('input', {
                  className: `${MOD}-rfPathInput`,
                  value: rootDraft,
                  spellCheck: false,
                  autoFocus: true,
                  'aria-label': '远端目录',
                  onChange: (event) => setRootDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') changeRoot();
                    if (event.key === 'Escape') {
                      setRootDraft(shownDir);
                      setPathEditing(false);
                    }
                  },
                }),
                h('button', { type: 'button', className: `${MOD}-refresh`, onClick: () => changeRoot() }, '前往'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: `${MOD}-refresh`,
                    onClick: () => {
                      setRootDraft(shownDir);
                      setPathEditing(false);
                    },
                  },
                  '取消',
                ),
              )
            : h(
                'nav',
                { className: `${MOD}-rfBreadcrumbs`, 'aria-label': '远端路径' },
                ...crumbs.flatMap((crumb, index) => {
                  const currentCrumb = index === crumbs.length - 1;
                  const parts = [];
                  if (index > 0) parts.push(h('span', { key: `sep-${crumb.path}`, className: `${MOD}-rfCrumbSeparator`, 'aria-hidden': 'true' }, '/'));
                  parts.push(h(
                    'button',
                    {
                      key: crumb.path,
                      type: 'button',
                      className: `${MOD}-rfCrumb ${currentCrumb ? `${MOD}-rfCrumbCurrent` : ''}`,
                      title: crumb.path,
                      'aria-label': `进入 ${crumb.path}`,
                      'aria-current': currentCrumb ? 'page' : undefined,
                      onClick: () => navigateDirectory(crumb.path),
                    },
                    crumb.label,
                  ));
                  return parts;
                }),
              ),
          pathEditing
            ? null
            : h('button', { type: 'button', className: `${MOD}-refresh`, disabled: shownDir === '', onClick: () => navigateDirectory(homePath || '/') }, '主目录'),
          pathEditing
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-refresh`,
                  disabled: shownDir === '' || shownDir === '/',
                  onClick: () => navigateDirectory(parentRemotePath(shownDir)),
                },
                '上级',
              ),
          pathEditing
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-refresh`,
                  disabled: shownDir === '',
                  onClick: () => {
                    setRootDraft(shownDir);
                    setPathEditing(true);
                  },
                },
                '编辑路径',
              ),
        ),
        h('div', { className: `${MOD}-rfHint` }, `上传位置：${displayRemotePath(shownDir || '/', homePath)}`),
        notice !== null ? h('div', { className: `${MOD}-rfNotice`, role: 'status' }, notice) : null,
        h('div', { className: `${MOD}-rfTree` }, root === '' ? h('div', { className: `${MOD}-hint` }, '正在定位远端 home…') : renderLevel(root, 0)),
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

    /** 冲突类错误值得重读 revision 再试；字段不可写之类的错误重试也不会变。 */
    const CONFLICT_RE = /changed since it was read|revision|\bconflict\b/iu;

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * 直接走 DSH settings 服务写入（可选路径）。configForms 的 form.mutate 只返回 true/false，
     * 真实错误（例如「字段不是 volatile」）被它吞掉，排查只能靠猜；这里能拿到 error.message，
     * 而且每轮现读 revision，能扛住 live reload 导致的 revision 抖动。
     */
    async function saveViaSettings(settings, ops, refresh) {
      let lastError;
      let attempt = 0;
      for (attempt = 1; attempt <= 3; attempt += 1) {
        let revision;
        try {
          const described = await settings.describe();
          const namespaces = described?.ok === false ? [] : (described?.value?.namespaces ?? []);
          revision = namespaces.find((row) => row.ns === CONFIG_NAMESPACE)?.revision;
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        try {
          const response = await settings.mutate(CONFIG_NAMESPACE, ops, revision);
          if (response?.ok === true) {
            if (typeof refresh === 'function') {
              try {
                await refresh();
              } catch {
                /* 写入已成功，刷新失败不影响结果 */
              }
            }
            return { ok: true, attempts: attempt, mode: 'settings' };
          }
          lastError = String(response?.error?.message ?? response?.error ?? 'mutate 返回 false（DSH 没有接受写入）');
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        if (!CONFLICT_RE.test(String(lastError))) break;
        // eslint-disable-next-line no-await-in-loop
        await wait(150 * attempt);
      }
      return { ok: false, attempts: Math.min(attempt, 3), mode: 'settings', error: String(lastError ?? '写入失败') };
    }

    /**
     * 保存主机列表（顺带保存单文件传输上限）。
     * io.settings：DSH settings 服务（可选），有就走直连，错误可见；
     * io.revision：读当前 namespace 的 revision（可选），没有 settings 时用它避开过期快照。
     * maxTransferMB 为 undefined 时只写主机列表（保持旧调用方行为）。
     */
    async function saveHosts(form, lines, refresh, maxTransferMB, io = {}) {
      const value = hostsValueFromLines(lines);
      const limit = typeof maxTransferMB === 'number' && Number.isFinite(maxTransferMB) ? maxTransferMB : undefined;
      const ops = [{ op: 'set', path: ['hosts'], value }];
      if (limit !== undefined) ops.push({ op: 'set', path: ['maxTransferMB'], value: limit });
      const settings = typeof io.settings === 'function' ? io.settings() : undefined;
      if (settings?.mutate !== undefined && typeof settings.describe === 'function') {
        return await saveViaSettings(settings, ops, refresh);
      }

      const refreshSnapshot = async () => {
        if (typeof refresh !== 'function') return;
        try {
          // eslint-disable-next-line no-await-in-loop
          await refresh();
        } catch {
          /* 刷新失败就让写入自己报错 */
        }
        // eslint-disable-next-line no-await-in-loop
        await wait(50);
      };
      const readRevision = typeof io.revision === 'function' ? io.revision : () => undefined;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // 修订号会随宿主重载/其它写入变化；每轮都先拉一次最新快照，并把现读的 revision 显式传给写入
        // eslint-disable-next-line no-await-in-loop
        await refreshSnapshot();
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await form.mutate(ops, readRevision());
          if (ok) return { ok: true, attempts: attempt, mode: 'mutate' };
          // mutate 被拒但不抛错（例如 form 已 dispose）时也要留下原因，别让诊断串结尾是空的
          lastError = 'mutate 返回 false（DSH 没有接受写入）';
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        if (attempt < 3) {
          // eslint-disable-next-line no-await-in-loop
          await wait(150 * attempt);
        }
      }
      // 最后一个兜底：只写主机列表。若上限没写进去，明确标成「部分成功」，不要把主机也一起说成失败。
      await refreshSnapshot();
      if (typeof form.set === 'function') {
        try {
          const okHosts = await form.set('hosts', value);
          if (okHosts) {
            if (limit === undefined) return { ok: true, attempts: 3, mode: 'set' };
            try {
              const okLimit = await form.set('maxTransferMB', limit);
              if (okLimit) return { ok: true, attempts: 3, mode: 'set' };
              return {
                ok: true,
                attempts: 3,
                mode: 'set',
                warning: '主机列表已保存，但单文件传输上限没有写进去（DSH 拒绝了该字段）',
              };
            } catch (failure) {
              return {
                ok: true,
                attempts: 3,
                mode: 'set',
                warning: `主机列表已保存，但单文件传输上限没有写进去：${String(failure?.message ?? failure)}`,
              };
            }
          }
          lastError = 'set 返回 false（DSH 没有接受写入）';
        } catch (error) {
          return { ok: false, attempts: 3, mode: 'set', error: String(error?.message ?? error) };
        }
      }
      return {
        ok: false,
        attempts: 3,
        mode: 'mutate',
        ...(lastError === undefined ? {} : { error: String(lastError?.message ?? lastError) }),
      };
    }

    function HostsConfigCard({ view, form, refresh, settings, revision, manager }) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState(undefined);
      const [input, setInput] = React.useState('');
      const [importState, setImportState] = React.useState({ open: false, loading: false, candidates: [], selected: {}, error: null });
      const [limitDraft, setLimitDraft] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [warning, setWarning] = React.useState(undefined);
      const [updateState, setUpdateState] = React.useState({ status: 'idle' });
      const [pendingUpdate, setPendingUpdate] = React.useState({ status: 'none' });
      const [attemptNotice, setAttemptNotice] = React.useState({ status: 'none' });
      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);

      // 上次更新如果失败了（组件可能在卸载/重装期间被销毁），刷新后把真实原因显示出来。
      React.useEffect(() => {
        const notice = updateAttemptNotice(readUpdateAttempt(), VERSION);
        if (notice.status === 'failed' || notice.status === 'interrupted') setAttemptNotice(notice);
        else if (readUpdateAttempt() !== undefined) clearUpdateAttempt();
      }, []);

      // 上次点过更新的话，看这次页面加载到的是不是新版本；不是就提示重启。
      React.useEffect(() => {
        const state = pendingUpdateState(readPendingUpdate(), VERSION);
        if (state.status === 'applied' || state.status === 'stale') {
          clearPendingUpdate();
          return;
        }
        if (state.status === 'restart-required') setPendingUpdate(state);
      }, []);

      /** 检查更新：打开设置页自动跑一次（10 分钟缓存）；点「重新检查」强制刷新。 */
      const runReleaseCheck = async (force) => {
        setUpdateState({ status: 'checking' });
        const result = await checkForUpdate(manager?.(), { force });
        if (result.source === 'path') {
          setUpdateState({ status: 'local' });
          return;
        }
        if (result.source === 'no-manager') {
          // 这个 DSH 没有插件管理服务：确定结论，只能手动更新（换个 DSH 版本才可能出现）
          setUpdateState({ status: 'no-manager' });
          return;
        }
        if (result.source === 'unreadable') {
          // 管理器在，但这次没读出来：可以让用户重试
          setUpdateState({ status: 'unreadable' });
          return;
        }
        if (result.source === 'tarball' || (result.source === 'git' && result.latest === undefined)) {
          setUpdateState({ status: 'unsupported', source: result.source });
          return;
        }
        if (result.latest === undefined) {
          setUpdateState({ status: 'unknown' });
          return;
        }
        if (compareVersions(result.latest, VERSION) <= 0) {
          setUpdateState({ status: 'current', tag: result.latest });
          return;
        }
        setUpdateState({
          status: 'available',
          tag: result.latest,
          plan: { spec: result.spec, registry: result.registry, currentSpec: result.installSpec },
        });
      };
      React.useEffect(() => {
        void runReleaseCheck(false);
      }, []);

      /** 一键热更新：卸载当前版本 → 安装目标版本（HMR 热应用）→ 刷新页面加载新的客户端 bundle。 */
      const runUpdate = async () => {
        const target = updateState.tag;
        const plan = updateState.plan;
        if (target === undefined || plan === undefined) return;
        setUpdateState({ status: 'updating', tag: target, phase: '正在安装新版本…' });
        // 先落盘：安装期间插件会被卸载/重装，组件销毁后内存里的失败状态就没了
        writeUpdateAttempt({ phase: 'installing', target, from: VERSION });
        const result = await runHotUpdate(manager?.(), plan, VERSION);
        if (result.ok !== true) {
          const failureText = errorText(result.error) || '更新失败';
          writeUpdateAttempt({ phase: 'failed', target, error: failureText });
          setAttemptNotice({ status: 'failed', target, error: failureText });
          setUpdateState({ status: 'failed', tag: target, error: result.error, rollback: result.rollback });
          return;
        }
        if (result.application === 'restart-required') {
          setUpdateState({ status: 'restart', tag: target, reason: result.restartReason });
          return;
        }
        // 客户端 bundle 不一定能热换（换安装来源时 DSH 不重建客户端图），先记下目标版本，
        // 刷新回来由 pendingUpdateState 自检，必要时如实提示重启。
        writePendingUpdate(target);
        clearUpdateAttempt();
        setAttemptNotice({ status: 'none' });
        setUpdateState({ status: 'done', tag: target });
        setTimeout(() => {
          try {
            window.location.reload();
          } catch {
            /* 无法刷新时用户自己刷新即可 */
          }
        }, 1500);
      };
      if (view === 'summary') return '管理侧栏 SSH 面板里的远端主机与单文件传输上限';

      const accepted = hostsLinesFromValue(snapshot.value?.hosts);
      const lines = draft === undefined ? accepted : draft;
      const acceptedLimit = transferLimitMBFromValue(snapshot.value?.maxTransferMB);
      const limitText = limitDraft === undefined ? String(acceptedLimit) : limitDraft;
      const readOnly = snapshot.writable !== true;
      const hostsDirty = draft !== undefined && hostsValueFromLines(lines) !== hostsValueFromLines(accepted);
      const limitDirty = limitDraft !== undefined && transferLimitMBFromValue(limitDraft) !== acceptedLimit;
      const dirty = hostsDirty || limitDirty;
      const restartPending = pendingUpdate.status === 'restart-required';
      // 已经装好、只差重启时，别再显示「有更新」和按钮，免得用户反复点。
      const hideUpdateForRestart =
        restartPending && (updateState.tag === undefined || sameVersion(updateState.tag, pendingUpdate.version));

      const openImport = () => {
        setImportState({ open: true, loading: true, candidates: [], selected: {}, error: null });
        if (typeof fetch !== 'function') return;
        fetch(SSH_CONFIG_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            const candidates = Array.isArray(data?.hosts) ? data.hosts : [];
            const selected = {};
            for (const candidate of candidates) if (candidate.status === 'new') selected[candidate.host] = true;
            setImportState({ open: true, loading: false, candidates, selected, error: null });
          })
          .catch((error) =>
            setImportState({ open: true, loading: false, candidates: [], selected: {}, error: String(error?.message ?? error) }),
          );
      };
      const importSelected = () => {
        const hosts = importState.candidates
          .filter((candidate) => candidate.status === 'new' && importState.selected[candidate.host] === true)
          .map((candidate) => candidate.host);
        const existing = new Set(draft ?? accepted);
        const merged = [...(draft ?? accepted), ...hosts.filter((host) => !existing.has(host))];
        setDraft(merged);
        setImportState({ open: false, loading: false, candidates: [], selected: {}, error: null });
        setError(undefined);
      };

      const add = () => {
        const spec = input.trim();
        if (spec.length === 0) return;
        setDraft([...(draft ?? accepted), spec]);
        setInput('');
        setError(undefined);
        setWarning(undefined);
      };
      const removeAt = (index) => {
        setDraft((draft ?? accepted).filter((_line, position) => position !== index));
        setError(undefined);
        setWarning(undefined);
      };
      const save = async () => {
        const parsedLimit = Number(limitText);
        if (!Number.isInteger(parsedLimit) || parsedLimit < MIN_MAX_TRANSFER_MB || parsedLimit > MAX_MAX_TRANSFER_MB) {
          setError(`单文件传输上限要填 ${MIN_MAX_TRANSFER_MB}–${MAX_MAX_TRANSFER_MB} 之间的整数（MB）`);
          return;
        }
        setSaving(true);
        setError(undefined);
        setWarning(undefined);
        try {
          const result = await saveHosts(form, lines, refresh, parsedLimit, {
            settings: typeof settings === 'function' ? settings : undefined,
            revision: typeof revision === 'function' ? revision : undefined,
          });
          if (result.ok) {
            setDraft(undefined);
            setLimitDraft(undefined);
            if (result.warning !== undefined) setWarning(String(result.warning));
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
          { className: `${MOD}-row` },
          h('span', { className: `${MOD}-hint` }, `插件版本 v${VERSION}`),
          updateState.status === 'checking' ? h('span', { className: `${MOD}-hint` }, '正在检查更新…') : null,
          updateState.status === 'current' ? h('span', { className: `${MOD}-hint` }, '已是最新版本') : null,
          updateState.status === 'unknown'
            ? h('span', { className: `${MOD}-hint` }, '检查更新失败（离线/限流），可点「重新检查」')
            : null,
          updateState.status === 'available' && !hideUpdateForRestart
            ? h('span', { className: `${MOD}-hint` }, `有新版本 ${updateState.tag}`)
            : null,
          updateState.status === 'local'
            ? h('span', { className: `${MOD}-hint` }, '当前是本地/链接安装，不提供一键更新（避免覆盖开发目录）')
            : null,
          updateState.status === 'no-manager'
            ? h(
                'span',
                { className: `${MOD}-hint` },
                '当前 DSH 未提供插件管理服务，无法自动更新；请按 README 手动安装新版本。',
              )
            : null,
          updateState.status === 'unreadable'
            ? h(
                'span',
                { className: `${MOD}-hint` },
                '暂时读不到插件管理器（可能刚启动或刚安装），点「重新检查」重试；仍然不行就手动更新。',
              )
            : null,
          updateState.status === 'unsupported'
            ? h(
                'span',
                { className: `${MOD}-hint` },
                `当前安装来源（${updateState.source}）没有可查询的更新源，请手动更新`,
              )
            : null,
          updateState.status === 'available' && !hideUpdateForRestart
            ? h(
                'button',
                {
                  type: 'button',
                  className: `${MOD}-save`,
                  disabled: typeof manager !== 'function' || manager() === undefined,
                  onClick: () => void runUpdate(),
                },
                `更新到 ${updateState.tag}`,
              )
            : null,
          updateState.status === 'updating'
            ? h('span', { className: `${MOD}-hint` }, updateState.phase ?? '正在更新…')
            : null,
          updateState.status === 'done'
            ? h('span', { className: `${MOD}-hint` }, `已更新到 ${updateState.tag}，正在刷新页面…（如果刷新后版本号没变，说明客户端 bundle 没热换，需要重启 DSH 一次）`)
            : null,
          updateState.status === 'restart'
            ? h(
                'span',
                { className: `${MOD}-warning` },
                `已安装 ${updateState.tag}，但需要重启 DSH 才能生效${updateState.reason === undefined ? '' : `（${updateState.reason}）`}`,
              )
            : null,
          attemptNotice.status === 'failed'
            ? h(
                'span',
                { className: `${MOD}-error`, title: errorText(attemptNotice.error) },
                `上次更新到 ${String(attemptNotice.target).replace(/^v/u, '')} 失败：${summarizeError(attemptNotice.error)}。当前仍是 v${VERSION}，可以点「重新检查」再试。`,
              )
            : null,
          attemptNotice.status === 'interrupted'
            ? h(
                'span',
                { className: `${MOD}-warning` },
                `上次更新到 ${String(attemptNotice.target).replace(/^v/u, '')} 似乎中断了。点「重新检查」确认当前版本。`,
              )
            : null,
          restartPending
            ? h(
                'span',
                { className: `${MOD}-warning` },
                `已安装 v${String(pendingUpdate.version).replace(/^v/u, '')}，但当前页面还在运行 v${VERSION}：这次升级换了安装位置，DSH 不会就地重建客户端 bundle。重启 DSH 一次即可生效（主机和设置数据都在，不用重新配置）。`,
              )
            : null,
          updateState.status === 'failed'
            ? h(
                'span',
                { className: `${MOD}-error` },
                `更新失败：${summarizeError(updateState.error)}${updateState.rollback === 'ok' ? `（已装回 v${VERSION}）` : ''}`,
              )
            : null,
          updateState.status === 'available' ||
          updateState.status === 'current' ||
          updateState.status === 'unknown' ||
          updateState.status === 'unreadable' ||
          updateState.status === 'local' ||
          updateState.status === 'unsupported'
            ? h('button', { type: 'button', className: `${MOD}-refresh`, onClick: () => void runReleaseCheck(true) }, '重新检查')
            : null,
        ),
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
            placeholder: 'deploy@203.0.113.10:22 或 web-01',
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
          h(
            'button',
            { type: 'button', className: `${MOD}-refresh`, disabled: readOnly, onClick: openImport },
            '从 SSH 配置导入',
          ),
        ),
        importState.open
          ? h(
              'div',
              { className: `${MOD}-emptyBox` },
              importState.loading ? h('div', { className: `${MOD}-hint` }, '读取 ssh 配置…') : null,
              importState.error !== null ? h('div', { className: `${MOD}-error` }, importState.error) : null,
              ...importState.candidates.map((candidate) =>
                h(
                  'label',
                  { key: candidate.host, className: `${MOD}-importRow` },
                  h('input', {
                    type: 'checkbox',
                    checked: candidate.status === 'new' && importState.selected[candidate.host] === true,
                    disabled: candidate.status !== 'new',
                    onChange: (event) =>
                      setImportState((current) => ({
                        ...current,
                        selected: { ...current.selected, [candidate.host]: event.target.checked },
                      })),
                  }),
                  h('span', { className: `${MOD}-fileName` }, candidate.host),
                  h(
                    'span',
                    { className: `${MOD}-sectionMeta` },
                    candidate.status === 'new'
                      ? [candidate.user, candidate.port, candidate.proxyJump === undefined ? '' : `跳板 ${candidate.proxyJump}`]
                          .filter((part) => part !== undefined && part !== '')
                          .join(' · ')
                      : candidate.reason,
                  ),
                ),
              ),
              importState.loading || importState.error !== null
                ? null
                : h(
                    'div',
                    { className: `${MOD}-row` },
                    h('button', { type: 'button', className: `${MOD}-save`, onClick: importSelected }, '导入选中'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `${MOD}-linkButton`,
                        onClick: () => setImportState({ open: false, loading: false, candidates: [], selected: {}, error: null }),
                      },
                      '取消',
                    ),
                  ),
            )
          : null,
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
          warning === undefined ? null : h('span', { className: `${MOD}-warning` }, warning),
        ),
        h(
          'div',
          { className: `${MOD}-star` },
          '用着顺手？给个 ',
          h('a', { href: PROJECT_URL, target: '_blank', rel: 'noopener noreferrer' }, '⭐ Star'),
          ' 支持一下，能让更多在 DSH 里连远程的人看到它。',
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

      const pendingTerminalTitles = new Set();
      ctx.effect(
        () => () => {
          for (const cleanup of [...pendingTerminalTitles]) cleanup();
          pendingTerminalTitles.clear();
        },
        'remote-console.client.terminal-titles',
      );

      const openRemoteTerminal = (shellPath, replaceTab, sessionId, host) => {
        const canName = typeof sessionId === 'string'
          && typeof host === 'string'
          && host !== ''
          && typeof ctx.sidebarRight.tabsIn === 'function'
          && typeof ctx.webTerminals.view === 'function';
        const before = canName
          ? new Set(ctx.sidebarRight.tabsIn(sessionId).map((tab) => tab.id))
          : new Set();
        ctx.sidebarRight.openTab('terminal', {
          ...(replaceTab ? { replaceTab: true } : {}),
          params: { shellPath },
        });
        restoreShellPreference();
        if (!canName) return;
        const opened = ctx.sidebarRight.tabsIn(sessionId).find((tab) => tab.kind === 'terminal' && !before.has(tab.id));
        if (opened === undefined) return;
        const view = ctx.webTerminals.view(sessionId, opened.id, opened.contentId, undefined, shellPath);
        renameTerminalWhenReady(view, terminalTitleForHost(host), pendingTerminalTitles);
      };

      const connect = (shellPath, sessionId, host) => openRemoteTerminal(shellPath, false, sessionId, host);

      // 插件配置页：宿主服务了本插件的 settings 命名空间时才注册。
      // 注意用 ctx.inject 等服务出现，而不是在 apply 时 ctx.get 一次——客户端插件可能先于
      // 设置服务加载，一次性读取会永远拿到 undefined（这正是 0.10.0 里「找不到入口」的原因）。
      // 同时注册两个 slot：
      //  - plugins.bundle.config（key 是包名）：插件包详情页顶部直接出现，最容易找到；
      //  - plugins.row.config（key 是 `<包名>#<行 id>`）：本插件那一行的「配置」按钮。
      /** DSH settings 服务（存在时用直连写入，错误可见）。 */
      let directSettings;
      /** DSH 插件管理服务（存在时提供一键热更新）。 */
      let pluginManager;

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
                        // 直连 settings 服务的读写（能拿到真实错误）；服务不存在时返回 undefined，
                        // saveHosts 会退回 configForms 的写入路径。
                        settings: () => directSettings,
                        // 一键热更新用的插件管理服务；不存在时设置页只显示版本和更新链接。
                        manager: () => pluginManager,
                        revision: () => {
                          try {
                            const view = configForms.describe().getSnapshot().view;
                            return view?.namespaces?.find((row) => row.ns === CONFIG_NAMESPACE)?.revision;
                          } catch {
                            return undefined;
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
      // 可选：直接用 DSH 的 settings 服务写入，能拿到 configForms 吞掉的真实错误
      // （例如「字段不是 volatile」），并且每轮现读 revision。
      // 注意：`remote.settings` / `remote.pluginManager` 在 cordis 里是各自独立的服务。
      // 只等 `remote` 的话，命名空间还没挂上时回调就跑了，结果是静默退化：错误又变成看不见的
      // false，一键更新按钮永远禁用。所以分别 inject 具体的命名空间。
      const readRemote = (serviceScope) =>
        typeof serviceScope.get === 'function' ? serviceScope.get('remote') : serviceScope.remote;
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['remote', 'remote.settings'], (serviceScope) => {
            const remote = readRemote(serviceScope);
            if (remote?.settings?.mutate !== undefined) directSettings = remote.settings;
          });
        } catch {
          /* 老部署没有 settings 命名空间 */
        }
        try {
          ctx.inject(['remote', 'remote.pluginManager'], (serviceScope) => {
            const remote = readRemote(serviceScope);
            if (remote?.pluginManager?.installBundle !== undefined) pluginManager = remote.pluginManager;
          });
        } catch {
          /* 老部署没有插件管理服务 */
        }
      }
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
                  sessionId,
                  openFiles: (pid, host) => ctx.sidebarRight.openTab(FILES_KIND, {
                    params: { pid, ...(typeof host === 'string' && host !== '' ? { host } : {}) },
                  }),
                }),
              },
              HostList,
            ),
          ),
        'remote-console.client.body',
      );

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: FILES_TAB_ID,
            kind: FILES_KIND,
            title: () => '远程文件',
            guide: [
              {
                id: 'browse',
                order: 22,
                title: () => '远程文件',
                description: () => '文件树、预览与编辑',
              },
            ],
          }),
        'remote-console.client.files-type',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.guide.entry',
                key: FILES_TAB_ID,
                inject: () => ({}),
              },
              (props) => h(SshGuide, { ...props, kind: FILES_KIND }),
            ),
          ),
        'remote-console.client.files-guide',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: FILES_TAB_ID,
                inject: () => ({}),
              },
              RemoteFiles,
            ),
          ),
        'remote-console.client.files-body',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: FILES_TAB_ID,
                inject: () => ({}),
              },
              RemoteFilesTitle,
            ),
          ),
        'remote-console.client.files-title',
      );
    }

    const exported = {};
    exported.apply = apply;
    exported.inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'webTerminals'];
    /* 只给仓库测试用（loader 只读 apply/inject）。 */
    exported.__testing = {
      compareVersions,
      formatSize,
      shortSessionId,
      joinRemotePath,
      parentRemotePath,
      basenameRemotePath,
      isRemotePathWithin,
      remoteBreadcrumbs,
      displayRemotePath,
      safeUploadName,
      fileLanguage,
      languageLabel,
      validateFileContent,
      formatJson,
      safeMarkdownHref,
      markdownInline,
      markdownBlocks,
      tokenizeCodeLine,
      MarkdownView,
      CodeReadView,
      CodeEditor,
      PANEL_UPLOAD_LIMIT_BYTES,
      uploadLimitMessage,
      RemoteFiles,
      RemoteFilesTitle,
      readHostPrefs,
      writeHostPrefs,
      togglePinned,
      setHostGroup,
      hostMetaMap,
      groupShells,
      findConsoleForHost,
      consoleDisplayName,
      compactHostLabel,
      terminalTitleForHost,
      renameTerminalWhenReady,
      clockRange,
      parseVersion,
      PLUGIN_VERSION: VERSION,
      PACKAGE_NAME,
      checkForUpdate,
      HostList,
      filterShells,
      orderShells,
      relativeTime,
      readRecent,
      noteRecent,
      friendlyError,
      installSpecOf,
      readInstallSpec,
      readCachedRelease,
      writeCachedRelease,
      CHECK_CACHE_KEY: UPDATE_CACHE_KEY,
      sourceOf,
      registryPlan,
      runHotUpdate,
      readPendingUpdate,
      writePendingUpdate,
      readUpdateAttempt,
      writeUpdateAttempt,
      clearUpdateAttempt,
      updateAttemptNotice,
      errorText,
      summarizeError,
      clearPendingUpdate,
      pendingUpdateState,
      sameVersion,
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
