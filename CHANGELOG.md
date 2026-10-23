# Changelog

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
