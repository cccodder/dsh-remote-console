# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor version can
contain breaking changes; the plugin wraps DSH terminal services that are not published
extension points, so a DSH minor release may need a plugin release.

## [Unreleased]


### Fixed

- **检查更新的失败结果不再写缓存**：0.10.6 起超时/不可达也会写进 10 分钟缓存，网络恢复后仍然显示「检查更新失败」。
  现在只有拿到结论才写缓存——path / tarball / 不带 tag 的 git 属于「确实不提供一键更新」，而 unknown 和查询失败只是
  这一次没问到，不写缓存、下次打开会重查；缓存键升到 v2，旧版本写进去的失败条目直接作废。
- **CLI 安装的用户拿不到「更新到」入口**：插件管理器比设置页晚挂上时读到 `unknown` 并被缓存，页面显示
  「当前安装来源（unknown）没有可查询的更新源」。现在读安装来源会短暂重试一次；仍读不到时提示「暂时读不到插件管理器，
  点重新检查重试」，既不写缓存也不冒充结论。

## [0.10.6] - 2026-10-30

### Changed

- **更新机制对齐 ds-bot**：查更新前先判断这个 profile 当初是怎么装的——npm registry 安装按 DSH/pnpm
  配置的 registry 顺序查（镜像优先，查不到再退公共源），带版本 tag 的 git 安装查 GitHub release，
  本地目录 / `link:` 安装不再提示一键更新（避免覆盖开发目录）。检查结果缓存从 6 小时缩到 10 分钟；
  安装时先直接 `installBundle`（非 HMR 部署可原地升级），被 `already-installed` 拒绝才退成
  「卸载 → 安装」，失败仍自动装回当前版本。

## [0.10.5] - 2026-10-29

### Fixed

- **更新后如实提示是否需要重启**：宿主 HMR 能就地重载插件，但客户端 bundle 图按启动时解析到的路径缓存
  （`dsh-client-modules` 的 `sourceKey = baseUrl + 包名`，路径变了也不重建）。升级如果换了安装来源
  （本地目录 / `link:` → npm），浏览器会继续跑旧 bundle。现在点更新时记下目标版本，刷新后自检：真的
  换掉了才算成功；还是旧版本就提示「重启 DSH 一次生效」，并且不再重复显示「更新到」按钮。

## [0.10.4] - 2026-10-29

### Added

- **设置页一键热更新**：配置页打开时自动检查 GitHub 最新 Release（缓存 6 小时，可「重新检查」），
  发现新版本且 npm 已同步后显示「更新到 vX.Y.Z」。更新走 DSH 插件管理器的「卸载 → 安装」，
  HMR 把改动热应用到运行中的进程（不需要重启），完成后自动刷新页面加载新的客户端 bundle；
  安装失败自动装回当前版本并显示错误原文；DSH 判定必须重启时如实提示。没有
  `remote.pluginManager` 的部署禁用按钮并提示手动更新。

### Fixed

- **设置页保存被 DSH 整体拒绝（0.10.3 回归）**：`maxTransferMB` 声明成了普通字段，而 DSH 的
  `SettingsForms.write()` 只允许写 volatile 字段，设置页每次保存都被
  `Config field "maxTransferMB" is not volatile` 拒绝——主机列表也一起写不进去。现在该字段
  标成 volatile，读取时先拆开 schemastery 的 `{ get() }` 包装再按 1–2048 夹取。
- **保存失败不再只显示一个 false**：有 `remote.settings` 服务时直连写入，每轮现读 revision、
  冲突才自动重试，其它错误把原始 `error.message` 显示在页面上；没有该服务时退回 configForms
  并显式传现读 revision。整体写入失败但主机列表写入成功时，界面标成「主机已保存、上限没写进去」
  的 warning，而不是把两者都说成失败。
- **设置页的直连写入 / 一键更新改为等待具体命名空间服务**：`remote.settings` 与
  `remote.pluginManager` 在 cordis 里是各自独立的服务；之前只等 `remote`，命名空间还没挂上时
  回调就跑了，错误可见性和更新按钮会静默退化。现在分别
  `inject(['remote', 'remote.settings'])` 与 `inject(['remote', 'remote.pluginManager'])`。

## [0.10.3] - 2026-10-28

### Added

