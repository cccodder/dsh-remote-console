# 代码审计（0.6.0）

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
| 8 | 低 | 无测试、无验证文档；README 引用未随包发布的 `remote_console_design.md` | 新增 44 个测试（纯函数/危险命令/菜单包装器/插件装载/命令通道模拟）、`docs/verify-e2e.md`、README 重写 |

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
