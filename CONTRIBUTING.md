# Contributing to dsh-remote-console

Thanks for helping. This file explains how to set up the repository, test a change, and how a
release is cut. For what the plugin does and how users install it, see [README.en.md](README.en.md).

## Rules that matter most

1. **A DSH plugin, and only a plugin.** Do not patch DeepSeek Harness and do not depend on files
   inside a DSH install. Use the documented plugin APIs; this plugin wraps a few DSH terminal
   services that are not documented extension points, which is why `engines.dsh` is pinned — say
   so in the PR when a change extends that surface.
2. **No secrets anywhere.** No API keys, tokens, passwords, SSH keys, `DSH_HOME` contents, host
   names of real machines, or screenshots with personal data. Tests use temporary directories and
   fake shells.
3. **One version, one source.** `package.json#version` is the only version. The hand-written
   client bundle repeats it in `lib/client.js` (`VERSION`); `npm test` and
   `scripts/check-release.mjs` fail when they drift. `CHANGELOG.md` and `market/index.json` must
   agree with it for the tagged release.
4. **Tests must pass.** `npm test` plus `node scripts/check-release.mjs` before a PR.
5. **A release is cut by the workflow, never by hand.** Do not run `npm publish` locally; pushing
   a `vX.Y.Z` release triggers `.github/workflows/release.yml`.

## Set up

Requirements: Node.js 22 or later, and either a global DSH install (`npm i -g @deepseek-ai/dsh`)
or the peer packages installed locally.

```sh
git clone https://github.com/cccodder/dsh-remote-console.git
cd dsh-remote-console

# The tests load the real DSH peer packages. A global DSH install is enough
# (tests/link-peers.mjs links them); otherwise install them without saving:
npm test
# or, without a global DSH:
npm install --no-save --no-package-lock \
  @deepseek-ai/dsh-home-paths@0.2.1-rc.2 \
  @deepseek-ai/dsh-tools@0.2.1-rc.2 \
  @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2
npm test
```

There is no build step: `lib/index.js` (host), `lib/client.js` (browser bundle, hand-written) and
`bin/dsh-ssh` (bash wrapper) are the shipped files. Tests run without `ssh` and without a PTY —
`tests/console.test.mjs` replays OSC frames from a fake remote shell.

Real-remote checks (password prompts, macOS `date`, HMR reload behaviour) need a machine with
`ssh`; follow [docs/verify-e2e.md](docs/verify-e2e.md).

## Test a change

```sh
npm test                            # 69 tests + version/changelog/market checks
node scripts/check-release.mjs      # same metadata check on its own
node --test tests/market.test.mjs   # parse market/index.json with DSH's own validator
```

Covered by the tests: OSC sentinel framing (exit codes, echo stripping, timeouts), authentication
guard, dangerous / terminal-ending command gating, wrapper menu and host parsing, plugin load
against real DSH peer packages, client patch idempotency (HMR double `apply()`), market index
format 1.

Not covered: a real SSH login, sudo/vim interaction, and the rendered sidebar in a browser.
A change touching those needs the manual checklist.

## Branch and pull requests

- `main` is protected: open a pull request, one subject per PR. No direct pushes.
- Write the user-visible sentence in the PR template's **Changelog** field. Do not edit
  `CHANGELOG.md` outside the release PR.
- Keep `lib/client.js` and `package.json` versions in step; the client bundle is hand-written,
  so review it like source.
- Commit messages in English, imperative subject, the reason in the body.

## Release a version

0. **Get the maintainer's go-ahead first.** This project releases rarely and on purpose: wait for
   an explicit "yes, release X.Y.Z" before touching the version, merging a release PR, tagging or
   publishing a GitHub release (creating the release is what publishes to npm).
1. **Release PR.** Branch from `main`, bump `package.json#version` (and `lib/client.js`
   `VERSION`), move the `## [Unreleased]` section in `CHANGELOG.md` to
   `## [X.Y.Z] - YYYY-MM-DD`, add the compare link, then run `npm run market:index` so
   `market/index.json` lists the new version. Title the PR `release: vX.Y.Z`.
2. **Real-device checklist.** Run [docs/dev/release-checklist.md](docs/dev/release-checklist.md)
   on a machine with a real SSH remote (and macOS when the change touches it) and paste the
   result into the release PR.
3. **Merge** the release PR into `main`.
4. **Publish the GitHub release.** Tag `vX.Y.Z` on `main` and publish the release; paste the
   CHANGELOG section plus **Known limitations**. The release workflow checks that the tag matches
   `package.json`, runs the tests, publishes to npm with provenance (pre-release versions go to
   the npm tag `next`), and attaches `dsh-remote-console-<version>.tgz` to the release.
5. **Verify.** `npm view dsh-remote-console version` and `dist-tags`, the release asset, and the
   market index URL all show the new version. The in-panel update hint picks it up after its
   6-hour cache expires (or after a fresh install).

Manual `npm publish` is not part of this process. If the workflow fails, fix the cause and
re-run it from the failed release (workflow_dispatch with dry run first).

## License

MIT. By contributing you agree that your contribution is licensed under the same license.