- **单文件传输上限可配**：`remote_upload` / `remote_download` 的上限从写死的 256 MB 变成配置项。
  设置页「主机列表」同一个卡片里新增「单文件传输上限（MB）」输入框，范围 1–2048，保存后立即
  生效（不用重载插件）；无界面部署可用 `DSH_RC_MAX_TRANSFER_MB` 环境变量，设置页里的值优先。
  配置写错时退回默认 256 MB，不会把上限变成「无限制」或 0。超限报错会直接说明去哪改。
  没有 ControlMaster 的 PTY 通道仍是 1 MiB 硬上限（终端分块传输的物理限制，与本设置取较小值）。

### Changed

- **引导模型选对通道**：新增系统提示选路规则（只在存在已连接终端时注入，没有终端时不占 prompt）、
  两个工具描述改成「意图优先」（`remote_run` 是用户正在看的可见通道、属预期用法；
  `remote_exec` 用于纯数据采集、需要 tty 时必须换 `remote_run`），并在结果里纠正误用：
  `remote_run` 输出过大时提示下次用 `remote_exec`；`remote_exec` 命中「需要 tty / 密码」类报错时
  提示改用 `remote_run`；`remote_status` 顶部新增通道摘要与选路提示。

### Fixed

- **插件重载后设置页保存必失败**：设置页不再 `dispose()` 宿主 `configForms` 里缓存的共享 form。
  插件行禁用再启用会触发客户端插件卸载，旧代码在 effect 清理里把宿主这个 form 一起 dispose，
  重新挂载时 `configForms.get()` 仍返回同一个已 dispose 的实例，`mutate` 一律返回 false
  （revision 冻结不动），所有保存都失败。现在 form 的生命周期完全交给 `configForms`，卸载只
  清理本插件自己的 slot 注册。
- 失败诊断不再缺失原因：`mutate` / `set` 返回 false 时也把原因写进诊断串；「重新加载」按钮的
  提示改为如实说明它会刷新页面、当前草稿会丢（之前写「草稿保留」）。

### Security

- **工具按会话隔离终端（修越权）**：之前同一宿主进程里的任何会话都能通过 `console_pid` 操作
  别人的终端——不传 pid 时 `newestConsole()` 也不带会话过滤，等于可以读别人屏幕、在别人已登录的
  终端里执行命令、上传下载文件。现在解析终端时比对 `cover.sessionId`（spawn 时取自
  `DSH_SESSION_ID`）与调用方会话（`exec.agent.id`），不匹配直接 `CONSOLE_FORBIDDEN`；
  `remote_status` 只列本会话的终端；审计记录新增 `session` 字段，可从 `pid` 追到会话。
  两边信息缺失时（老版本 DSH、插件自测、手动登记的终端）退回旧行为，不误伤。

## [0.10.2] - 2026-10-28

设置页「主机列表」重做，并修掉首次保存就报冲突的问题。

### Changed

- **主机列表改成逐条列表**：每台主机一行、带「删除」；下方输入框 +「添加」（回车也能加）；
  保存 / 取消 / 重新加载；空态提示。注释行（`#`）同样保留，不再是一个大文本框。

### Fixed

- **首次保存报「设置可能已被别处修改」**：保存时不再携带可能过期的快照修订号，由服务端用最新
  修订号判定；第一次被拒会在 400ms 后自动重试一次，仍失败则改用单字段写入兜底。
- 仍失败时提示里带诊断串（status/revision/writable/mode/attempts）并在 Console 打一条 warn，
  草稿保留、旁边有「重新加载」按钮，方便把失败原因原样回传。

## [0.10.1] - 2026-10-28

主机列表「找不到入口」修正：设置页在两个位置出现，并且不依赖设置页也能管理主机。

### Added

- `remote_host_add` / `remote_host_list` / `remote_host_remove`：直接读写 `hosts.tsv`
  （插件数据目录，0600），没有设置页、没有终端也能加/删/查看主机；`remote_host_list` 会标出
  每个主机来自 ssh 配置、设置页还是 hosts.tsv。
- 设置页同时注册到 `plugins.bundle.config`（插件包详情页顶部的配置区）和
  `plugins.row.config`（「部件」里那一行的配置按钮），不用再猜入口在哪。
- 侧栏 SSH 面板底部加「主机：插件页配置」提示。

### Changed

