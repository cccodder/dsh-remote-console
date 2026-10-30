# 端到端验证清单

仓库自带的 `npm test` 覆盖不依赖 `ssh` 的部分（菜单解析、OSC 帧、工具注册、危险命令判定、路径安全）。
其中 `tests/integration-sshd.test.mjs` 会自己起一个 127.0.0.1 的临时 sshd，机器上有 `ssh`/`sshd`
时真跑一遍「登录 → master 复用 → 上下行传输 → 端口转发 → 退出码透传」，没有就整组跳过。
剩下必须在真人真机上验证的（密码/指纹交互、窗口观感、审批卡片）按下面的清单过。

> 不要直接装进你日常用的 profile：先用独立 `DSH_HOME` 起一个旁路实例，验证完再决定是否升级到主 profile。

**验收证据（UI 类改动）**：截图 **和** 录屏都要有。录屏要一次连续录制，覆盖「基线 → 操作 → 结果」
完整流程，关键帧不许剪掉；回报里写清录屏文件路径、时长、覆盖了哪几步，以及关键帧和截图的对应关系。
只有文字结论、或只有零散截图，不算通过。

## 0. 前置

```bash
dsh -V                 # 需要 >= 0.2.1-rc.2 < 0.3.0-0
which ssh              # 必须有系统 ssh 客户端
ssh -o BatchMode=yes -o ConnectTimeout=5 <某台主机> true && echo ssh-ok
```

## 1. 建隔离 profile 并安装

```bash
export DSH_HOME=~/.dsh-verify
mkdir -p "$DSH_HOME"

# 生成一个旁路 profile（首次会安装依赖，需要网络）
dsh verify --from-default-profile web --dump-config >/dev/null

# 装插件（路径换成你 clone 下来的仓库目录）
dsh plugin --profile verify add /path/to/dsh-remote-console

# 把插件加进 profile 的 bundle 列表
node -e '
  const fs=require("fs"), p=process.env.HOME+"/.dsh-verify/profiles/verify/package.json";
  const d=JSON.parse(fs.readFileSync(p,"utf8"));
  if(!d.dsh.profile.bundles.includes("dsh-remote-console")) d.dsh.profile.bundles.push("dsh-remote-console");
  fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");
'

# 确认组合进来了：应看到一段
#   # == dsh-remote-console
#   - id: dsh-remote-console
dsh verify --dump-config | grep -A2 "dsh-remote-console"
```

## 2. 起旁路实例

```bash
dsh verify --no-open --port 3999
# 打开它打印的 http://127.0.0.1:3999/?token=... 
```

插件装载成功的标志（旁路实例的 DSH_HOME 下）：

```bash
tail -5 ~/.dsh-verify/remote-console/plugin.log
# apply (installed=false) ...
# spawnTerminal wrapped / shells wrapped / retain wrapped / tools registered
```

## 3. 人能用的部分

- [ ] 右侧栏出现「SSH 远程」引导卡片；点开是远端列表面板（列出 `~/.ssh/config` 的 Host）。
- [ ] 选一个主机 → 打开原生终端 tab → 窗口里能看到 `ssh -M -S ... -t host` 这行 → `ssh` 提示输入密码。
- [ ] 登录后停在远端 shell；窗口被自动清屏一次（初始化噪音不残留）。
- [ ] 关掉终端 tab：本地 `ssh` 进程与远端会话随之消失（`ps aux | grep "[s]sh -M"` 为空）。
- [ ] 只关浏览器窗口（不关标签）：8 秒后进程被回收；期间刷新页面能重连且取消回收。

## 4. agent 能用的部分（在同一个 DSH 会话里对它说）

- [ ] `remote_status` 能看到 host / socket / idle 状态 / 最后几行。
- [ ] `remote_run("echo $((40+2))")` 返回 `42` 和退出码 0，且**窗口里出现**这条命令与输出。
- [ ] `remote_run("false")` 退出码为 1；`remote_run("nosuchcmd")` 退出码为 127。
- [ ] `remote_exec("uname -a")` 有原生 stdout/stderr/退出码，且窗口里看不到它（只有日志）。
- [ ] `remote_run("cd /tmp && pwd")` 之后 `remote_run("pwd")` 仍是 `/tmp`（shell 状态保留）。
- [ ] `remote_log(cursor)` 能同时读到人敲的命令回显和 agent 的命令。
- [ ] 危险命令审批：让 agent 执行 `remote_exec("sudo reboot")` 或 `remote_run("rm -rf /tmp/x")`，
      应弹出 DSH 审批卡片；拒绝后命令未执行，返回 `DANGEROUS_REJECTED`。
