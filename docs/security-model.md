# 安全模型与权限

面向使用者与审查者的完整说明。 Threat model 一句话：**插件保护的是「凭据不被 agent/日志带走」和「破坏性操作需你点头」，它不能防御你已经授权的 agent 在远端做任何事**——远端命令本身就是你给 agent 的能力。

发现安全问题请走私密渠道，见 [SECURITY.md](../SECURITY.md)。

## 凭据不经过插件

- 密码只在 `ssh` 自己的提示符里输入；插件不读取、不保存、不重放。
- `hosts.tsv` 只记 host / user / port（0600），数据目录 0700；仓库里不含任何密钥。
- 审计与日志脱敏，不含终端屏幕内容；`DSH_RC_AUDIT=off` 可关闭审计。

## 终端按会话隔离

工具只认调用方会话自己打开的终端——归属来自 spawn 时的 `DSH_SESSION_ID`，
调用方来自 `exec.agent.id`；不匹配时 `remote_*` 直接报 `CONSOLE_FORBIDDEN`，
`remote_status` 也只列本会话的终端。同一宿主进程里多个会话并存时，读别人屏幕、
在别人终端里执行、传文件都会被拒。审计记录同时记 `pid` 与 `session`，
事后可以从终端追到会话。子代理 / 子会话有独立 SessionId，刻意不继承父会话的终端。

## 认证期拒写

屏幕停在 `password:`、`(yes/no)?`、`Permission denied` 等状态时，agent 的任何写入都会被拒绝
（`AUTH_REQUIRED`），避免它替你回答认证问题。请亲自在终端里完成认证。

## 危险命令审批

`remote_run` / `remote_exec` 绕过 DSH 沙箱（它们只是在用户已登录的会话里敲字 / 复用 socket），
所以插件额外加了一道闸门：

- 命中 `rm -rf`、`mkfs`、`dd of=/dev/*`、`shutdown/reboot`、fork bomb、`curl | sh`、
  `git push --force`、`DROP TABLE` 等模式时，通过 DSH 的 `ctx.approval` 弹一次审批卡片；
- **一次授权只对本次命令有效**；没有审批服务（headless / 未挂载 answerer）时直接拒绝执行（fail closed）；
- `remote_run` 里会结束整个终端的 `exit` / `logout` / `pkill ssh` 同样需要审批；
- 命中项按 `destructive`（数据会被删除）/ `irreversible`（回滚成本高）/ `session`（影响主机或会话）
  三级分类，审批文案直接说明后果（例如「递归强制删除（数据会被删除，无法恢复）」），
  审计记录带 `risk` 字段。分级只改解释，不新增拦截规则、不改变拦截时机。
- `DSH_RC_DANGER_GUARD=off` 可显式关闭（自担风险，仍会记审计事件）。

## 传输有校验、转发只绑回环

- `remote_upload` / `remote_download` 流式传输并在两端各算一次 sha256
  （远端没有 `sha256sum` / `shasum` 时结果标成 `verified: unavailable`）；默认拒绝覆盖，
  要显式 `overwrite: true`。
- 单文件上限默认 256 MB，设置页可调 1–2048 MB（`DSH_RC_MAX_TRANSFER_MB` 环境变量同效），
  超限直接拒绝并提示去哪改。无 ControlMaster 的平台退回 PTY 通道，硬上限 1 MiB。
- `remote_forward` 只监听 `127.0.0.1`，局域网其他机器连不上；终端结束或 `remote_close` 时自动停。
  支持三向：`kind=L` 本地端口转远端、`kind=D` 本地 SOCKS5、`kind=R` 远端端口转本地。
- 写 `~/.ssh`、`/etc`、sudoers、shell profile 这类敏感路径前会先要一次审批。
  面板的文件写路由额外要求 POST + 同源 + 随机令牌（只经同源 `state.json` 下发）+
  `application/octet-stream`，敏感路径直接 403——HTTP 路由没有审批服务，改配置请用 `remote_upload`。

