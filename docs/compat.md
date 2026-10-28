# 兼容性矩阵（0.7.0）

插件包住的是 DSH 的终端服务（不是文档化扩展点），所以「支持哪些 DSH / 平台 / 能力」需要用验证结果
说话，而不是「理论上能用」。本文列出验证过的范围、没验证的部分，以及安装时会踩的坑。

**结论速查**

- 支持的 DSH：`>=0.2.1-rc.2 <0.3.0-0`（`package.json` 的 `engines.dsh`，`<0.3.0-0` 把 0.3.0
  及其预发布版本一并排除）。
- 支持的平台：macOS、Linux（CI 只覆盖 Linux；macOS 按发版前真机清单验证）。**Windows 尚未支持**，
  计划在下个版本支持。
- 文件传输、文件读写、端口转发都建立在**一个活着的 SSH 终端**上：它们复用该终端的
  ControlMaster socket；终端结束后立即失败（`BatchMode=yes`，fail closed），不会重新认证。

## DSH 版本

| DSH 版本 | 状态 | 依据 |
| --- | --- | --- |
| `0.2.1-rc.2` | ✅ 已验证 | CI 固定安装这一版跑单元测试与发版元数据检查；代码审计时在真实安装里装载成功（`tools registered`） |
| `>=0.2.1-rc.2 <0.3.0-0`（0.2.x 后续版本） | ⚠️ 未逐版验证 | `engines.dsh` 允许安装；每周一次的 `DSH next` 任务只作预警（单测通过 ≠ 真机验证），不代表承诺支持 |
| `0.3.0`、`0.3.0-rc.*` 等 0.3.0 预发布 | ❌ 未验证 | 被 `engines.dsh` 排除。DSH 会在安装/启动时以 `incompatible-version` 拒绝；可显式做精确版本豁免（`dsh plugin --profile <profile> allow-version dsh-remote-console@<版本> --dsh-version <DSH 版本> --accept-risk`），但插件没测过，风险自担 |
| `< 0.2.1-rc.2` | ❌ 不支持 | 使用的终端服务/工具 API 在这一版之前不存在或不兼容 |

DSH 的兼容性检查只看 manifest 里的 `engines.dsh`（存在 `engines.dsh` 时 `peerDependencies`
不参与判定）。所以范围写错会直接被拦，不要靠「先装上再说」。

## 平台

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS（Intel / Apple Silicon） | ✅ 支持 | 包装器保持 POSIX bash + BSD `date` 兼容（0.6.1 修过 `date -Is`）；真机检查项见 [verify-e2e.md](verify-e2e.md) 与 [release-checklist.md](dev/release-checklist.md)。CI 不跑 macOS |
| Linux（x64 / arm64） | ✅ 支持 | CI 在 `ubuntu-latest` 跑测试；插件本身没有平台相关二进制 |
| Windows | ✅ 支持（实验性） | `bin/dsh-ssh.mjs`（Node 包装器）替代 bash 脚本；Windows OpenSSH 没有 ControlMaster，工具自动退回 PTY 通道（传输 ≤1 MiB），端口转发不可用。本机无 Windows 环境，逻辑用 Linux 等价路径验证（Node 包装器、PTY 分块读写、通道选择、工具自动回退），真实 conpty 观感待真机确认 |
| 其他（BSD 等） | ❌ 未验证 | 理论上包装器可移植，但没有测试记录 |

## 能力矩阵

「依赖的 DSH 内部点」一列是插件真正接触的东西；DSH 改这些实现时，对应能力需要同步适配。
平台列均指在支持的 `engines.dsh` 范围内：DSH 不在范围内（例如 0.3.0）时，下表所有能力都算未验证。