- [ ] 认证期拒写：在终端里让 `sudo` 停在密码提示，再让 agent 调 `remote_run`，
      应返回 `AUTH_REQUIRED` 而不是替你输密码。
- [ ] `exit` 语义（0.6.1）：`remote_run("exit 42")` 先弹审批；批准后终端显示
      「这个终端已经结束」并提示重新登录，`remote_status` 返回 `NO_LIVE_CONSOLE`；
      `remote_exec("exit 42")` 不弹审批（它是 `sh -c` 子进程，不会结束 console）。
- [ ] macOS：打开 console 时终端首行没有 `date: invalid argument`；
      `cat ~/.dsh-verify/remote-console/wrapper.log` 的时间戳是完整 ISO 时间。

## 5. 安全与清理

- [ ] `~/.dsh-verify/remote-console/` 权限 0700；`hosts.tsv` 0600；`logs/` 在会话结束后为空。
- [ ] `grep -ri password ~/.dsh-verify/remote-console/` 不应有明文（日志会脱敏常见形态）。
- [ ] 关掉旁路实例，确认 `ssh -M` 进程无残留。

## 6. 回滚

```bash
node -e '
  const fs=require("fs"), p=process.env.HOME+"/.dsh-verify/profiles/verify/package.json";
  const d=JSON.parse(fs.readFileSync(p,"utf8"));
  d.dsh.profile.bundles=d.dsh.profile.bundles.filter(b=>b!=="dsh-remote-console");
  fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");
'
dsh plugin --profile verify remove dsh-remote-console
rm -rf ~/.dsh-verify
```

## 7. 一键热更新（设置页「更新到 vX.Y.Z」）怎么判

只对**同一安装路径**的升级判断（npm → npm）。判定三件事：

- 刷新后设置页显示 `插件版本 v<新版本>`、`已是最新版本`，没有「更新到」按钮；
- 服务器下发的组合 bundle 里是 `const VERSION = '<新版本>';`（可以 `curl` 页面里 `/plugins/??…` 的那条 URL 再看）；
- 宿主进程 pid 没变（更新是 HMR 热应用，不是重启）。

**0.10.5 真机记录（2026-10-29，DSH 0.2.1-rc.3，npm 装的 0.10.4 → 0.10.5）：通过。**

- 点更新 → 页面自动刷新，**全程没重启**；刷新后 v0.10.5、组合 bundle 里 `VERSION = '0.10.5'`、宿主 pid 不变。
- profile 依赖 `"0.10.5"`、`node_modules` 里是 0.10.5、realpath 仍是同一个 `profiles/<profile>/node_modules/dsh-remote-console`。
- 更新后改上限保存成功、Console 干净。

**例外：换成 npm 来源的升级需要重启一次。** 如果当前版本是本地目录 / `link:` 装的，更新会把来源换成 npm，
解析路径也变了；DSH 的 `dsh-client-modules` 按 `baseUrl + 包名` 缓存客户端条目（`resolveMeta` 同样按这个键缓存），
路径变了也不会重建，浏览器会继续跑旧 bundle。0.10.5 起页面会自检并在这种情况下提示「重启 DSH 一次生效」，
不再显示假成功。这段提示本身的真机验证要等下一次 `0.10.5 → 0.10.6` 的更新。

**注意**：版本检查有 10 分钟缓存（0.10.6 起；更早的版本是 6 小时），刚发版时设置页可能还显示「已是最新版本」，先点「重新检查」。

## 已知无法在无 ssh 环境验证的点

- 真实 `ssh` 的认证交互（密码、主机指纹、key passphrase）。
- 远端 `PROMPT_COMMAND` 钩子在目标发行版 bash 上的行为（`bash -li` 是否加载你的 rc、是否覆盖 `PROMPT_COMMAND`）。
- 非 bash 远端退回哨兵模式的实际观感。