- README 主机管理章节重写：写清两条精确路径（插件 → 包卡片 → 主机列表；或行「部件」→ 配置），
  以及「让 agent 添加」的替代方式与两者存储位置的区别（`config.hosts` vs `hosts.tsv`）。

### Fixed

- **设置页完全不出现的根因**：客户端插件可能先于 DSH 设置服务加载，之前用一次性
  `ctx.get('configForms')` 判断，拿到 `undefined` 就永久跳过了注册。改为 `ctx.inject(['configForms'], …)`
  等服务出现后再注册，加载顺序不再影响设置页。
- 主机写法的端口范围校验：`host:99999` 这类非法端口会被拒绝，不再写进 hosts.tsv。

## [0.10.0] - 2026-10-28

Windows 支持（实验性）：终端与 agent 工具都能用，走的是 PTY 回退通道。

### Added

- `bin/dsh-ssh.mjs`：没有 bash 的平台用的 Node 包装器，菜单、`--host` / `--target` /
  `--ask-target`、rendezvous 与 bash 版一致；不传 `-M` / `-S`（Windows OpenSSH 没有
  ControlMaster），rendezvous 里 socket 留空。
- Windows 启动器改成 `node dsh-ssh.mjs --host|--target <spec>`（用 DSH 自带的
  `process.execPath`，不需要系统另装 Node）；`wrapSpawnTerminal` 能识别这种启动器。
- PTY 回退通道：终端没有 socket 时，`remote_exec`、`remote_upload` / `remote_download`、
  `remote_read_file` / `remote_write_file` 自动改走同一个 PTY——命令与数据出现在用户窗口，
  base64 分块传输（单文件 ≤1 MiB），仍然做 sha256 校验。
- `remote_forward` 在 PTY 通道下明确返回 `FORWARD_UNAVAILABLE`（没有可复用的已认证连接）。
- `remote_status` 增加 `transport: socket|pty`；工具输出里标注当前通道。

### Changed

- README / `docs/compat.md` / `SECURITY.md` 更新 Windows 状态：从「不支持」改为「实验性支持」，
  写清哪些能力打折、哪些不可用，以及验证边界（CI 没有 Windows，逻辑用 Linux 等价路径验证）。

### Tests

- `tests/windows.test.mjs`：Node 包装器（dry-run 参数、菜单、新建主机、rendezvous 无 socket）、
  Windows 启动器形态、spawnTerminal 识别、以及**无 socket 时工具真的走 PTY 并落盘/校验**。
- `tests/pty-transport.test.mjs`：真实 shell 上的分块 base64 写入、读回、截断、sha256、上限拒绝。

## [0.9.0] - 2026-10-28

主机管理设置页：不用再手改 `~/.ssh/config` 或 `hosts.tsv`，在 DSH 插件页里就能维护面板的主机列表。

### Added

- 插件行设置页「主机列表」：侧栏「插件」→ `dsh-remote-console` 行 → 配置。每行一个远端
  （ssh 配置别名，或 `user@host[:port]`），`#` 开头为注释；保存写进该行 profile patch 的
  `config.hosts`，宿主随即生成/清理侧栏「SSH 远程」里的启动器。
- 宿主新增 `Config`（`@deepseek-ai/schemastery`，`hosts` 为 `volatile()` 字段），并把它
  作为新的 peer 依赖；CI/发版工作流安装对应版本。
- `bin/dsh-ssh` 新增 `--target <spec>`：面板里配置的 `user@host:port` 直接进 ssh、跳过菜单；
  与「新建会话」的 `--ask-target` 共用同一套解析（含 IPv6 不误拆端口）。
- 设置页只在部署提供 DSH 设置服务（`ctx.configForms`）时注册；没有该服务时页面不出现，
  终端功能不受影响。

### Changed

- 启动器生成区分两条路：ssh 别名用 `--host`，直连目标用 `--target`；设置里删掉的主机会在
  下一次生成时清理，不会留在下拉里。

### Tests

- `tests/settings-host.test.mjs`（Config 解析、行过滤、启动器生成与清理）与
  `tests/settings-client.test.mjs`（有/无 configForms 的注册行为、版本一致）。

## [0.8.0] - 2026-10-28

跨会话审计日志：agent 在这台机器上做过什么，不再随着关终端一起消失。

### Added