## 会话日志会消失，审计不会

- PTY 结束即删除含屏幕输出的会话日志（保留内存事件供当场回看）。
- 审计单独一条线，只记 agent 的动作、跨会话保留；命令文本沿用同一套脱敏规则。
- 写审计前会对 Bearer token、`sk-*`、`password=` / `token:` / `secret=` 一类赋值脱敏，
  但**命令参数里的明文密钥仍可能出现在会话期间**——敏感操作请用环境变量或 `ssh-agent`。
- 8 MB 滚动保留 5 份；`DSH_RC_AUDIT=off` 可关闭；`remote_audit_read` / `remote_audit_export`
  读取或导出。DSH 崩溃留下的残留日志会在下次插件启动时清扫。
- `remote_audit_timeline` 把审计按会话聚合成时间线（窗口、命令数/失败数、传输、转发、审批、
  最近一条命令）；**不还原屏幕内容，也不包含用户手敲的文本**。

## 关窗即失能

关终端标签立即杀进程树；关浏览器在最后一个窗口持有消失 8 秒后杀（刷新会重连并取消）；
DSH 崩溃时 PTY master 消失，`ssh` 随 HUP 退出（Windows 上 conpty 子进程同样被终止）。

## 权限与外部依赖

把暴露面一次说清（市场 / 安全扫描也会读这一节）：

| 能力 | 具体行为 | 边界 |
| --- | --- | --- |
| 网络 | 只通过用户已认证的 `ssh` 连接（ControlMaster socket 或终端里的 `ssh` 进程），**不建立第二条连接**。更新检查只在打开配置页时访问 GitHub API 与 DSH/pnpm 配置的 npm registry，缓存 10 分钟，失败静默 | 离线时终端功能不受影响；socket 消失后所有带外调用 fail-closed |
| 命令 | agent 通过 `remote_run` / `remote_exec` 在远端执行 shell 命令 | 危险模式要一次审批；没有审批服务时拒绝 |
| 文件 | `remote_upload` / `remote_download` 读本地文件、写远端文件；`remote_read_file` / `remote_write_file` 读写远端文本 | 默认不覆盖、双向 sha256；敏感路径审批；路径不允许 `..` |
| 凭据 | SSH 密码只输入到 `ssh` 自己的提示符；插件不读取、不保存、不重放；`hosts.tsv` 只记 host/user/port（0600） | 审计与日志脱敏，不含终端屏幕内容；`DSH_RC_AUDIT=off` 可关闭审计 |
| 本地文件 | 数据目录 `~/.dsh/remote-console/`（启动器、会话日志、审计、`hosts.tsv`，文件 0600 / 目录 0700）；设置页保存通过 DSH 配置编辑器写 profile patch（`config.hosts` / `config.maxTransferMB`） | 会话日志在终端结束时删除；审计单独保留、可关闭 |
| 外部服务 | 无第三方服务，不发送遥测 | — |
| 生命周期脚本 | 包内没有 `preinstall` / `install` / `postinstall` / `prepare`；运行时 0 依赖，只有 DSH 的 peerDependencies | 安装时不会执行任何包脚本 |

**可执行产物**：包内的 `bin/dsh-ssh` 是菜单 / 启动器脚本（POSIX sh），只在用户点击主机、
DSH 打开终端时被执行为 `ssh` 启动器；不监听端口、不常驻、不接受网络输入。

**失败边界**：终端结束后所有 `remote_*` 工具立即失败，不会偷偷重连；没有 ControlMaster 的平台
（Windows OpenSSH）退回 PTY：命令与数据在窗口可见、单文件 ≤1 MiB、无端口转发，
面板文件区为空。

**验收**：`npm test`（含真实 sshd 的 CI）；发布走 GitHub Actions + npm provenance；
隔离 profile 的安装 / 启动验证见 [verify-e2e.md](verify-e2e.md)。
