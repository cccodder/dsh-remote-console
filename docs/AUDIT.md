# 代码审计（0.6.0）

> 0.6.1 追加：按实机测试报告修了三个 bug（macOS `date -Is`、`exit` 后提示语误导、
> `PWD=` 被误脱敏），并把 `exit`/`logout`/`pkill ssh` 纳入审批、`remote_run` 输出字段
> 改名。明细见 [CHANGELOG.md](../CHANGELOG.md)。

审计对象：`dsh-remote-console` 0.5.8（用户交付的 Repomix 快照），基线 DSH `0.2.1-rc.2`。
方法：逐行阅读 + 对照本机 DSH 安装目录里的服务实现核对 API + 隔离 profile 实际装载 + 新增测试复现关键路径。

## 结论

可以发布。宿主侧在真实 DSH `0.2.1-rc.2` 里装载成功（`apply → spawnTerminal/shells/retain wrapped → tools registered`），
客户端 bundle 被 DSH 正确解析、进入启动图并作为 combo 资源下发。
下面 8 项问题已修，另有 6 项是明确记录的设计限制而不是待办。

## 已修

| # | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | 高 | `remote_run`/`remote_exec` 完全绕过 DSH 沙箱，agent 可在远端执行任意命令而没有任何审批 | 新增危险命令闸门：11 类高危模式命中时经 `ctx.approval.request()` 弹一次审批卡片，一次授权只对本次命令有效；无审批服务时 fail closed；`DSH_RC_DANGER_GUARD=off` 可显式关闭并留审计事件 |
| 2 | 中 | `run()` 用 `dEvents` 数组下标定位命令结束事件；事件超过 200 条被裁剪后下标错位，可能拿到 `undefined` 抛错 | D 事件加单调序号 `seq`，按序号匹配（`lib/index.js` `run`/`feed`） |
| 3 | 中 | DSH 崩溃/被 kill 时会话日志不会走 `deleteLog()`，PTY 输出（含用户敲过的命令）残留在磁盘 | 启动清扫扩展到 `logs/`：新进程启动时删除所有历史 `*.jsonl*`（此时不可能有活跃会话） |
| 4 | 中 | `~/.ssh/config` 里删掉的主机，旧启动器永久留在「新建终端」下拉里 | `ensureHostLaunchers` 每次发现主机后清理不在当前列表的 `dsh-ssh-*` 启动器 |
| 5 | 低 | 自动初始化失败后每次出现提示符都会再次 `stty -echo` 注入，可能反复清屏 | `autoInitAttempts` 上限 3 次 |
| 6 | 低 | `client.js` 的 `inject` 声明了 `shortcuts` 服务，实际未使用；`dsh.client.inject` 与内置终端插件不一致 | 去掉未使用的 `shortcuts`；`dsh.client.inject` 保持终端的两个必需包（与内置 `sidebar-terminal` 对齐核对过） |
| 7 | 低 | `package.json` 缺 `engines`、`scripts.test`、`LICENSE`、`.gitignore`；peer 范围有重复段；`bin/dsh-ssh` 在 Repomix 里丢了可执行位 | 补齐并清理；`bin/dsh-ssh` 恢复 0755 |
| 8 | 低 | 无测试、无验证文档；README 引用未随包发布的 `remote_console_design.md` | 新增 61 个测试（纯函数/危险命令/菜单包装器/插件装载/命令通道模拟）、`docs/verify-e2e.md`、README 重写 |

## 核对过、不需要改的假设

对照 `/usr/local/lib/node_modules/@deepseek-ai/dsh/` 里的实现确认：

- `ctx.subprocess.spawnTerminal(spec)` 返回 `{pid, output, write, terminate, done}`，`output` 是可 pipe 的 PassThrough —— 包装方式成立。
- `ctx.terminalController.shells(agent, signal)` / `list(sessionId)` / `retain(sessionId, id, signal)` 存在；
  `shells` 是远端可发现 shell 的唯一入口，`create()` 会用 `shellPath` 在 `shells()` 里校验，
  所以注入条目只能加在 `shells()`、不能从源头删。
- 终端 spawn 时 `env: { DSH_SESSION_ID: agent.id }`，且 owner map 以 `agent.id` 为键 ——
  插件用 `spec.env.DSH_SESSION_ID` 绑定 `terminalId ↔ pid` 是正确的。
- `Remote` 装饰器只加标记、不改方法描述符 —— 实例上覆盖 `controller.shells/retain` 能被远端调用命中。
- 客户端：`ctx.slots.inject/register`、`ctx.sidebarRightTabs.register({id, kind, title, guide})`、
  `ctx.sidebarRight.openTab(kind, {params})`、`ctx.webTerminals.launchShells/selectShell` 均存在；
  `useTabInfo` 是 slot 注入的标准 hook prop（内置 `TerminalGuide` 同款用法），不是遗漏的 import。
- `defineTool` 的 `parameters` / `output.schema` 形态与内置 `bash` 工具一致，隔离 profile 里注册通过。

## 设计限制（记录，不修）

