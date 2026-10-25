<!--
目标分支：main。日常改动请开 Pull Request，不要直接推 main。
Base branch: main. Open a pull request instead of pushing to main.

除非这是 release PR（标题 `release: vX.Y.Z`），否则不要改 package.json 的 version，
也不要改 CHANGELOG 的版本段。
Unless this is the release PR (titled `release: vX.Y.Z`), do not touch the version in
package.json or the version sections of CHANGELOG.md.
-->

## Issue

Fixes #

## What changed / 改了什么

## Changelog

<!--
一句用户能看到的变化（会写进下一个版本）；没有就写「无」。
One user-visible sentence for the next release, or "none".
-->

## How I checked it / 怎么验证的

- [ ] `npm test`
- [ ] `node scripts/check-release.mjs`
- [ ] `npm run market:index` ran when the version changed / 版本变了时重新生成了市场索引
- [ ] Real ssh remote checked when the change touches the PTY, auth, ssh flags or the wrapper / 改了 PTY、认证、ssh 参数或包装器时，用真实 ssh 远端验证过
- [ ] Screenshot attached for interface changes / 界面改动附了截图
- [ ] Market index fetched and parsed when the change touches `market/` / 改了 `market/` 时抓取并解析过索引

## Checklist / 检查

- [ ] One subject per pull request / 一个 PR 只做一件事
- [ ] No keys, tokens or personal data (screenshots included) / 没有密钥、token 或个人信息，截图里也没有
- [ ] `lib/client.js` changes keep `VERSION` equal to `package.json` / 改客户端时 `VERSION` 与 `package.json` 一致
- [ ] Release PR only: version bumped, `CHANGELOG.md` Unreleased section moved to the new version with a compare link / 仅 release PR：版本号已提升，CHANGELOG 的 Unreleased 已落成新版本并加 compare 链接
