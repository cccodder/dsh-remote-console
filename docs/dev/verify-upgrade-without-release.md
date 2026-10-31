# 不发版验证「一键更新」（本地 Verdaccio）

`npm test` 覆盖纯逻辑，但「设置页点更新 → 版本真的变」要跑真实客户端 + 真实 plugin-manager。
不必为此发版：本地起一个 npm 兼容的 registry（Verdaccio），把测试版本发进去，让测试 profile 指向它，
走的就是和线上同一套代码路径。

## 1. 起本地 registry

```bash
npx -y verdaccio@6 --listen 127.0.0.1:4873
# config.yaml 里允许匿名发布：
# packages:
#   '**':
#     access: $all
#     publish: $all
#     unpublish: $all
```

## 2. 造测试版本（只发到本地，不要提交、不要发公开 npm）

```bash
curl -L -o plugin.tgz https://codeload.github.com/cccodder/dsh-remote-console/tar.gz/<要验的 commit>
tar xzf plugin.tgz && cd dsh-remote-console-*
npm pkg set version=0.10.99      # 只在这个临时副本里改
npm pack
npm publish dsh-remote-console-0.10.99.tgz --registry http://127.0.0.1:4873
curl -s http://127.0.0.1:4873/dsh-remote-console/latest   # 确认 latest 指向测试版本
```

## 3. 让测试 profile 用本地 registry

- 在 profile 目录写 `.npmrc`：`registry=http://127.0.0.1:4873/`
- 重启实例；确认宿主解析到它：`POST /api/pluginManager/registries` 的 `resolved` 应指向
  `http://127.0.0.1:4873/`。

## 4. 四项检查

1. **基线**：设置页显示当前版本 +「有新版本 X」+「更新到 X」——说明安装来源识别和查询都走了本地 registry；
2. **真升级**：点更新 → 刷新后版本真的变；`localStorage['dsh-remote-console.pending-update']` 被清掉；
3. **反向**：停掉/挂起 registry 再点更新 → 显示真实失败原因（不是 `[object Object]`）、
   `pending-update` 为 `null`、插件保持启用（设置页还能打开）；
4. **already-installed 兜底**：profile 已装目标版本、页面客户端仍是旧版本时点更新 → 走「卸载 → 安装」并成功。

## 5. 注意事项

- 本地测试版本号**不要提交、不要推、不要发公开 npm**；
- 要验某个修复，**基线客户端必须是含修复的版本**（旧客户端跑的是旧逻辑）；
- 线上 registry/CDN 同步延迟、GitHub Release → npm 发布链路，只能靠真发版验证。
