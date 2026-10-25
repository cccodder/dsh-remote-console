# 发版前真机检查

CI 只跑单元测试（无 `ssh`、无 PTY、无浏览器）。真实 SSH 登录、密码提示、macOS 表现、
面板渲染和升级路径只有真机能测。

每次发版前由维护者在一台有 `ssh` 客户端的机器（macOS 或 Linux）上做一遍，
改动涉及 macOS 时在 macOS 上也做；结果按「通过 / 不通过 / 备注」贴在 release PR 的评论里，
不通过就开 Issue。

## 准备

- [ ] `package.json` 版本已提升，`lib/client.js` 的 `VERSION` 同步，`CHANGELOG.md` 已落版。
- [ ] `npm run market:index` 已跑，`market/index.json` 里能看到新版本。
- [ ] `npm test` 和 `node scripts/check-release.mjs` 全绿。
- [ ] 一个能登录的远端（真实 `ssh`，最好同时准备密码认证和密钥认证各一台）。
- [ ] 一个新版 `.tgz`（`npm pack`）或 release 里附的 `.tgz`，用于离线安装路径。
- [ ] 从**上一个发布版本**升级的场景：先装旧版，再按升级路径更新。
- [ ] 备份：测试机上的 `~/.dsh` 建议用干净 profile 或先备份。

## 1. 安装矩阵

每种方式用一个干净的 profile，或装完一种卸载再装下一种。

| # | 方式 | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- | --- |
| 1.1 | npm | 插件 → 添加插件 → 填 `dsh-remote-console` → 安装 → 立即启用 | 装好，重启后出现「SSH 远程」卡片 | |
| 1.2 | 插件市场 | 发现 → 添加索引源 → 粘贴 README 里的索引 URL → 安装 | 列表出现本插件；装的是索引里的版本 | |
| 1.3 | `.tgz` | 添加插件 → 填 `.tgz` 完整路径（路径含空格/中文各试一次） | 能装 | |
| 1.4 | GitHub git | 添加插件 → `github:cccodder/dsh-remote-console` | 能装（需要 Git） | |
| 1.5 | CLI profile | `dsh plugin --profile web add dsh-remote-console` + bundles 追加 + `--dump-config` | 组合树里出现 `id: dsh-remote-console` | |
| 1.6 | 重启 | 完全退出 DSH 再打开 | 插件生效，无报错 | |
| 1.7 | 卸载 | 插件 → 卸载 → 再打开 DSH | 插件消失；`~/.dsh/remote-console/` 数据仍在 | |

## 2. 人能用的部分

| # | 检查 | 期望 | 结果 |
| --- | --- | --- | --- |
| 2.1 | 右侧栏「SSH 远程」卡片 → 主机列表 | 列出 `~/.ssh/config` 的 Host；有「新建会话」 | |
| 2.2 | 选主机 | 打开原生终端，窗口里能看到 ssh 命令，ssh 自己提示密码 | |
| 2.3 | 登录成功 | 停在远端 shell，屏幕被清一次，无初始化噪音 | |
| 2.4 | 手动输入密码后中断（Ctrl+C） | 回到菜单或明确提示终端已结束，不误导 | |
| 2.5 | 关终端标签 | 本地 ssh 进程消失（`ps aux \| grep "[s]sh -M"` 为空） | |
| 2.6 | 只关浏览器窗口 8 秒后再开 | ssh 进程被回收；刷新页面时能取消回收 | |
| 2.7 | 面板底部 | 显示当前版本号；有新版本时右侧出现「有新版本」链接 | |

## 3. agent 工具

| # | 调用 | 期望 | 结果 |
| --- | --- | --- | --- |
| 3.1 | `remote_status` | host / socket / idle + 最后几行 | |
| 3.2 | `remote_run("echo $((40+2))")` | 返回 42、退出码 0，窗口里可见 | |
| 3.3 | `remote_run("false")` / 不存在的命令 | 退出码 1 / 127 | |
| 3.4 | `remote_exec("uname -a")` | 原生 stdout/stderr/退出码，窗口里不可见 | |
| 3.5 | `remote_run("cd /tmp && pwd")` 后 `remote_run("pwd")` | 仍是 `/tmp`（状态保留） | |
| 3.6 | `remote_log(cursor)` | 人与 agent 的命令都在同一条日志里 | |
| 3.7 | `remote_run("rm -rf /tmp/x")` | 弹审批卡片；拒绝后返回 `DANGEROUS_REJECTED` | |
| 3.8 | `remote_run("exit 42")` | 弹「会结束终端」审批；批准后提示终端已结束 | |
| 3.9 | `remote_exec("exit 42")` | 不弹审批（`sh -c` 子进程） | |
| 3.10 | 终端停在 `sudo` 密码提示时调 `remote_run` | 返回 `AUTH_REQUIRED` | |
| 3.11 | `remote_run("sleep 10", timeout_ms: 200)` | 返回 `timeout`，可用 `remote_log` 继续看 | |
| 3.12 | `remote_close` | socket/rendezvous 清空，后续调用失败 | |

## 4. 升级路径

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 4.1 | 从上一版本通过插件市场升级（索引有新版本时） | 显示「有新版本」，点击后装到新版本 | |
| 4.2 | 从上一版本手动卸载重装 | 主机列表、`hosts.tsv` 仍在 | |
| 4.3 | 升级后不重启 | 提示需要重启时按提示完整重启 | |
| 4.4 | 升级后打开面板 | 版本号是新版本；热更新不会把面板变空（0.6.2 回归） | |
| 4.5 | 回滚到上一版本 | 能装回；数据仍在 | |

## 5. 平台与清理

| # | 检查 | 期望 | 结果 |
| --- | --- | --- | --- |
| 5.1 | macOS：打开 console | 终端首行没有 `date: invalid argument`；`wrapper.log` 时间戳完整 | |
| 5.2 | Windows（如支持） | 当前不支持：确认文档写明，不做安装测试 | |
| 5.3 | 权限 | `~/.dsh/remote-console/` 0700，`hosts.tsv` 0600，`logs/` 会话结束后为空 | |
| 5.4 | 无残留 | 测试结束后 `socks/`、`sessions/` 为空，没有遗留 ssh 进程 | |

## 6. 发布后验证

- [ ] `npm view dsh-remote-console version` 和 `dist-tags` 是新版本；
- [ ] GitHub Release 页面有 `dsh-remote-console-<version>.tgz` 资产；
- [ ] 市场索引 URL 能被 `node --test tests/market.test.js` 同款解析器解析，且列出新版本；
- [ ] 面板「检查更新」在缓存过期后能看到新版本。
