# Security Policy

## Supported versions

The current `0.7.x` / `0.8.x` lines are supported. `engines.dsh` in `package.json` pins the DeepSeek Harness
versions the plugin is verified against (`>=0.2.1-rc.2 <0.3.0-0`); newer DSH majors are not
supported until a plugin release widens that range.

## Reporting a vulnerability

Please report privately, not in a public issue:

- Open a draft advisory at
  https://github.com/cccodder/dsh-remote-console/security/advisories/new
  (GitHub shows it only to the maintainer), or
- Use **Report a vulnerability** on the repository's **Security** tab.

Include: the plugin version, the DSH version and how it is installed (Desktop app / `dsh` CLI),
the OS, what you expected, what happened, and the exact error text. Screenshots are welcome, but
remove host names, user names, passwords and tokens first.

Please do not test against someone else's machines or include real credentials in a report.

Solo-maintainer project: best effort acknowledgement within 7 days. A fix is released as a patch
version through the normal release process (see [CONTRIBUTING.md](CONTRIBUTING.md)), and the
advisory is published after users have had a reasonable time to update.

## What the plugin promises (and does not)

The plugin protects the SSH credentials and the user's machine from the agent; it cannot protect
the remote host from an agent the user has already authorized to run commands there.

- **Credentials never pass through the plugin.** The password/passphrase is typed into `ssh`'s own
  prompt. `hosts.tsv` stores host/user/port only (0600); the data directory is 0700; no key
  material is read or written.
- **No writes during authentication.** While the terminal waits on `password:`, `(yes/no)?` or a
  host-key warning, agent writes are rejected (`AUTH_REQUIRED`).
- **Dangerous and terminal-ending commands need approval.** `remote_run` / `remote_exec` bypass the
  DSH sandbox, so high-risk patterns and `exit` / `logout` / `pkill ssh` go through DSH's
  `ctx.approval` as a one-shot grant; with no approval service the command fails closed.
  `DSH_RC_DANGER_GUARD=off` disables this on purpose and is audited in the session log.
- **Closing revokes access.** Closing the terminal tab kills the process tree; closing the browser
  does it after the last window hold disappears (8s grace, a refresh cancels); a DSH crash drops
  the PTY and `ssh` exits on HUP.
- **Logs are short-lived, the audit trail is not.** The per-session JSONL (which contains screen
  output) is deleted when the PTY ends; crash-left logs are swept at startup. A separate audit trail
  (`audit/audit.jsonl`, 0600) keeps agent actions across sessions — redacted command text, exit
  codes, approval outcomes, transfer paths and sha256, forwards — never screen output and never the
  text the user typed. `DSH_RC_AUDIT=off` disables writing it. Known secret shapes are redacted in
  both, but plaintext secrets inside command arguments can still appear during the session — prefer
  environment variables or `ssh-agent`.

## Known limitations

- The plugin wraps DSH terminal services that are **not documented extension points**
  (`ctx.subprocess.spawnTerminal`, `ctx.terminalController.shells|retain`, client
  `ctx.webTerminals.launchShells`). A DSH update can change them; CI checks the pinned DSH
  version and a weekly job tries the DSH `next` tag.
- Windows support is experimental: the terminal runs through a Node wrapper (`bin/dsh-ssh.mjs`) and,
  because Windows OpenSSH has no ControlMaster, the tools fall back to the PTY channel — transfers are
  capped at 1 MiB and port forwarding is unavailable. There is no Windows machine in CI, so this path
  is verified only through equivalent Linux paths.
- `remote_screen` is not a full terminal emulator; trust `remote_run` / `remote_exec` for results.

---

# 安全说明（中文）

## 支持范围

当前 `0.7.x` / `0.8.x` 系列受支持。`package.json` 的 `engines.dsh` 声明了验证过的 DeepSeek Harness
范围（`>=0.2.1-rc.2 <0.3.0-0`）；DSH 大版本升级后，要在插件发版放宽范围前视为不支持。

## 报告安全问题

请私密报告，不要开公开 issue：

- 在 https://github.com/cccodder/dsh-remote-console/security/advisories/new 开一个草稿公告
  （只有维护者可见），或
- 用仓库 **Security** 标签页的 **Report a vulnerability**。

请附：插件版本、DSH 版本与安装方式（桌面版 / `dsh` CLI）、操作系统、期望结果、实际结果和
原始报错；截图请先去掉主机名、用户名、密码和 token。不要拿别人的机器做测试，也不要在报告里
放真实凭据。

个人维护项目：尽量 7 天内确认。修复走正常发版流程（见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)），
给用户合理的升级时间后再公开公告。

## 插件保证什么、不保证什么

插件保护的是「凭据不被 agent/日志带走」和「破坏性操作要你点头」，它不保护你已经授权 agent
去操作的远端主机。

- **凭据不经过插件**：密码/口令只在 `ssh` 自己的提示符里输入；`hosts.tsv` 只存
  host/user/port（0600），数据目录 0700，不读也不写任何私钥。
- **认证期拒写**：终端停在 `password:`、`(yes/no)?`、主机指纹警告时，agent 的写入被拒绝
  （`AUTH_REQUIRED`）。
- **危险命令与终止命令要审批**：`remote_run`/`remote_exec` 绕过 DSH 沙箱，高危模式和
  `exit`/`logout`/`pkill ssh` 走 `ctx.approval` 一次性授权；没有审批服务时拒绝执行。
  `DSH_RC_DANGER_GUARD=off` 是显式关闭，且会在会话日志里留审计记录。
- **关窗即失能**：关终端标签立即杀进程树；关浏览器在最后一个窗口持有消失 8 秒后回收
  （刷新会取消）；DSH 崩溃时 PTY 消失，`ssh` 随 HUP 退出。
- **会话日志短命，审计日志保留**：会话结束即删除含屏幕输出的会话 JSONL，崩溃残留会在下次启动
  时清扫。审计日志（`audit/audit.jsonl`，0600）单独一条线，跨会话保留 agent 的动作——脱敏后的
  命令文本、退出码、审批结果、传输路径与 sha256、端口转发——不含屏幕内容，也不含你手敲的字；
  `DSH_RC_AUDIT=off` 可停止写入。两边都会对常见密钥形态脱敏，但命令参数里的明文密钥在会话期间
  仍可能出现——敏感操作请用环境变量或 `ssh-agent`。

## 已知限制

- 插件包的是 DSH 的终端服务，**不是文档化扩展点**；DSH 更新可能改变它们。CI 验证固定的
  DSH 版本，另有一个每周任务试 DSH `next`。
- Windows 支持是实验性的：终端走 Node 包装器（`bin/dsh-ssh.mjs`）；Windows 版 OpenSSH 没有
  ControlMaster，工具退回 PTY 通道——传输上限 1 MiB、端口转发不可用。CI 里没有 Windows 机器，
  这条路径只用 Linux 上的等价路径验证过。
- `remote_screen` 不是完整终端模拟器，结果以 `remote_run`/`remote_exec` 为准。
