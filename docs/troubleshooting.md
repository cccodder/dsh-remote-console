# 故障排查与性能

先看「找不到日志」，再对号入座。版本/平台层面的差异（DSH 0.3.0、Windows、pnpm 11）见
[compat.md](compat.md)；认证、审批、日志留存的设计见 [security-model.md](security-model.md)。

## 找不到日志 / 开内建自测

数据目录默认是 `$DSH_HOME/remote-console`（`$DSH_HOME` 通常是 `~/.dsh`）。桌面 App 与 CLI 的
`DSH_HOME` 可能不同：

```sh
# CLI / 旁路实例
echo "$DSH_HOME"
ls ~/.dsh/remote-console

# 桌面 App：把变量放进 App 的启动环境后完整重启（macOS 示例）
launchctl setenv DSH_REMOTE_CONSOLE_DIR /path/to/somewhere
# 验证完记得取消：launchctl unsetenv DSH_REMOTE_CONSOLE_DIR
```

启动后跑一次内建自测并写 `selftest.log`：`DSH_RC_SELFTEST=1 dsh --profile web ...`。

## 1. 终端报 `ssh: command not found`

本机没有 ssh 客户端。装一个再重试：

```sh
# Debian/Ubuntu
sudo apt-get install openssh-client
# Fedora/RHEL
sudo dnf install openssh-clients
# macOS 系统自带 /usr/bin/ssh，一般不需要安装
```

## 2. `Bad owner or permissions on ...`

ssh 不接受权限过宽的 `~/.ssh/config`（或 `IdentityFile`）。检查：

```sh
chmod 600 ~/.ssh/config
chmod 700 ~/.ssh
# 系统配置被镜像/容器改坏时
ssh -F /dev/null -G example.com >/dev/null
```

## 3. 密码 / 主机指纹认证卡住，agent 写入被拒

这是设计行为：屏幕停在 `password:`、`(yes/no)?`、`Permission denied` 等状态时，
agent 的任何写入都会被拒绝（`AUTH_REQUIRED`），避免它替你回答认证问题。
请在终端里亲自完成认证；完成后 agent 工具自动恢复。

## 4. Control socket 不可用

`remote_exec` / `remote_forward` / 文件传输报 `SSH_CLIENT_FAILED` / `NO_LIVE_CONSOLE`，
或 ssh 说 `control socket connect(...): No such file or directory`：

1. 确认终端标签还开着——ssh 退出后 socket 会被清理。
2. 找到残留的 master 并收掉：

```sh
ls -la ~/.dsh/remote-console/socks/
ssh -O exit -S <sock> <host>   # <sock> 换成上面的路径，<host> 换成对应主机
```

3. Windows 没有 ControlMaster：这些带外能力本就不可用，工具会自动退回 PTY 通道
   （命令/数据在窗口可见、单文件 ≤1 MiB、无端口转发；面板文件区为空）。

## 5. 终端结束后工具报 `CONSOLE_CLOSED` / `NO_LIVE_CONSOLE`

面板里的主机启动器与「新建会话」都是一次性的：远端 shell 退出（`exit` / `logout`、
ssh 断开、窗口关闭）后整个终端结束，所有 `remote_*` 工具失效，需要人工重开终端、
重新输密码。插件会拦下会结束终端的命令并要一次审批，不会假装还能继续用。

## 6. 插件市场索引不更新

```sh
# 1. 确认索引里有没有新版本（把 0.7.0 换成你等的版本）
curl -s https://raw.githubusercontent.com/cccodder/dsh-remote-console/main/market/index.json \
  | grep -o '"version": *"[^"]*"' | tail -10

# 2. 换镜像源再试（缓存策略不同）
#    GitHub Pages: https://cccodder.github.io/dsh-remote-console/market/index.json
#    jsDelivr:      https://cdn.jsdelivr.net/gh/cccodder/dsh-remote-console@main/market/index.json
```

市场索引每次推送后自动重建；首次启用约需 1 分钟。若配置了索引却看不到插件，确认 DS H 的实验性
插件市场 bundle 已启用。

## 7. 更新检查一直转 / 点更新版本没变

- 更新检查缓存 10 分钟，点「重新检查」立即重查；失败静默（离线、限流、CORS）。
- 从 0.10.9 及更早版本升级，先手动卸载重装一次（那几版点更新会「假成功」），升到 0.10.10
  之后一键更新才可靠。
- 本地目录 / `link:` 安装不提供一键更新（避免覆盖开发目录）；更新后若提示重启，重启一次 DSH。

## 性能基线（loopback）

`scripts/bench.mjs` 只量 SSH 通道本身的开销（不经过 DSH、不经过插件）：起一个 127.0.0.1 上的
临时 sshd，用 ControlMaster socket 量「建立 master」「复用 master 的 exec 往返」「1 MiB 上传/下载」。
本机实测（2026-10-28，Linux x64 6 vCPU，OpenSSH 9.2p1，`node scripts/bench.mjs --runs 60`）：

| 指标 | 实测值 |
| --- | --- |
| 建立 master（连接 + 公钥认证 + socket 就绪） | 约 185–197 ms（5 次中位数；有负载时最高约 216 ms） |
| 复用 master 的 exec 往返 | 约 6–9 ms（5 次中位数） |
| 1 MiB 上传 | 约 26–35 ms（sha256 校验前） |
| 1 MiB 下载 | 约 22–33 ms（sha256 校验前） |

这是回环地址上的数字，只说明通道开销很小；真实网络的延迟与带宽才是主要成本。
`remote_exec` 复用已建立的 master，所以单次调用的固定开销就在「exec 往返」这一档。