- `audit/audit.jsonl`：**跨会话保留**的审计日志。只记 agent 的动作——命令文本（沿用脱敏规则）、
  退出码、审批结果（批准/拒绝/无审批服务）、传输路径与字节数/sha256、端口转发、连接起止；
  不含屏幕输出，也不含用户手敲的内容。8 MB 滚动、保留 5 份、文件 0600、目录 0700。
- `remote_audit_read(cursor, max_bytes?, tool?)`：增量读取审计日志，可按工具过滤；没有活终端也能用。
- `remote_audit_export(local_path, format?)`：导出为 `jsonl` 或 `csv`（固定列，0600），
  便于归档、交给别人核对或在卸载前留档。
- `DSH_RC_AUDIT=off` 可停止写入审计（读取/导出已有记录不受影响）；`remote_status` 显示审计文件
  路径与大小；侧栏面板底部显示「审计：audit/」提示。

### Changed

- 明确区分两条日志：`logs/` 是现场回放（含屏幕输出，PTY 结束即删），`audit/` 是审计
  （跨会话保留，不含屏幕内容）。README 安全模型、数据目录、环境变量表与 SECURITY.md 同步说明。

## [0.7.1] - 2026-10-28

### Fixed

- npm 包页面上的相对链接与截图：README 里的 `docs/compat.md`、`SECURITY.md`、`CONTRIBUTING.md`、
  `docs/images/*.png` 等引用改为 GitHub 绝对地址，npm 页面不再出现 404 链接和裂图
  （仓库内浏览不受影响）。

## [0.7.0] - 2026-10-28

文件传输与端口转发：agent 现在能在**用户已经登录的那个连接**上搬文件、开隧道，
不需要第二次认证，也不接触任何凭据。

### Added

- `remote_upload` / `remote_download`：经已认证的 ControlMaster socket 流式传输，
  两侧比对 sha256，默认不覆盖（`overwrite: true` 才覆盖），单文件上限 256 MB。
  下载先写临时文件、校验通过才原子改名，失败不会破坏本地已有文件。
- `remote_read_file` / `remote_write_file`：读写远端小文本（默认 128 KB、写入上限 256 KB），
  内容走 stdin/exec 通道，不会出现在用户终端窗口里；二进制文件拒绝当文本显示。
- `remote_forward`：`start` / `stop` / `list`，等价于
  `ssh -N -L 127.0.0.1:<local>:<remote_host>:<remote_port>`，只绑回环地址；
  终端结束、`remote_close`、插件卸载时统一取消。
- 敏感路径写入审批：写 `~/.ssh`、`/etc`、`/root`、`/boot`、sudoers、systemd unit、
  shell profile 会走 `ctx.approval` 一次性审批，没有审批服务时 fail closed。
- 真实 sshd 集成测试（`tests/sshd-harness.mjs` + `tests/integration-sshd.test.mjs`）：
  自己起临时 sshd，覆盖包装器登录、master 复用、1 MB 上下行 sha256、端口转发、退出码透传；
  机器上没有 `ssh`/`sshd` 时整组跳过。CI 增加对应步骤。
- `docs/compat.md`：DSH 版本 × 平台 × 能力兼容矩阵；README 增加中英「故障排查」7 条。
- `scripts/bench.mjs`：SSH 通道基线（master 建立、exec 往返 p50/p95、1 MiB 上传/下载），
  README 给出 loopback 实测数字与复现方法。

### Changed

- `engines.dsh` 收紧为 `>=0.2.1-rc.2 <0.3.0-0`：`0.3.0-rc.*` 不再被静默放行。
- `DSH_SSH_CONFIG` 现在同时作用于终端包装器与 exec/传输/转发通道（此前只有包装器读它），
  避免「终端连 A、工具连 B」。
- README 工具表补到 11 个，并说明文件/转发复用同一个已认证连接、必须有活着的终端。

### Fixed

- 端口转发在多路复用下的停止语义：`-S` 指向已有 master 时 `ssh -N -L` 客户端会在请求成功后
  立即退出，监听由 master 持有；停止改用 `ssh -O cancel`，关终端时也能正确回收。

## [0.6.7] - 2026-10-25

### Added

- README screenshots: the right-sidebar panel and the agent running commands in the user's
  terminal. Real host names are redacted in both.
