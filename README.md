# dsh-remote-console

DSH 右侧栏的「SSH 远程控制终端」：你在这里亲手输 SSH 密码，agent 通过**同一个 PTY** 读写远端；
人的操作和 agent 的操作落在同一条可回看的日志里。

它不重新实现终端：渲染、输入、窗口管理全部复用 DSH 自带的终端，插件只做三件事——
往 shell 列表里加远端启动器、捕获这条 PTY 的字节流、给 agent 一组写进同一个终端的工具。

## 它解决什么

普通的「agent 远程执行」通常是另开一条 ssh 通道，于是：

- 你看不到 agent 在远端敲了什么，也接不回它的会话；
- 密码、sudo、主机指纹这些必须由人完成的交互没有地方做；
- `cd`/`export` 这类 shell 状态在两次调用之间丢失。

这个插件把 agent 放进**你正在看的那个终端**：agent 的命令像人打字一样出现在窗口里，
退出码由 shell 自己的 `PROMPT_COMMAND` 钩子（OSC 序列）回报，而不是靠猜提示符。

## 安装

要求：DSH `>= 0.2.1-rc.2 <0.3.0`，本机有系统 `ssh` 客户端。

**CLI 管理的 profile**（例如 `web`）：

```bash
# 1. 装进 profile（--profile 换成你自己的 profile 名）
dsh plugin --profile web add /path/to/dsh-remote-console

# 2. 把插件加进该 profile 的 bundle 列表
#    编辑 $DSH_HOME/profiles/web/package.json：
#      "dsh": { "profile": { "bundles": [ ..., "dsh-remote-console" ] } }

# 3. 确认插件层被组合进来（应看到 id: dsh-remote-console）
dsh --profile web --dump-config | grep -A2 dsh-remote-console
```

**Electron 桌面版**：`desktop` profile 由 App 独占管理，CLI 会直接拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。
请用 App 内置的**插件管理器**粘贴仓库地址安装（`github:cccodder/dsh-remote-console`），
它会自动写入 profile 的 `dependencies` 与 `dsh.profile.bundles`。注意全局 `dsh` CLI
版本可能低于 App 自带的 DSH，以 App 内的版本为准。

不需要 Python、不需要改 `~/.ssh/config`、不改 shell rc。

## 用法

1. 右侧栏 →「SSH 远程」卡片 → 选中一个远端（来自 `~/.ssh/config` 的 Host，或手动新建）。
2. 终端里执行 `ssh -M -S <sock> -t <host>`，密码/口令由 `ssh` 自己提示，**插件不接触**。
3. 登录成功后 agent 可用这些工具：

| 工具 | 作用 |
| --- | --- |
| `remote_status` | 终端、主机、socket、状态、最后几行屏幕 |
| `remote_run(command)` | 写进同一个 PTY（窗口里可见），返回输出 + 真实退出码（PTY 会把 stderr 并进输出） |
| `remote_exec(command, cwd?)` | 复用 ControlMaster socket 的带外执行：原生 stdout/stderr/退出码，不污染终端窗口 |
| `remote_screen(lines)` | 当前屏幕纯文本（剥 ANSI） |
| `remote_log(cursor)` | 统一 JSONL 日志的增量读：人敲的命令、agent 的命令、两边输出 |
| `remote_close()` | 断开 ssh master 并清理 socket/rendezvous 文件 |

`remote_run` 适合：要你看着执行、需要 TTY（sudo/vim/嵌套 ssh）、需要在两次调用间保留 shell 状态。
`remote_exec` 适合：纯数据收集、脚本、必须用退出码判断成败的事。

**注意 `exit` 的语义**：面板里的主机启动器和「新建会话」都是一次性的——远端 shell 退出
（命令里带 `exit`、`logout`，或 ssh 断开）后，整个终端就结束了，所有 `remote_*` 工具失效，
需要人工重新打开终端并重新输密码。插件会拦下这类命令要一次审批，并在终端里明确提示
「这个终端已经结束」，不会假装还能继续用。

## 安全模型

- **凭据不经过插件**：密码只在 `ssh` 自己的提示符里输入。`hosts.tsv` 只记 host/user/port（0600），
  数据目录 0700；仓库里不含任何密钥。
- **认证期拒写**：屏幕停在 `password:`、`(yes/no)?`、`Permission denied` 等状态时，
  agent 的任何写入都会被拒绝（`AUTH_REQUIRED`），避免它替你回答认证问题。