1. **包装的是服务而不是公开扩展点**。`engines.dsh` 只声明已验证范围；DSH 改内部实现需要同步适配。
2. **Windows 不支持**：`bin/dsh-ssh` 是 bash 脚本，且依赖系统 `ssh`（Windows 需要 OpenSSH 客户端 + WSL/Git Bash，未验证）。
3. **远端非 bash 时观感变差**：退回哨兵模式后窗口里能看到 `__dsh ...` 包装命令，功能不受影响。
4. **终端不是完整模拟器**：行内覆盖、光标移动是简化处理，`remote_screen` 在极端 TUI 下可能与真实画面不同；
   退出码与输出以 `remote_run`/`remote_exec` 为准。
5. **`remote_exec` 对用户不可见**：这是有意的（带外、原生管道），但意味着 agent 可以在用户看不到终端的情况下做事；
   它同样落统一日志（`remote_log` 可回看），并且共享危险命令闸门。
6. **日志脱敏是尽力而为**：只覆盖 Bearer、`sk-*`、`password=/token=/secret=` 等形态；命令参数里的明文密钥
   在会话期间仍可能进日志（会话结束即删）。敏感操作请用环境变量或 `ssh-agent`。

## 验证证据

隔离 `DSH_HOME=/tmp/dsh-verify` 新建 profile → 安装本包 → 加入 `dsh.profile.bundles` → `--dump-config` 显示：

```yaml
# == dsh-remote-console
- id: dsh-remote-console
  name: dsh-remote-console
  config: {}
```

启动 `dsh verify --no-open --port 3999` 后 `remote-console/plugin.log`：

```
apply (installed=false) rcDir=/tmp/dsh-verify/remote-console
startup sweep done
spawnTerminal wrapped
shells wrapped
retain wrapped
tools registered
```

浏览器入口页的模块启动图包含 `dsh-remote-console/client.js`，对应 combo 资源返回 200
（1.98 MB，内含本插件客户端代码）。真实浏览器里的渲染与交互仍未验证（本机无浏览器），
按 `docs/verify-e2e.md` 在带 ssh 的机器上过一遍即可。

## 0.7.0 增补：文件传输与端口转发

新增 5 个工具（`remote_upload`、`remote_download`、`remote_read_file`、`remote_write_file`、
`remote_forward`）。审计要点：

1. **不新建连接、不碰凭据**：全部复用用户已认证的 ControlMaster socket（`-S <sock>`），
   并强制 `BatchMode=yes` + `ControlMaster=no`：认证过期或 socket 消失时立即失败，
   不会退回交互提示，也不可能由插件自己「重新登录」。
2. **传输完整性**：上传/下载两侧都算 sha256 并比对；远端没有 `sha256sum`/`shasum` 时
   如实返回 `unavailable`，不假装校验过。下载先写临时文件，校验通过才 `rename`，
   失败不会破坏本地已有文件。
3. **覆盖是显式的**：`overwrite` 默认 false，远端/本地已存在同路径时直接报错。
4. **路径安全**：写入路径禁止 `..`（否则敏感路径判定可被绕过）；写入
   `~/.ssh`、`/etc`、`/root`、`/boot`、sudoers、systemd unit、shell profile 走
   `ctx.approval` 一次性审批，没有审批服务时 fail closed。
5. **端口转发只绑回环**：`ssh -N -L 127.0.0.1:<local>:<remote>`，局域网其他机器连不上；
   隧道登记在插件状态里，终端结束、`remote_close`、插件卸载时统一回收。
6. **多路复用语义的坑（本次实测发现）**：`-S` 指向已有 master 时，`ssh -N -L` 客户端
   发出转发请求后**立即以 0 退出**，监听由 master 持有；因此「成功」只能看端口是否在监听，
   停止必须用 `ssh -O cancel -L <spec>`，kill 那个已经退出的客户端是无效的。
7. **配置来源统一**：`DSH_SSH_CONFIG` 以前只影响终端包装器的主机列表，现在 exec/传输/
   转发与包装器都走同一个 `-F`，避免「终端连 A、工具连 B」。


## 0.10.x 增补：会话归属（防越权）

宿主进程里所有会话共用一个 console 表，所以「终端属于谁」必须显式校验：

1. **归属来源**：`ctx.subprocess.spawnTerminal(spec)` 的 `spec.env.DSH_SESSION_ID` 记到
   `cover.sessionId`；调用方会话取工具执行上下文的 `exec.agent.id`（Agent 身份即 SessionId）。
2. **解析即校验**：传 `console_pid` 必须属于当前会话；不传时 `newestConsole(sessionId)` 只在本
   会话的终端里挑；`remote_status` 也只列本会话的终端。不匹配报 `CONSOLE_FORBIDDEN`，
   不回退到「随便挑一个」。
3. **信息缺失时退回旧行为**：两边任一为空（老版本 DSH 不传 `DSH_SESSION_ID`、插件自测、
   手动登记的 console）无法判定归属，此时保持原行为而不是拒绝——否则会把合法终端全部废掉。
4. **审计可追溯**：记录里同时有 `pid` 和 `session`，跨会话排查时不用再靠 pid 猜。