| 能力 | 依赖的 DSH 内部点 / 机制 | macOS | Linux | Windows | 备注 |
| --- | --- | --- | --- | --- | --- |
| 终端同屏（人与 agent 共用同一个 PTY） | `ctx.subprocess.spawnTerminal`、`ctx.terminalController.shells/retain`、客户端 `ctx.webTerminals.launchShells` | ✅ | ✅ | ✅（实验性） | 核心能力；渲染/输入复用 DSH 自带终端。Windows 用 Node 版包装器 `bin/dsh-ssh.mjs`，启动器是 `node dsh-ssh.mjs --host/--target` |
| 16 个工具（终端 6 个 + 文件 4 个 + 转发 1 个 + 审计 2 个 + 主机列表 3 个） | `defineTool`；`remote_run` 走 PTY + OSC 退出码；`remote_exec` 复用 ControlMaster socket | ✅ | ✅ | ✅（PTY 回退） | 除 `remote_audit_*` 外都需要活着的终端；`remote_exec` 为带外执行（窗口不可见，但落统一日志）。Windows 无 ControlMaster 时自动走 PTY：命令/数据在窗口可见、stdout/stderr 合并、传输 ≤1 MiB |
| 文件传输（`remote_upload` / `remote_download`） | 已认证的 ControlMaster socket（`remote_exec` 通道）；无 socket 时 PTY + base64 分块 | ✅ | ✅ | ✅（PTY，≤1 MiB） | 必须先有活着的 SSH 终端；流式传输并双向校验 sha256；默认不覆盖；单文件上限 256 MB（PTY 通道 1 MiB）；`remote_upload` 写敏感远端路径前审批 |
| 文件读写（`remote_read_file` / `remote_write_file`） | 已认证的 ControlMaster socket；无 socket 时 PTY + base64 | ✅ | ✅ | ✅（PTY，≤1 MiB） | 读：默认 128 KB、上限 256 KB，二进制拒绝显示；写：≤256 KB UTF-8；socket 通道走 stdin 不进窗口，PTY 通道会经过用户窗口；敏感路径审批 |
| 端口转发（`remote_forward` start/stop/list） | `ssh -N -L 127.0.0.1:<local>:<remote_host>:<remote_port>`（需要 ControlMaster） | ✅ | ✅ | ❌ | 只绑回环地址，局域网其他机器连不上；终端结束或 `remote_close` 时自动停止；不重新认证。Windows 没有可复用连接，明确报 `FORWARD_UNAVAILABLE` |
| 危险命令 / 终端终止命令审批 | DSH `ctx.approval` | ✅ | ✅ | ✅ | 无审批服务（headless）时拒绝执行（fail closed）；`DSH_RC_DANGER_GUARD=off` 可显式关闭 |
| 关窗即失能 | `ctx.terminalController.retain` 的窗口持有 | ✅ | ✅ | ✅ | 关标签立即杀进程树；关浏览器 8 秒宽限；DSH 崩溃时 ssh 随 HUP 退出（Windows 上 conpty 子进程同样被终止） |
| 跨会话审计日志（`remote_audit_read` / `remote_audit_export`） | 宿主侧文件 `audit/audit.jsonl`（不依赖终端） | ✅ | ✅ | ✅ | 只记 agent 动作，不含屏幕输出；8 MB 滚动保留 5 份；`DSH_RC_AUDIT=off` 可关 |
| 设置页：主机列表（插件行配置） | DSH `ctx.configForms` + `settings.describe`；宿主 `Config` 的 `volatile()` 字段；客户端 `plugins.row.config` slot | ✅（未在真实浏览器逐项验证） | ✅（未在真实浏览器逐项验证） | ✅（浏览器界面，与宿主平台无关） | 部署里没有 configForms（精简组合/老 DSH）时不注册、不影响终端；写入的是 profile patch 里的行配置 |
| 插件市场「有新版本」 | GitHub Release 查询（6 小时缓存）+ 市场索引 format 1 | ✅ | ✅ | ✅ | 离线/限流/CORS 失败静默；更新入口依赖市场索引 |

## peer 依赖

| 包 | 声明范围 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `~4.0.5` | 由 DSH 提供，插件不打包 |
| `@deepseek-ai/dsh-home-paths` | `>=0.2.1-rc.2 <0.3.0` | 用于解析 `DSH_HOME` |
| `@deepseek-ai/dsh-tools` | `>=0.2.1-rc.2 <0.3.0` | `defineTool` / 工具注册 |

peer 依赖不随插件安装，来自运行中的 DSH。manifest 有 `engines.dsh` 时，DSH 只按
`engines.dsh` 判定兼容性，peer 范围不会单独再拦一次；但 peer 版本差太多仍可能在运行期报错
（导入失败、工具注册失败），所以不要手动替换 peer 包。`engines.node >= 20` 只约束开发与测试
（插件代码跑在 DSH 进程里，不单独起 Node）。

## 安装注意事项