- `SECURITY.md` (English and Chinese): supported versions, private reporting through GitHub
  Security Advisories, what the plugin promises, and known limitations.
- A weekly `DSH next compatibility` workflow: installs the DSH `next` peer packages and runs
  the tests, so a DSH change that breaks the wrapped services shows up before users upgrade.

### Changed

- Positioning: the README intro (both languages), `package.json` description and the GitHub
  About text now lead with "you and your agent share the same terminal"; the SSH login detail
  moved to the second sentence.
- README links to `SECURITY.md` and the development/release documents.

## [0.6.6] - 2026-10-25

### Added

- Release process: CI workflow (tests + release metadata) and a release workflow that
  validates the tag against `package.json`, publishes to npm with provenance through
  Trusted Publishing, and attaches the packed `.tgz` to the GitHub release.
- `CONTRIBUTING.md` / `CONTRIBUTING.zh.md`, `AGENTS.md`, a pull request template, and a
  real-device release checklist.
- `scripts/check-release.mjs`: one check for version / client `VERSION` / CHANGELOG section /
  market index consistency.
- GitHub Pages serves the market index from the repository (`market/index.json`), so the
  index no longer depends on a CDN's branch cache. `.nojekyll` added.

### Changed

- `CHANGELOG.md` follows Keep a Changelog with an `Unreleased` section and compare links.

## [0.6.5] - 2026-10-24

插件的市场索引换成可更新的托管方式，并修正索引里「指向未发布版本」的问题。

### Changed

- **索引 URL 改用 jsDelivr 镜像**（随后在未发布提交中改为 GitHub Pages）：
  `https://cdn.jsdelivr.net/gh/cccodder/dsh-remote-console@main/market/index.json`。
  受限网络里 `raw.githubusercontent.com` 不通而 jsDelivr 可用；README 同时写了 raw 原链和
  「自托管一份 `market/index.json`」的兜底，索引内容完全相同。
- **`scripts/market-index.mjs` 只保留 npm 上真实存在的版本**：上一版把从未发布过的
  0.6.3 也写进了索引，用户点到会装不上。现在会读 npm registry 的版本表过滤历史条目，
  并用 registry 的发布时间；离线时才保留本地历史。

### Tests

69 个（索引测试的基准 URL 同步更新）。

## [0.6.4] - 2026-10-24

发布到 npm，并附带 DSH 插件市场索引（format 1），第三方插件因此有了真正的「更新」入口。

### Added

- **npm 发布**：`npm install dsh-remote-console`（包名 `dsh-remote-console`）。
- **插件市场索引**：仓库内 `market/index.json`，用户在侧栏「发现 → 添加索引源」里加入后，
  索引版本比已安装新时显示「有新版本」，点击即走 DSH 插件管理器的安装/更新流程
  （npm 源，`dsh-remote-console@<version>`）。
- `scripts/market-index.mjs`（`npm run market:index`）：从 `package.json` 与 npm registry
  的发布时间生成/追加索引版本，保留历史版本、按 SemVer 降序。
- `tests/market.test.mjs`：用 DSH 的 `parseMarketIndex` 校验 `market/index.json`，
  并断言当前 `package.json` 版本、`engines.dsh`、npm 源与索引一致。

### Changed

- README（中/英）安装与更新章节重写：npm、插件市场索引、手动重装三条路径，
  以及「为什么第三方插件原本没有一键更新」。

### Tests

69 个测试（新增：市场索引 format 1 校验、版本对齐、索引与 package.json 同步）。

## [0.6.3] - 2026-10-24

面板里能看到「有没有新版本」，并补上更新路径说明。

### Added

- **版本号 + 更新提示**：SSH 面板底部显示当前版本。客户端向 `api.github.com` 查最新
  Release（结果缓存 6 小时，失败静默），有更高版本时在同一行显示「有新版本 vX.Y.Z」，
  点击打开 GitHub Release 页。
- **版本号同步保护**：客户端是手写 bundle，版本号写在 `lib/client.js` 的 `VERSION` 里；
  `tests/client.test.mjs` 断言它与 `package.json` 一致，发版漏改会直接红。
- README 增加「更新」一节：为什么第三方插件没有一键更新、卸载重装的完整步骤、
  数据目录不受影响、以及走 npm / 插件市场索引的选项。

### Tests

