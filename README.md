# dsh-remote-console

中文 | [English](https://github.com/cccodder/dsh-remote-console/blob/main/README.en.md)

![version](https://img.shields.io/github/v/release/cccodder/dsh-remote-console?label=version)
![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4D6BFE)
![license](https://img.shields.io/badge/license-MIT-green)

DeepSeek Harness（DSH）右侧栏的 SSH 远程终端：你和 AI agent 在**同一个 PTY** 里操作远端主机。
你亲自完成 SSH 登录，agent 通过同一个终端执行命令，双方的操作都写进同一条可回看的日志。

它不重新实现终端：渲染、输入、窗口管理全部复用 DSH 自带的终端，插件只做三件事——
往 shell 列表里加远端启动器、捕获这条 PTY 的字节流、给 agent 一组写进同一个终端的工具。

![右侧栏的 SSH 远程面板；示例主机名已打码](https://raw.githubusercontent.com/cccodder/dsh-remote-console/main/docs/images/ssh-panel.png)

![agent 在同一个远端终端里执行命令；示例主机名已打码](https://raw.githubusercontent.com/cccodder/dsh-remote-console/main/docs/images/ssh-agent-terminal.png)

## 它解决什么

普通的「agent 远程执行」通常是另开一条 ssh 通道，于是：

- 你看不到 agent 在远端敲了什么，也接不回它的会话；
- 密码、sudo、主机指纹这些必须由人完成的交互没有地方做；
- `cd`/`export` 这类 shell 状态在两次调用之间丢失。

这个插件把 agent 放进**你正在看的那个终端**：agent 的命令像人打字一样出现在窗口里，
退出码由 shell 自己的 `PROMPT_COMMAND` 钩子（OSC 序列）回报，而不是靠猜提示符。

## 安装

要求：DSH `>= 0.2.1-rc.2 <0.3.0-0`，本机有系统 `ssh` 客户端。
版本、平台与能力的完整矩阵（含未验证项、Windows 说明、pnpm 11 安装注意事项）见
[docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md)。

**npm 包名**：`dsh-remote-console`（https://www.npmjs.com/package/dsh-remote-console）。

**插件市场（推荐，能显示「有新版本」）**：插件市场索引（DSH plugin market format 1）：

```
https://cccodder.github.io/dsh-remote-console/market/index.json
```

> 这是 GitHub Pages 镜像，每次推送后自动更新（首次启用约需 1 分钟）。如果它不通，
> 可改用 jsDelivr `https://cdn.jsdelivr.net/gh/cccodder/dsh-remote-console@main/market/index.json`
> （分支缓存最长约 12 小时）或 GitHub 原链
> `https://raw.githubusercontent.com/cccodder/dsh-remote-console/main/market/index.json`；
> 也可以把仓库里的 `market/index.json` 放到你自己的静态服务器上（索引就是一份 JSON）。

1. 侧栏「发现」（需要启用实验性 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`）。
2. 「添加索引源」→ 粘贴上面的 URL。
3. 在列表里点安装；以后有新版本会显示「有新版本」，直接更新。

**CLI 管理的 profile**（例如 `web`）：

```bash
# 1. 装进 profile（--profile 换成你自己的 profile 名）
dsh plugin --profile web add dsh-remote-console

# 2. 把插件加进该 profile 的 bundle 列表
#    编辑 $DSH_HOME/profiles/web/package.json：
#      "dsh": { "profile": { "bundles": [ ..., "dsh-remote-console" ] } }

# 3. 确认插件层被组合进来（应看到 id: dsh-remote-console）
dsh --profile web --dump-config | grep -A2 dsh-remote-console
```

**Electron 桌面版**：`desktop` profile 由 App 独占管理，CLI 会直接拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。
请用 App 内置的**插件管理器**安装：包名填 `dsh-remote-console`（从 npm 装），
或粘贴 `github:cccodder/dsh-remote-console`（从 git 装最新提交）。
它会自动写入 profile 的 `dependencies` 与 `dsh.profile.bundles`。注意全局 `dsh` CLI
版本可能低于 App 自带的 DSH，以 App 内的版本为准。

不需要 Python、不需要改 `~/.ssh/config`、不改 shell rc。安装或使用中报错，先看下面的
[故障排查](#故障排查)。

## 用法

1. 右侧栏 →「SSH 远程」卡片 → 选中一个远端（来自 `~/.ssh/config` 的 Host，或手动新建）。
2. 终端里执行 `ssh -M -S <sock> -t <host>`，密码/口令由 `ssh` 自己提示，**插件不接触**。
3. 登录成功后 agent 可用这些工具：

| 工具 | 作用 |
| --- | --- |
| `remote_status` | 终端、主机、socket、状态、最后几行屏幕 |
| `remote_run(command)` | 写进同一个 PTY（窗口里可见），返回输出 + 真实退出码（PTY 会把 stderr 并进输出） |
| `remote_exec(command, cwd?)` | 复用 ControlMaster socket 的带外执行：原生 stdout/stderr/退出码，不污染终端窗口 |
| `remote_upload(local_path, remote_path, overwrite?)` | 本地 → 远端：流式传输并双向校验 sha256，默认不覆盖，单文件上限 256 MB |
| `remote_download(remote_path, local_path, overwrite?)` | 远端 → 本地：流式传输并校验 sha256，默认不覆盖本地文件，上限 256 MB |
| `remote_read_file(path, max_bytes?)` | 读远端文本（默认 128 KB、上限 256 KB）；二进制文件拒绝显示，提示改用 `remote_download` |
| `remote_write_file(path, content, append?)` | 写 ≤256 KB 的 UTF-8 文本；内容走 stdin，不进终端窗口 |
| `remote_forward(action, remote_port?, ...)` | `start`/`stop`/`list` 管理端口转发：`ssh -N -L 127.0.0.1:...`，只绑回环 |
| `remote_screen(lines)` | 当前屏幕纯文本（剥 ANSI） |
| `remote_log(cursor)` | 统一 JSONL 日志的增量读：人敲的命令、agent 的命令、两边输出 |
| `remote_audit_read(cursor?, tool?)` | 读**跨会话保留**的审计日志：agent 执行过的命令/退出码、审批、传输、转发、连接起止（不含屏幕内容） |
| `remote_audit_export(local_path, format?)` | 把审计日志导出成本地 `jsonl` / `csv`（0600），用于归档或核对 |
| `remote_close()` | 断开 ssh master 并清理 socket/rendezvous 文件、停止该终端的转发 |

`remote_run` 适合：要你看着执行、需要 TTY（sudo/vim/嵌套 ssh）、需要在两次调用间保留 shell 状态。
`remote_exec` 适合：纯数据收集、脚本、必须用退出码判断成败的事。

**文件与转发都复用同一个已认证连接**：`remote_upload` / `remote_download` /
`remote_read_file` / `remote_write_file` / `remote_forward` 走终端的 ControlMaster socket，
不弹密码、不重新认证，但**必须先有一个活着的 SSH 终端**；终端一结束它们立即失败
（`BatchMode=yes`，fail closed）。`remote_upload` / `remote_write_file` 写 `~/.ssh`、`/etc`、
sudoers、shell profile 这类敏感路径时会先要你审批一次。能力/平台的完整矩阵见
[docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md)。

**注意 `exit` 的语义**：面板里的主机启动器和「新建会话」都是一次性的——远端 shell 退出
（命令里带 `exit`、`logout`，或 ssh 断开）后，整个终端就结束了，所有 `remote_*` 工具失效，
需要人工重新打开终端并重新输密码。插件会拦下这类命令要一次审批，并在终端里明确提示
「这个终端已经结束」，不会假装还能继续用。

## 管理主机列表

面板里的远端来自三处：`~/.ssh/config`、插件设置页的 `config.hosts`、以及 `hosts.tsv`
（由 agent 工具写入）。两种维护方式：

**方式一：设置页（推荐）**

1. 侧栏打开「插件」（拼图图标）→ 在已安装插件里点开 `dsh-remote-console` 卡片。
2. 详情页里就有「主机列表」配置区；也可以往下找到「部件」里 `dsh-remote-console` 那一行的
   **配置**按钮，进的是同一个页面。
3. 每行一个远端：`~/.ssh/config` 里的别名，或直接写 `user@host[:port]`；`#` 开头是注释。例如：

   ```
   nas
   ops@10.0.0.5:22
   ```

4. 点「保存」。宿主侧会重新生成侧栏「SSH 远程」里的启动器：别名走 ssh 配置，
   `user@host:port` 直接进 ssh 并跳过菜单。

> 只在插件包详情页出现、或者在行里出现「配置」按钮，说明这个部署提供了 DSH 的设置服务
> （`ctx.configForms`）。如果两处都没有，用下面的方式二——终端功能不受影响。

**方式二：让 agent 添加（不需要设置页）**

直接说「把 ops@10.0.0.5:22 加到 SSH 列表」即可，agent 会调用这几个工具：

| 工具 | 作用 |
| --- | --- |
| `remote_host_add(spec)` | 加到 `hosts.tsv`（插件数据目录，0600），面板刷新后出现；重复添加是更新 |
| `remote_host_list()` | 列出面板里的主机以及各自来源（ssh 配置 / 设置页 / hosts.tsv） |
| `remote_host_remove(spec)` | 从 `hosts.tsv` 里删掉（不动 ssh 配置、密钥和远端数据） |

两个方式存的不是同一个地方：设置页写 profile patch 里的 `config.hosts`，工具写
`~/.dsh/remote-console/hosts.tsv`；面板会把两边合并显示。

## 更新

**怎么知道有新版本**：面板底部左侧是「密码只在终端里输入…」，右侧显示当前版本
（如 `v0.6.5`）。客户端会查一次 GitHub 最新 Release（结果缓存 6 小时，离线/限流/CORS
失败都静默），发现更高版本时在同一位置显示「有新版本 vX.Y.Z」，点开是 GitHub Release 页。

**方式一：插件市场（有真正的「更新」入口）**

插件已发布到 npm，并提供 format 1 的市场索引：

```
https://cccodder.github.io/dsh-remote-console/market/index.json
```

在侧栏「发现」→「添加索引源」里加上这个 URL 后，发现页会列出本插件；索引里的版本比
已安装的新时显示「有新版本」，点一下就走 DSH 的安装/更新流程（安装源是 npm 的
`dsh-remote-console@<version>`）。安装位置不会变，数据目录也不受影响。

> 索引源只接受 JSON 的 URL。GitHub Pages 不通时换 jsDelivr 或 raw 原链，或把
> `market/index.json` 放到你自己的静态服务器上——内容一样，DSH 不关心它托管在哪。

**方式二：手动重装（没有启用插件市场时）**

1. 侧栏「插件」→「已安装插件」→ `dsh-remote-console` → **卸载**（会二次确认）。
2. 「添加插件」→ 输入 `dsh-remote-console`（npm）或 `github:cccodder/dsh-remote-console`
   （git 最新提交）→ 安装 → 「立即启用」。
3. 重启一次 DSH 桌面 App。插件在热更新后会重新 `apply()`，虽然已经做了幂等保护，
   但重启最干净（0.6.0/0.6.1 升级上来的旧包装必须靠重启清掉）。

主机列表、`hosts.tsv` 这些数据在 `~/.dsh/remote-console/`，不在插件包里，卸载重装不会丢。

**关于一键更新**：DSH 插件管理器只给官方按需插件提供「更新」按钮；第三方插件想要同样的
体验，就得通过插件市场索引（本仓库的 `market/index.json`）或发布到 npm 让方负责分发。
索引不更新、点了更新版本没变的排查步骤见[故障排查](#故障排查)第 6 条。

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
- **传输有校验、转发只绑回环**：`remote_upload` / `remote_download` 流式传输并在两端各算一次
  sha256（远端没有 `sha256sum` / `shasum` 时结果会标成 `verified: unavailable`）；默认拒绝覆盖
  已有文件，要显式 `overwrite: true`。`remote_forward` 只监听 `127.0.0.1`，局域网其他机器连不上，
  终端结束或 `remote_close` 时自动停。写 `~/.ssh`、`/etc`、sudoers、shell profile 这类敏感路径
  前会先要你审批一次。
- **会话日志会消失，审计不会**：PTY 结束即删除含屏幕输出的会话日志（保留内存事件供当场回看）；
  审计日志单独一条线，只记 agent 的动作、跨会话保留，命令文本沿用同一套脱敏规则，可用
  `DSH_RC_AUDIT=off` 关闭、用 `remote_audit_read` / `remote_audit_export` 读取或导出；DSH 崩溃留下的
  残留日志会在下次插件启动时清扫。日志写入前会对 Bearer token、`sk-*`、
  `password=/token:/secret=` 一类赋值做脱敏，但**命令参数里的明文密钥仍可能出现在会话期间**，
  敏感操作请用环境变量或 `ssh-agent`。
- **关窗即失能**：关终端标签立即杀进程树；关浏览器在最后一个窗口持有消失 8 秒后杀
  （刷新会重连并取消）；DSH 崩溃时 PTY master 消失，`ssh` 随 HUP 退出。

> 威胁模型：插件保护的是「凭据不被 agent/日志带走」和「破坏性操作需你点头」，
> 它不能防御你已经授权的 agent 在远端做任何事。远端命令本身就是你给 agent 的能力。
>
> 发现安全问题请走私密渠道，见 [SECURITY.md](https://github.com/cccodder/dsh-remote-console/blob/main/SECURITY.md)。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_REMOTE_CONSOLE_DIR` | `$DSH_HOME/remote-console` | 数据目录（logs/sessions/socks/bin） |
| `DSH_SSH_CONFIG` | `~/.ssh/config` | 主机别名来源 |
| `DSH_RC_DANGER_GUARD` | `approve` | 设为 `off` 关闭危险命令审批（自担风险，仍会记审计事件） |
| `DSH_RC_AUDIT` | `on` | 设为 `off` 停止写审计日志（读取/导出已有内容不受影响） |
| `DSH_RC_DRYRUN` | `0` | 包装器 dry-run：只打印 ssh 命令不执行（测试用） |
| `DSH_RC_NO_CLEAR` | `0` | 设为 `1` 不自动清屏（排查时用） |
| `DSH_RC_SELFTEST` | `0` | 启动后跑一次内建自测并写 `selftest.log` |

## 故障排查

先按「找不到日志」一节确认日志位置，再对号入座。版本/平台层面的差异（DSH 0.3.0、Windows、
pnpm 11）见 [docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md)；认证、审批、日志留存的设计见[安全模型](#安全模型)。

### 1. 终端报 `ssh: command not found`

**症状**：终端第一行就是 `bash: ssh: command not found`；点选主机后终端立刻结束，显示
「── ssh 已退出（退出码 127）──」。

**原因**：插件不捆绑 `ssh`，用的是系统 OpenSSH 客户端，本机 `PATH` 里没有。

**处理**：

```bash
command -v ssh && ssh -V
# Debian/Ubuntu
sudo apt-get install -y openssh-client
# Fedora/RHEL
sudo dnf install -y openssh-clients
# macOS 系统自带 /usr/bin/ssh，一般不需要安装
```

Windows 目前不支持，见 [docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md#平台)。

### 2. `Bad owner or permissions on ...`

**症状**：面板能打开，但终端里的 `ssh` 立刻退出，提示
`Bad owner or permissions on /etc/ssh/ssh_config`（或 `~/.ssh/config`）。

**原因**：`ssh` 拒绝属主/权限不对的配置文件：系统配置必须 root 拥有、组和其他用户不可写；
用户配置必须本人拥有、只有本人可写（`~/.ssh` 目录也不能被其他人写）。

**处理**：

```bash
ssh -G localhost >/dev/null        # 先复现：能过就没有这个问题
ls -l ~/.ssh/config ~/.ssh
chmod 700 ~/.ssh
chmod 600 ~/.ssh/config
chown "$(id -un)" ~/.ssh/config
# 系统配置被镜像/容器改坏时
sudo chown root:root /etc/ssh/ssh_config
sudo chmod 644 /etc/ssh/ssh_config
```

插件的兜底：`ssh -G localhost` 报 Bad owner 时，会自动换成 `-F ~/.ssh/config`（或 `-F /dev/null`），
并在 `wrapper.log` 里记一行 `ssh config fallback`。也可以显式指定配置文件后重启 DSH：
`DSH_SSH_CONFIG=~/.ssh/config`。

### 3. 密码 / 主机指纹认证卡住，agent 写入被拒

**症状**：终端停在 `password:`、`(yes/no)?` 或 `Enter passphrase`；agent 的工具返回
`AUTH_REQUIRED`；`remote_exec` / 文件传输报 `SSH_CLIENT_FAILED`。

**原因**：认证必须由你本人在终端里完成。插件不接触密码，认证期会拒绝 agent 的写入；
`remote_exec` 和文件传输走 `BatchMode=yes`，不会替你弹密码。

**处理**：在终端窗口里输入密码 / `yes` / 口令，然后重新调用工具。卡住时 `Ctrl+C` 回到菜单或 shell
再试。不想每次输口令就用 `ssh-agent` + `ssh-add`（插件不读你的私钥，只复用终端里那次登录）。
确认 ssh 在等什么：看终端最后一行，或调 `remote_status` 看屏幕内容。

### 4. Control socket 不可用

**症状**：`remote_status` 还能看到 host，但 `remote_exec`、文件传输、`remote_forward` 报
`SSH_CLIENT_FAILED` / `NO_LIVE_CONSOLE`，或 ssh 输出 `Control socket ... has terminated`；
`~/.dsh/remote-console/socks/` 里没有 socket，或 socket 已经是死文件。

**原因**：ControlMaster 由终端里的 `ssh -M -S` 维持，ssh 退出、网络中断、关标签后 socket 就失效。
插件不会重建 master，也不会拿密码去重连；DSH 重启会清掉旧 socket。

**处理**：

```bash
ls -l ~/.dsh/remote-console/socks/      # 当前 socket
ps aux | grep "[s]sh -M -S"             # master 是否还活着
# 收掉残留的 master（<sock> 换成上面看到的路径，<host> 换成对应主机）
ssh -S ~/.dsh/remote-console/socks/<sock> -O exit <host>
```

然后在右侧栏关掉旧标签、重新打开 SSH 终端并登录。如果 socket 路径过长（Unix socket 路径上限
约 108 字节）导致 bind 失败，把数据目录挪到短路径后重启 DSH：
`DSH_REMOTE_CONSOLE_DIR=/tmp/rc`（把原目录的 `hosts.tsv` 复制过去可保留手动添加的主机）。

### 5. 终端结束后工具报 `CONSOLE_CLOSED` / `NO_LIVE_CONSOLE`

**症状**：agent 的 `remote_run` 报 `CONSOLE_CLOSED: 终端已结束...` 或 `NO_LIVE_CONSOLE`；
终端里显示「── ssh 已退出（退出码 N）── / 这个终端已经结束」。

**原因**：面板里的启动器是一次性的。远端 shell 退出（`exit` / `logout`）、ssh 断开、网络中断、
你关掉标签，都会结束 console，所有 `remote_*` 工具随之失效；插件不会偷偷重连。

**处理**：在右侧栏重新打开 SSH 终端并重新登录。纯数据收集用 `remote_exec`（`sh -c` 子进程，
不会结束终端）；`remote_run` 里的 `exit` / `logout` / `pkill ssh` 会先弹审批，就是提醒这一点。
检查本地是否还有残留：`ps aux | grep "[s]sh -M"`。

### 6. 插件市场索引不更新

**症状**：发现页里没有新版本 / 没有「有新版本」/ 点了更新版本号没变；打开索引 URL 看到的是旧内容。

**原因**：GitHub Pages 首次构建约需 1 分钟；jsDelivr 的分支缓存最长约 12 小时；客户端「有新版本」
提示缓存 6 小时；DSH 只对官方按需插件原生提供「更新」，第三方插件靠市场索引或卸载重装，
热更新偶尔不彻底。

**处理**：

```bash
# 1. 确认索引里有没有新版本（把 0.7.0 换成你等的版本）
curl -fsSL https://cccodder.github.io/dsh-remote-console/market/index.json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.plugins?.[0]?.versions?.slice(0,5).map(v=>v.version).join(" "))})'
# 2. 换镜像源再试（缓存策略不同）
curl -fsSL https://cdn.jsdelivr.net/gh/cccodder/dsh-remote-console@main/market/index.json >/dev/null \
  && echo jsdelivr-ok
```

索引里已有新版本但界面不动，就走重装：侧栏「插件」→ 已安装 → **卸载** → 添加插件 →
`dsh-remote-console` → 安装 → 启用 → 完整重启 DSH。主机列表和 `hosts.tsv` 在
`~/.dsh/remote-console/`，卸载重装不会丢。

### 7. 找不到日志 / 开内建自测

**症状**：要贴 issue 或自己排查，不知道看哪里；会话结束后日志「消失」了。

**原因**：诊断日志在数据目录（默认 `${DSH_HOME:-~/.dsh}/remote-console/`），会话 JSONL 默认不保留
（PTY 结束即删），所以要在问题发生的当下抓。

**处理**：

```bash
ls -la ~/.dsh/remote-console/
tail -n 100 ~/.dsh/remote-console/plugin.log    # 启动、framing、审批、工具注册
cat ~/.dsh/remote-console/wrapper.log           # 包装器（如 ssh 配置回退）；没有输出=没触发
ls -la ~/.dsh/remote-console/logs/              # 会话 JSONL：只在会话进行时存在
```

复现前先把 `plugin.log` 和 `logs/` 留存。开内建自测跑一次 PTY 链路（结果写
`selftest.log`，启动约 2 秒后执行）：

```bash
# CLI / 旁路实例
DSH_RC_SELFTEST=1 dsh verify --no-open --port 3999
# 桌面 App：把变量放进 App 的启动环境后完整重启（macOS 示例）
launchctl setenv DSH_RC_SELFTEST 1
# 验证完记得取消：launchctl unsetenv DSH_RC_SELFTEST
cat ~/.dsh/remote-console/selftest.log
```

贴 issue 时附上 `plugin.log`、`selftest.log` 和相关 `logs/` 片段，并去掉主机名、用户名和 token。

## 兼容性与限制

完整的版本 × 平台 × 能力矩阵（含未验证项与安装注意事项）见 [docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md)。

- 插件包住的是 DSH 的终端服务（`ctx.subprocess.spawnTerminal`、`ctx.terminalController.shells|retain`、
  客户端 `ctx.webTerminals.launchShells`），这与社区插件的常用手法一致，但**不是文档化扩展点**；
  DSH 改动这些内部实现时需要同步适配（`package.json` 的 `engines.dsh` 声明了已验证范围
  `>=0.2.1-rc.2 <0.3.0-0`，DSH 0.3.0 未验证）。
- 平台：macOS、Linux 完整支持；**Windows 已支持（实验性）**——终端照常可用，工具在没有
  ControlMaster 时自动退回 PTY 通道（详见下面的「Windows（实验性）」与
  [docs/compat.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/compat.md#平台)）。
- 远端默认用 `bash -li` 启动以挂 `PROMPT_COMMAND` 钩子；远端没有 bash 时自动退回哨兵模式
  （窗口里会看到一行 `__dsh` 包装命令），功能不受影响、只是观感略差。
- 终端输出没有做全终端模拟：行内覆盖用「保留最后一个 `\r` 之后内容」的简化处理，
  极端 TUI 场景下 `remote_screen` 可能与真实画面有出入，命令结果以 `remote_run`/`remote_exec` 为准。

## Windows（实验性）

Windows 走的是另一条连接路径：Windows 版 OpenSSH **不支持 ControlMaster**，拿不到可复用的
socket，所以插件用 Node 版包装器（`bin/dsh-ssh.mjs`）起终端，agent 工具在没有 socket 时
自动退回 PTY 通道。

- 终端：和 macOS/Linux 一样可用（密码/口令仍由 `ssh` 自己提示，插件不接触）。
- 工具：`remote_run`、`remote_exec`、`remote_read_file`、`remote_write_file`、
  `remote_upload`、`remote_download` 都可用，但部分行为有差异——命令与数据会出现在用户
  窗口里，`remote_exec` 的 stdout/stderr 合并；传输单文件上限 **1 MiB**（base64 分块走终端）。
- 不可用：`remote_forward`（端口转发需要一条已认证的可复用连接）；`remote_audit_*` 不受影响。
- 启动器是 `node dsh-ssh.mjs --host/--target ...`，需要 DSH 自带的那份 Node（插件用
  `process.execPath`，不需要系统额外装 Node）。
- 实验性：本机没有 Windows 环境，逻辑用 Linux 上的等价路径验证过（Node 包装器、PTY 分块
  读写、通道选择、工具自动回退）；真实 Windows conpty 的窗口观感与长行限制还需要真机确认。

## 性能基线（loopback）

`scripts/bench.mjs` 只量 SSH 通道本身的开销（不经过 DSH、不经过插件）：起一个 127.0.0.1 上的
临时 sshd，用 ControlMaster socket 量「建立 master」「复用 master 的 exec 往返」「1 MiB 上传/下载」。
本机实测（2026-10-28，Linux x64 6 vCPU，OpenSSH 9.2p1，`node scripts/bench.mjs --runs 60`）：

| 指标 | 实测值 |
| --- | --- |
| 建立 master（连接 + 公钥认证 + socket 就绪） | 约 185–197 ms（5 次中位数；有负载时最高约 216 ms） |
| exec 往返，复用 master（p50 / p95） | 约 12 ms / 13 ms（60 次采样；有负载时 p95 约 19 ms） |
| 1 MiB 上传 | 约 35–49 MiB/s（21–29 ms） |
| 1 MiB 下载 | 约 21–25 MiB/s（43–47 ms） |

同一台机器多次运行也会有约 ±30% 的抖动（容器里同时跑着别的任务），所以给区间而不是单点。
这是 **loopback 基线**：同一台机器、没有真实网络 RTT，不能直接外推到真实主机。用户能感知的主要是
两条：新建终端 ≈ 一次 SSH 登录（约 0.2 秒的握手，不含你输密码的时间）；之后 `remote_exec`、
文件传输、端口转发都复用同一个 master，每条命令 ≈ 一次本地进程创建 + 一个网络 RTT。真实网络的
耗时由 RTT、带宽、加密套件和远端负载决定。

复现（需要本机有 `ssh` 和 `sshd`；找不到时脚本会打印各平台准备命令；`scripts/` 不随 npm 包发布，
请在仓库根目录跑）：

```bash
node scripts/bench.mjs                 # 人类可读表格
node scripts/bench.mjs --runs 60 --json
```

## 开发与测试

```bash
npm test      # 单元测试 + 发版元数据检查（有 ssh/sshd 时还跑真实 sshd 集成测试）
npm run verify  # 只查版本号、客户端 VERSION、CHANGELOG、市场索引是否一致
```

单元测试不需要 `ssh`，也不需要真 PTY：`tests/link-peers.mjs` 会把全局安装的 DSH 里的 peer 包
软链进本目录（CI 里改用 `npm install --no-save` 装同样的包），
`tests/console.test.mjs` 用一个假远端 shell 回放 OSC 帧来验证退出码、回显剥离和超时。
`tests/integration-sshd.test.mjs` 会起一个真实的临时 sshd 验证登录、socket 复用、1 MiB 双向
传输、端口转发和退出码；机器上找不到 `ssh`/`sshd` 时整组跳过，所以 `npm test` 在两种机器上都能过。

- 开发规则与分支模型：[CONTRIBUTING.md](https://github.com/cccodder/dsh-remote-console/blob/main/CONTRIBUTING.md)（中文：[CONTRIBUTING.zh.md](https://github.com/cccodder/dsh-remote-console/blob/main/CONTRIBUTING.zh.md)）
- AI 协作规则：[AGENTS.md](https://github.com/cccodder/dsh-remote-console/blob/main/AGENTS.md)
- 端到端验证（需要一台有 `ssh` 的机器）：[docs/verify-e2e.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/verify-e2e.md)
- 发版前真机清单：[docs/dev/release-checklist.md](https://github.com/cccodder/dsh-remote-console/blob/main/docs/dev/release-checklist.md)
- 发版流程：release PR 里改版本 + CHANGELOG + `npm run market:index`，合并后在 `main` 发布
  `vX.Y.Z` Release；workflow 校验 tag、跑测试、带 provenance 发 npm 并把 `.tgz` 挂到 Release。

## 数据目录

`${DSH_HOME:-~/.dsh}/remote-console/`

- `bin/`：按 `~/.ssh/config` 生成的主机启动器（`dsh-ssh-<host>`）
- `hosts.tsv`：手动新建过的主机（host/user/port）
- `sessions/`：`terminal ↔ socket` 的 rendezvous（进程退出即清）
- `socks/`：ControlMaster socket
- `logs/`：会话 JSONL（含屏幕输出，会话结束即删）
- `audit/audit.jsonl`：**跨会话保留**的审计日志——只记 agent 的动作：命令文本（已脱敏）、退出码、
  审批结果、传输路径与 sha256、端口转发、连接起止；不含屏幕输出，也不含你手敲的内容。
  8 MB 滚动、最多保留 5 份、文件权限 0600，`DSH_RC_AUDIT=off` 可停止写入。
  用 `remote_audit_read` 读、`remote_audit_export` 导出。
- `plugin.log`：插件诊断日志（不含凭据）
- `wrapper.log`：包装器诊断日志（如 ssh 配置回退；只在触发时写入）
- `selftest.log`：`DSH_RC_SELFTEST=1` 时的内建自测结果

## 许可

MIT。见 [LICENSE](https://github.com/cccodder/dsh-remote-console/blob/main/LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