1. **DSH 版本**：先 `dsh -V`（桌面 App 以 App 内版本为准）确认在 `>=0.2.1-rc.2 <0.3.0-0` 内。
   不在范围内会被 DSH 以 `incompatible-version` 拒绝，这是设计行为。

2. **ssh 客户端**：插件不捆绑 `ssh`。`command -v ssh` 必须能找到一个 OpenSSH 客户端
   （Linux 装 `openssh-client`，macOS 自带）。故障排查见 [README 的「故障排查」](../README.md#故障排查)。

3. **pnpm 11 的构建脚本拦截**：DSH 的 profile 由 pnpm 管理，安装插件时 DSH 以非交互方式跑
   pnpm。pnpm 11 默认 `strictDepBuilds: true`，依赖的 install/postinstall 脚本不再自动执行：
   pnpm 打印 `Ignored build scripts: <包名>` 并让安装失败（本机 pnpm 11.7.0 实测报
   `ERR_PNPM_IGNORED_BUILDS`）。DSH 0.2.1-rc.2 把这种情况报成 `build-blocked`，并给出
   `pendingBuilds`。处理：在 **profile 目录**的 `pnpm-workspace.yaml` 里放行对应包，然后重试安装：

   ```yaml
   allowBuilds:
     <包名>: true
   ```

   注意 DSH 会先写入占位值 `set this to true or false`，要明确改成 `true`；也可以在 profile
   目录执行 `pnpm approve-builds <包名>`。本插件自身没有安装脚本、也没有普通依赖（只有
   peerDependencies），通常不会触发；触发的是安装过程中带构建脚本的第三方包或原生模块。
   与 DSH 自带的官方插件市场无关，官方插件走 DSH 自己的安装流程。

4. **pnpm 11 的 `minimumReleaseAge`**：默认 1440 分钟（1 天），刚发布的版本 24 小时内可能解析
   不到。刚发版就想装，等一天，或在 profile 的 `pnpm-workspace.yaml` 设
   `minimumReleaseAge: 0`（会降低供应链保护，只建议临时用）。

5. **pnpm 11 的配置位置**：pnpm 11 不再从 `.npmrc` 读取非认证配置，`allowBuilds` /
   `minimumReleaseAge` 这类设置要写在 `pnpm-workspace.yaml`（profile 目录）或全局
   `~/.config/pnpm/config.yaml`。照旧文章改 `.npmrc` 会看起来「没生效」。

6. **没有 pnpm**：DSH 报 `pnpm-missing` 时先安装 pnpm（`npm install -g pnpm`），再重试安装插件。

## 验证方法与时间

- 验证日期：2026-10-28；插件 `0.7.0`；DSH `0.2.1-rc.2`（Linux）。
- 单元测试与发版元数据：`npm test`、`node scripts/check-release.mjs`。
- CI：`.github/workflows/ci.yml` 固定 DSH `0.2.1-rc.2`；`.github/workflows/compat.yml` 每周跑
  一次 DSH `next`，只作预警。
- SSH 通道性能基线：`scripts/bench.mjs`（见 [README 的「性能基线」](../README.md#性能基线loopback)）。
- 真机端到端清单：[verify-e2e.md](verify-e2e.md)；发版前真机检查：
  [release-checklist.md](dev/release-checklist.md)。
- 安全模型与漏洞报告：[SECURITY.md](../SECURITY.md)；插件承诺见
  [README 的「安全模型」](../README.md#安全模型)。

---

# Compatibility matrix (0.7.0)

The plugin wraps DSH terminal services that are not documented extension points, so "what works"
is defined by verification, not by theory. This page lists the verified range, what is **not**
verified, and the installation traps.

**Quick summary**

- Supported DSH: `>=0.2.1-rc.2 <0.3.0-0` (`engines.dsh`; `<0.3.0-0` also excludes 0.3.0
  prereleases).
- Supported platforms: macOS and Linux (CI covers Linux only; macOS follows the pre-release
  real-device checklist). **Windows is not supported yet**; support is planned for the next release.
- File transfer, remote file read/write and port forwarding ride on **one live SSH terminal**:
  they reuse that terminal's ControlMaster socket. When the terminal ends they fail immediately
  (`BatchMode=yes`, fail closed) and do not re-authenticate.

## DSH versions

| DSH version | Status | Basis |
| --- | --- | --- |
| `0.2.1-rc.2` | ✅ Verified | CI pins this version for unit tests and release metadata checks; a real install loaded the plugin (`tools registered`) during the audit |
| `>=0.2.1-rc.2 <0.3.0-0` (later 0.2.x) | ⚠️ Not verified per release | `engines.dsh` allows installation; the weekly `DSH next` job is an early warning only (green unit tests ≠ real-device verification) |
| `0.3.0`, `0.3.0-rc.*` prereleases | ❌ Not verified | Excluded by `engines.dsh`. DSH refuses install/startup with `incompatible-version`; an exact-version exemption is possible (`dsh plugin --profile <profile> allow-version dsh-remote-console@<version> --dsh-version <dsh-version> --accept-risk`) but the plugin is untested there — use at your own risk |
| `< 0.2.1-rc.2` | ❌ Unsupported | The terminal services / tool APIs this plugin needs do not exist or are incompatible |

DSH checks the manifest's `engines.dsh` alone (when present, `peerDependencies` are not part of
the decision). A wrong range is refused outright — do not rely on "install it anyway".

## Platforms

| Platform | Status | Notes |
| --- | --- | --- |
| macOS (Intel / Apple Silicon) | ✅ Supported | The wrapper stays POSIX-bash and BSD-`date` compatible (the `date -Is` bug was fixed in 0.6.1); manual checks are in [verify-e2e.md](verify-e2e.md) and [release-checklist.md](dev/release-checklist.md). CI does not run macOS |
| Linux (x64 / arm64) | ✅ Supported | CI runs the tests on `ubuntu-latest`; the plugin ships no platform-specific binaries |
| Windows | ❌ Not supported | `bin/dsh-ssh` is a bash wrapper and needs a system `ssh`; WSL / Git Bash paths are unverified. Planned for the next release (no date promised) |
| Others (BSD, ...) | ❌ Not verified | The wrapper is probably portable, but there is no test record |

## Capabilities

The "DSH internals" column is what the plugin actually touches; a DSH change there needs a matching
plugin update. Platform columns assume a supported `engines.dsh` version: outside that range
(for example on 0.3.0) every capability below is unverified.

| Capability | DSH internals / mechanism | macOS | Linux | Windows | Notes |
| --- | --- | --- | --- | --- | --- |
| Shared terminal (human and agent in the same PTY) | `ctx.subprocess.spawnTerminal`, `ctx.terminalController.shells/retain`, client `ctx.webTerminals.launchShells` | ✅ | ✅ | ❌ | Core capability; rendering and input reuse DSH's terminal |
| The six original tools (`remote_status` / `remote_run` / `remote_exec` / `remote_screen` / `remote_log` / `remote_close`) | `defineTool`; `remote_run` uses the PTY + OSC exit code; `remote_exec` reuses the ControlMaster socket | ✅ | ✅ | ❌ | Needs a live terminal; `remote_exec` is out of band (invisible in the window, still in the unified log) |
| File transfer (`remote_upload` / `remote_download`) | The authenticated ControlMaster socket (the `remote_exec` channel) | ✅ | ✅ | ❌ | Requires a live SSH terminal; streams and verifies sha256 on both sides; refuses to overwrite by default; 256 MB per file; `remote_upload` asks for approval before writing sensitive remote paths (`~/.ssh`, `/etc`, sudoers, shell profiles) |
| Remote file read/write (`remote_read_file` / `remote_write_file`) | The authenticated ControlMaster socket | ✅ | ✅ | ❌ | Read: 128 KB default, 256 KB max, binary refused; write: ≤256 KB UTF-8 over stdin, never in the terminal window; sensitive paths need approval |
| Port forwarding (`remote_forward` start/stop/list) | `ssh -N -L 127.0.0.1:<local>:<remote_host>:<remote_port>` | ✅ | ✅ | ❌ | Loopback bind only — other machines on the LAN cannot reach it; stops when the terminal ends or `remote_close` runs; no re-authentication |
| Dangerous / terminal-ending command approval | DSH `ctx.approval` | ✅ | ✅ | ❌ | Fails closed when no approval service is mounted (headless); `DSH_RC_DANGER_GUARD=off` disables it explicitly |
| Closing revokes access | `ctx.terminalController.retain` window holds | ✅ | ✅ | ❌ | Closing the tab kills the process tree; closing the browser has an 8 s grace; a DSH crash drops the PTY and ssh exits on HUP |
| Plugin market "update available" | GitHub Release lookup (6 h cache) + market index format 1 | ✅ | ✅ | ❌ | Offline / rate-limit / CORS failures stay silent; the Update entry depends on the market index |

## Peer dependencies

| Package | Declared range | Notes |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `~4.0.5` | Provided by DSH, not bundled |
| `@deepseek-ai/dsh-home-paths` | `>=0.2.1-rc.2 <0.3.0` | Resolves `DSH_HOME` |
| `@deepseek-ai/dsh-tools` | `>=0.2.1-rc.2 <0.3.0` | `defineTool` / tool registration |

Peers are not installed with the plugin; they come from the running DSH. When `engines.dsh` is
present, DSH judges compatibility by that range alone and does not separately enforce peer ranges —
but badly mismatched peers can still fail at runtime (import or tool registration errors), so do not
swap peer packages by hand. `engines.node >= 20` only constrains development and tests (the plugin
runs inside the DSH process, not in its own Node).

## Installation notes

1. **DSH version**: run `dsh -V` first (the desktop app's bundled DSH is the one that counts) and
   make sure it is within `>=0.2.1-rc.2 <0.3.0-0`. Versions outside the range are refused with
   `incompatible-version` by design.

2. **ssh client**: the plugin does not bundle `ssh`. `command -v ssh` must find an OpenSSH client
   (install `openssh-client` on Linux; macOS ships one). See the troubleshooting section in the
   [README](../README.en.md#troubleshooting).

3. **pnpm 11 blocks dependency build scripts**: DSH manages profiles with pnpm and runs it
   non-interactively. pnpm 11 defaults to `strictDepBuilds: true`, so dependency install/postinstall
   scripts no longer run automatically: pnpm prints `Ignored build scripts: <name>` and fails the
   install (observed on pnpm 11.7.0 as `ERR_PNPM_IGNORED_BUILDS`). DSH 0.2.1-rc.2 reports this as
   `build-blocked` with `pendingBuilds`. Fix by allowing the package in the **profile's**
   `pnpm-workspace.yaml`, then retry:

   ```yaml
   allowBuilds:
     <package>: true
   ```

   DSH first writes the placeholder `set this to true or false`; change it to `true` explicitly.
   In the profile directory you can also run `pnpm approve-builds <package>`. This plugin has no
   install scripts and no regular dependencies (peerDependencies only), so it normally does not
   trigger this; third-party packages or native modules pulled in during installation do. This is
   unrelated to the official plugin market, which uses DSH's own install flow.

4. **pnpm 11 `minimumReleaseAge`**: defaults to 1440 minutes (1 day), so a just-published version
   may not resolve within 24 hours. Wait a day, or set `minimumReleaseAge: 0` in the profile's
   `pnpm-workspace.yaml` (weakens supply-chain protection; use only temporarily).

5. **pnpm 11 config location**: pnpm 11 no longer reads non-auth settings from `.npmrc`; settings
   such as `allowBuilds` and `minimumReleaseAge` live in `pnpm-workspace.yaml` (profile directory)
   or the global `~/.config/pnpm/config.yaml`. Editing `.npmrc` as older guides say will look like
   "it has no effect".

6. **No pnpm**: when DSH reports `pnpm-missing`, install pnpm first
   (`npm install -g pnpm`), then retry the plugin install.

## Verification method and date

- Verified on 2026-10-28; plugin `0.7.0`; DSH `0.2.1-rc.2` (Linux).
- Unit tests and release metadata: `npm test`, `node scripts/check-release.mjs`.
- CI: `.github/workflows/ci.yml` pins DSH `0.2.1-rc.2`; `.github/workflows/compat.yml` runs the
  DSH `next` tag weekly as an early warning only.
- SSH channel baseline: `scripts/bench.mjs` (see the
  [README benchmark section](../README.en.md#benchmark-loopback)).
- Manual end-to-end checklist: [verify-e2e.md](verify-e2e.md); release-device checklist:
  [release-checklist.md](dev/release-checklist.md).
- Security model and vulnerability reporting: [SECURITY.md](../SECURITY.md); what the plugin
  promises: [README security model](../README.en.md#security).