- **危险命令审批**：`remote_run` / `remote_exec` 绕过 DSH 沙箱，所以插件额外加了一道闸门：
  命中 `rm -rf`、`mkfs`、`dd of=/dev/*`、`shutdown/reboot`、fork bomb、`curl | sh`、
  `git push --force`、`DROP TABLE` 等模式时，通过 DSH 的 `ctx.approval` 弹一次审批卡片，
  **一次授权只对本次命令有效**；没有审批服务（headless/未挂载 answerer）时直接拒绝执行。
  `remote_run` 里会结束整个终端的 `exit` / `logout` / `pkill ssh` 同样需要审批。
- **日志会消失**：PTY 结束即删除会话日志（保留内存事件供当场回看）；DSH 崩溃留下的
  残留日志会在下次插件启动时清扫。日志写入前会对 Bearer token、`sk-*`、
  `password=/token:/secret=` 一类赋值做脱敏，但**命令参数里的明文密钥仍可能出现在会话期间**，
  敏感操作请用环境变量或 `ssh-agent`。
- **关窗即失能**：关终端标签立即杀进程树；关浏览器在最后一个窗口持有消失 8 秒后杀
  （刷新会重连并取消）；DSH 崩溃时 PTY master 消失，`ssh` 随 HUP 退出。

> 威胁模型：插件保护的是「凭据不被 agent/日志带走」和「破坏性操作需你点头」，
> 它不能防御你已经授权的 agent 在远端做任何事。远端命令本身就是你给 agent 的能力。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_REMOTE_CONSOLE_DIR` | `$DSH_HOME/remote-console` | 数据目录（logs/sessions/socks/bin） |
| `DSH_SSH_CONFIG` | `~/.ssh/config` | 主机别名来源 |
| `DSH_RC_DANGER_GUARD` | `approve` | 设为 `off` 关闭危险命令审批（自担风险，仍会记审计事件） |
| `DSH_RC_DRYRUN` | `0` | 包装器 dry-run：只打印 ssh 命令不执行（测试用） |
| `DSH_RC_NO_CLEAR` | `0` | 设为 `1` 不自动清屏（排查时用） |
| `DSH_RC_SELFTEST` | `0` | 启动后跑一次内建自测并写 `selftest.log` |

## 兼容性与限制

- 插件包住的是 DSH 的终端服务（`ctx.subprocess.spawnTerminal`、`ctx.terminalController.shells|retain`、
  客户端 `ctx.webTerminals.launchShells`），这与社区插件的常用手法一致，但**不是文档化扩展点**；
  DSH 改动这些内部实现时需要同步适配（`package.json` 的 `engines.dsh` 声明了已验证范围）。
- 远端默认用 `bash -li` 启动以挂 `PROMPT_COMMAND` 钩子；远端没有 bash 时自动退回哨兵模式
  （窗口里会看到一行 `__dsh` 包装命令），功能不受影响、只是观感略差。
- 终端输出没有做全终端模拟：行内覆盖用「保留最后一个 `\r` 之后内容」的简化处理，
  极端 TUI 场景下 `remote_screen` 可能与真实画面有出入，命令结果以 `remote_run`/`remote_exec` 为准。

## 开发与测试

```bash
npm test          # 64 个测试：纯函数、危险命令/终止命令判定、菜单包装器、插件装载、命令通道模拟
```

测试不需要 `ssh`，也不需要真 PTY：`tests/link-peers.mjs` 会把全局安装的 DSH 里的 peer 包
软链进本目录（`node_modules/@deepseek-ai/{dsh-home-paths,dsh-tools}`），
`tests/console.test.mjs` 用一个假远端 shell 回放 OSC 帧来验证退出码、回显剥离和超时。

端到端验证（需要一台有 `ssh` 的机器）见 [docs/verify-e2e.md](docs/verify-e2e.md)。

## 数据目录

`${DSH_HOME:-~/.dsh}/remote-console/`

- `bin/`：按 `~/.ssh/config` 生成的主机启动器（`dsh-ssh-<host>`）
- `hosts.tsv`：手动新建过的主机（host/user/port）
- `sessions/`：`terminal ↔ socket` 的 rendezvous（进程退出即清）
- `socks/`：ControlMaster socket
- `logs/`：会话 JSONL（会话结束即删）
- `plugin.log`：插件诊断日志（不含凭据）

## 许可

MIT。见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