66 个测试（新增：客户端版本号与 package.json 同步、SemVer 比较）。

## [0.6.2] - 2026-10-24

修插件热更新（HMR）后「SSH 远程」面板变空的问题。

### Fixed

- **热更新后 SSH 面板空列表（无主机、无新建会话）**。客户端原本每次 `apply()` 都
  直接读取 `ctx.webTerminals.launchShells` 并包一层过滤；而 `apply()` 在插件热更新时
  会再跑一次，服务对象是共享的，于是第二次把「已经过滤过的」函数当成原始函数再过滤
  一次——SSH 面板拿到的列表被自己的过滤逻辑清空（原生「新建终端」下拉仍然正常，因为
  它看到的就是过滤后的结果）。
  现在过滤包装是幂等的：用 `__dshRcInner` 保存原始方法、只在未包装时包一层，
  并在 `ctx.effect` 的 dispose 里还原。新增 `tests/client.test.mjs` 用替身环境
  连续调用两次 `apply()` 来锁定这个回归。

> 从 0.6.0/0.6.1 升级时，旧版本留下的包装无法自愈：**重启一次 DSH 桌面 App
> （或整页刷新）** 即可恢复，之后的热更新不会再触发这个问题。

## [0.6.1] - 2026-10-23

实机测试报告（macOS + DSH 0.2.1-rc.2 + Linux 远端）里的三个 bug 修复，另有两处可用性改进。

### Fixed

- **macOS：`date -Is` 不支持**。`bin/dsh-ssh` 的日志时间戳改用可移植的
  `date -u +%Y-%m-%dT%H:%M:%SZ`，并把失败时的 stderr 吞掉。此前每次打开 console
  终端首行都会出现 `date: invalid argument`，`wrapper.log` 时间戳为空。
- **`exit` 后提示语误导**。面板指定主机 / 新建会话是一次性模式：ssh 退出后整个
  终端结束。此前的提示照搬菜单模式写着「回到远端选择」，让人以为还能继续用。
  现在一次性模式明确显示「这个终端已经结束」，并提示重新打开终端、重新登录；
  菜单模式仍显示「回到远端选择」。
- **脱敏误伤 `PWD=`**。敏感键名列表去掉了 `pwd`（`passwd` 仍然脱敏），
  `PWD=$(pwd)` 这类正常日志不再被写成 `[REDACTED]`。

### Changed

- **`exit` / `logout` / `pkill ssh` 现在需要审批**：`remote_run` 里这些命令会结束
  整个 console，之后所有 `remote_*` 工具失效且需要人工重新登录，因此和危险命令
  一样走 `ctx.approval` 的一次性授权（`remote_exec` 不受影响，它是 `sh -c` 子进程）。
- **`remote_run` 的结果字段改名**：PTY 里 stderr 与 stdout 合并输出，原来的
  `stdout:` 标签有误导，改为 `output (PTY, stdout+stderr merged):`；
  `remote_exec` 仍分别返回 `stdout:` / `stderr:`。
- 终端结束时的 `note` 统一为：「终端已结束（ssh 退出或窗口关闭），所有 remote_*
  工具都会失败；请人工在右侧栏重新打开 SSH 终端并重新登录」。
- README 补充：Electron 桌面版的 profile 由 App 管理，要用 App 内置插件管理器安装，
  `dsh plugin --profile desktop` / `dsh --profile desktop --dump-config` 会被拒绝。

### Tests

61 个测试（新增：`PWD=` 不误脱敏、`exit/logout/pkill ssh` 判定、macOS BSD `date`
下的时间戳与无报错输出、ssh 退出后两种模式的提示语）。

## [0.6.0] - 2026-10-23

首个版本：右侧栏 SSH 远程终端、agent 写进同一个 PTY、OSC 退出码、统一日志、
认证期拒写、危险命令审批、崩溃残留日志清扫、44 个测试、双语文档。

[Unreleased]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.5...HEAD
[0.10.6]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/cccodder/dsh-remote-console/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/cccodder/dsh-remote-console/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/cccodder/dsh-remote-console/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/cccodder/dsh-remote-console/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/cccodder/dsh-remote-console/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.7...v0.7.0
[0.6.7]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.6...v0.6.7
[0.6.6]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/cccodder/dsh-remote-console/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/cccodder/dsh-remote-console/releases/tag/v0.6.0
