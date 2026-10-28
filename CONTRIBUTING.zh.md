# 为 dsh-remote-console 做贡献

本文说明仓库怎么搭、改动怎么验证、版本怎么发。插件是什么、用户怎么安装，见
[README.md](README.md)。

## 最重要的规则

1. **只做 DSH 插件，不补丁 DSH。** 不改 DeepSeek Harness 源码，也不依赖 DSH 安装目录里的文件。
   这个插件包了几个 DSH 的终端服务，它们不是文档化扩展点，所以 `engines.dsh` 钉死了范围；
   改动扩大这个面时要在 PR 里说明。
2. **任何地方都不留密钥。** API key、token、密码、SSH 私钥、`DSH_HOME` 内容、真实机器的主机名、
   带个人信息的截图都不行。测试用临时目录和假 shell。
3. **一个版本，一个来源。** `package.json#version` 是唯一版本号。手写的客户端 bundle 在
   `lib/client.js` 的 `VERSION` 里重复一次，`npm test` 和 `scripts/check-release.mjs`
   会在两者不一致时失败；发版时 `CHANGELOG.md` 与 `market/index.json` 也必须与它一致。
4. **测试必须过。** PR 前跑 `npm test` 和 `node scripts/check-release.mjs`。
5. **发版只由 workflow 做，不手工发布。** 不要本地跑 `npm publish`；发布 `vX.Y.Z` 的
   GitHub Release 会触发 `.github/workflows/release.yml`。

## 搭环境

需要 Node.js 22 以上，以及全局装的 DSH（`npm i -g @deepseek-ai/dsh`）或本地装的 peer 包。

```sh
git clone https://github.com/cccodder/dsh-remote-console.git
cd dsh-remote-console

# 测试会加载真实的 DSH peer 包；有全局 DSH 时 tests/link-peers.mjs 会自动链接。
npm test
# 没有全局 DSH 时，先装 peer 包（不写进 package.json）：
npm install --no-save --no-package-lock \
  @deepseek-ai/dsh-home-paths@0.2.1-rc.2 \
  @deepseek-ai/dsh-tools@0.2.1-rc.2 \
  @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2
npm test
```

没有构建步骤：`lib/index.js`（宿主）、`lib/client.js`（浏览器 bundle，手写）、
`bin/dsh-ssh`（bash 包装器）就是发布的内容。测试不需要 `ssh`、不需要 PTY：
`tests/console.test.mjs` 用假远端 shell 回放 OSC 帧。

真远端要验证的东西（密码提示、macOS `date`、热更新后重载）需要一台有 `ssh` 的机器，按
[docs/verify-e2e.md](docs/verify-e2e.md) 走一遍。

## 验证一个改动

```sh
npm test                            # 69 个测试 + 版本/CHANGELOG/市场索引检查
node scripts/check-release.mjs      # 只跑元数据检查
node --test tests/market.test.mjs   # 用 DSH 自己的解析器校验 market/index.json
```

测试覆盖：OSC 哨兵（退出码、回显剥离、超时）、认证期拒写、危险/终止命令审批、包装器菜单与
主机解析、插件在真实 DSH peer 包上的装载、客户端包装幂等（热更新重复 `apply()`）、
市场索引 format 1。

不覆盖：真实 SSH 登录、sudo/vim 交互、浏览器里面板的实际渲染。动这些要跑真机清单。

## 分支与 PR

- `main` 有保护：全部走 Pull Request，一个 PR 只做一件事，不能直接推。
- 用户能看到的一句话写在 PR 模板的 **Changelog** 栏；不要在 release PR 之外改
  `CHANGELOG.md`。
- `lib/client.js` 是手写文件，改它时同时看 `package.json` 的版本；`VERSION` 必须与之一致。
- 提交信息用英文、祈使句，原因写在正文。

## 发一个版本

0. **先取得维护者同意。** 这个项目发版是刻意低频的：拿到明确的「可以发 X.Y.Z」之前，
   不要改版本号、不要合并 release PR、不要打 tag、不要创建 GitHub Release（创建 release 就会
   触发 npm 发布）。
1. **release PR**：从 `main` 拉分支，提升 `package.json#version`（以及 `lib/client.js` 的
   `VERSION`），把 `CHANGELOG.md` 的 `## [Unreleased]` 落成
   `## [X.Y.Z] - YYYY-MM-DD` 并加 compare 链接，然后跑 `npm run market:index` 让
   `market/index.json` 列出新版本。PR 标题 `release: vX.Y.Z`。
2. **真机清单**：在有真实 SSH 远端的机器上按
   [docs/dev/release-checklist.md](docs/dev/release-checklist.md) 过一遍（改动涉及 macOS 时也在
   macOS 上过一遍），结果贴到 release PR 评论里。
3. **合并** release PR 到 `main`。
4. **发布 GitHub Release**：在 `main` 上打 `vX.Y.Z` tag 并发布，正文粘 CHANGELOG 的该版本段
   加 **Known limitations**。Release workflow 会校验 tag 与 `package.json` 一致、跑测试、
   带 provenance 发 npm（预发布版本发到 npm 的 `next` 标签），并把
   `dsh-remote-console-<version>.tgz` 挂到 Release。
5. **验证**：`npm view dsh-remote-console version`、`dist-tags`、Release 资产、市场索引 URL
   都显示新版本。面板里的更新提示在 6 小时缓存过期（或全新安装）后会看到。

手工 `npm publish` 不属于这个流程。workflow 失败时先查原因，再从失败的 Release 重跑
（先用 workflow_dispatch 的 dry run 验证一遍）。

## 许可

MIT。提交贡献即表示同意以同一许可证授权。
