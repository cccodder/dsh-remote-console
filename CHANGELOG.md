# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor version can
contain breaking changes; the plugin wraps DSH terminal services that are not published
extension points, so a DSH minor release may need a plugin release.

## [Unreleased]

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

[Unreleased]: https://github.com/cccodder/dsh-remote-console/compare/v0.7.1...HEAD
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
