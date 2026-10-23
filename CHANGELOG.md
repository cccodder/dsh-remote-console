# Changelog

## 0.6.3

面板里能看到「有没有新版本」，并补上更新路径说明。

### Added

- **版本号 + 更新提示**：SSH 面板底部显示当前版本（`v0.6.3`）。客户端向
  `api.github.com` 查最新 Release（结果缓存 6 小时，失败静默），有更高版本时在同一行
  显示「有新版本 vX.Y.Z」，点击打开 GitHub Release 页。
- **版本号同步保护**：客户端是手写 bundle，版本号写在 `lib/client.js` 的 `VERSION` 里；
  `tests/client.test.mjs` 断言它与 `package.json` 一致，发版漏改会直接红。
- README 增加「更新」一节：为什么第三方插件没有一键更新、卸载重装的完整步骤、
  数据目录不受影响、以及未来走 npm / 插件市场索引的选项。

### Tests

66 个测试（新增：客户端版本号与 package.json 同步、SemVer 比较）。

## 0.6.2

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

## 0.6.1

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

- 61 个测试（新增：`PWD=` 不误脱敏、`exit/logout/pkill ssh` 判定、macOS BSD `date`
  下的时间戳与无报错输出、ssh 退出后两种模式的提示语）。

## 0.6.0

首个版本：右侧栏 SSH 远程终端、agent 写进同一个 PTY、OSC 退出码、统一日志、
认证期拒写、危险命令审批、崩溃残留日志清扫、44 个测试、双语文档。
