# AGENTS.md

Instructions for AI coding agents working on this repository. Human contributors: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

`dsh-remote-console` is a DSH plugin. It adds an SSH remote console to the right sidebar of
DeepSeek Harness: the user types the SSH password in a real terminal, and the agent reads and
writes the **same PTY** through text tools. Nothing in DSH itself is modified.

## Hard rules

1. **Plugin only.** Never patch DeepSeek Harness or depend on files inside a DSH install. The
   plugin wraps terminal services that are not documented extension points
   (`ctx.subprocess.spawnTerminal`, `ctx.terminalController.shells|retain`, client
   `ctx.webTerminals.launchShells`). Keep the wrap idempotent: HMR runs `apply()` again on the
   same shared service, so restoring on dispose and keeping `__dshRc*` markers is mandatory.
2. **No secrets.** Never write, print, or commit API keys, tokens, passwords, SSH keys,
   `DSH_HOME` contents, or real host names in tests or docs. Tests use temporary directories and
   a fake shell; `bin/dsh-ssh` must never read a password (ssh prompts for it).
3. **One version source.** `package.json#version` is the only version; `lib/client.js` repeats it
   in `VERSION` and both `npm test` and `scripts/check-release.mjs` fail on drift. Do not bump a
   version unless the task is the release PR.
4. **A release is workflow-only.** Never run `npm publish` by hand. Publishing a `vX.Y.Z` GitHub
   release triggers `.github/workflows/release.yml`, which validates the tag against
   `package.json`, tests, publishes with provenance, and attaches the `.tgz`.
5. **Do not touch the user's DSH data.** Tests and manual checks use temporary
   `DSH_REMOTE_CONSOLE_DIR` directories. Never point a run at `~/.dsh`.
6. **Transfers ride the existing session.** File transfer and port forwarding reuse the
   ControlMaster socket the user authenticated; never add a second connection, a stored
   password, or an sshpass-style helper. When the socket is gone the tools must fail closed.
7. **A release needs the user's explicit approval.** Do not bump the version, merge a release PR,
   push a tag, create a GitHub release or trigger a publish step without a clear "go" from the
   user. Prepare the change, report what and why, and wait. Creating the GitHub release is the
   publish trigger, so it counts as releasing.

8. **Every console has an owner, and tools must check it.** Resolving a console by `console_pid` or
   by "newest" is never enough: compare `cover.sessionId` (recorded from `spec.env.DSH_SESSION_ID`
   at spawn) with the caller session (`exec.agent.id`) and fail with `CONSOLE_FORBIDDEN` on a
   mismatch. `remote_status` lists only the caller's consoles, and audit records carry both `pid`
   and `session`. Subagent/child sessions have their own SessionId and deliberately do not inherit
   their parent's terminal.

9. **UI acceptance needs screenshots *and* a recording.** A change to the settings page, the
   sidebar panel or the terminal UI is only "verified" when the reviewer returns both screenshots
   and a screen recording of the same run: one continuous take from baseline through the action to
   the result, with the key frames not cut out. The report must say where the recording lives, how
   long it is, which steps it covers, and which frames map to which screenshot. A written "looks
   right" plus a few stills is not acceptance.

   A recording is only acceptable from a **real, signed-in user session**. The browser token that
   `dsh web` prints authenticates the HTTP layer, not a DSH account: a fresh `DSH_HOME` without a
   DeepSeek login or API key shows the "开始使用" onboarding and, without a default workspace, a
   "无法创建默认工作区" toast. Before recording, refuse to start unless: the profile has an account
   (or API key) signed in, a default workspace exists, and the page shows none of
   `开始使用` / `无法创建默认工作区` / `authentication required`. After recording, review the
   whole clip (contact sheet plus the first/action/result frames) — a checklist of frame names is not
   a review. The reviewer must look at those frames before accepting; metadata alone is never enough.

## Commands

Run in the repository root:

```sh
npm test                            # unit tests + release metadata checks
node scripts/check-release.mjs      # version / client / changelog / market index
npm run market:index                # regenerate market/index.json before a release
node --test tests/market.test.mjs   # parse the market index with DSH's validator
node scripts/bench.mjs              # SSH channel baseline (needs ssh + sshd)
node --test tests/integration-sshd.test.mjs   # real sshd end-to-end (skips without sshd)
```

Unit tests need only the DSH peer packages (a global DSH install, or the
`npm install --no-save` command in CONTRIBUTING.md). The integration test starts its own
sshd on 127.0.0.1 and skips entirely when `ssh`/`sshd` are missing, so `npm test` still
passes on a machine without them.

## Layout

- `lib/index.js` — host half: shell list injection, PTY capture, OSC framing, agent tools
  (terminal, exec, file transfer, port forwarding, audit read/export), dangerous-command and
  sensitive-write approval, session-log lifecycle, and the cross-session audit trail in `audit/`.
- `lib/client.js` — browser bundle, hand-written: sidebar guide card, host panel, terminal tab,
  version/update hint, and the plugin-row settings page (host list over `ctx.configForms`,
  registered only when that service exists). Update checks are cached for 10 minutes and pick the
  source from how the plugin was installed; failures stay silent.
- `bin/dsh-ssh` — bash wrapper: host menu / one-shot launcher (`--host`, `--target`,
  `--ask-target`), rendezvous file, portable timestamps. Must stay POSIX-bash and
  macOS-compatible.
- `bin/dsh-ssh.mjs` — Node wrapper for platforms without bash (Windows). Same menu/arguments and
  rendezvous, but no ControlMaster: the rendezvous carries an empty socket, and the host tools fall
  back to the PTY channel.
- `tests/` — `console.test.mjs` (fake remote shell replaying OSC frames), `plugin.test.mjs`
  (load against fake DSH services), `client.test.mjs` (HMR idempotency, update compare),
  `wrapper.test.mjs` (dry-run menu, BSD `date`, exit messages), `transfer.test.mjs`
  (path safety, sensitive-write rules, socket argv, free ports), `audit.test.mjs`
  (redaction, cursor reads, export, rotation), `windows.test.mjs` (Node wrapper, node launchers,
  transport selection, tool fallback over a real shell), `pty-transport.test.mjs` (chunked base64
  read/write over a live shell), `host-tools.test.mjs` (remote_host_add/list/remove over hosts.tsv),
  `settings-client.test.mjs` / `settings-host.test.mjs`,
  `market.test.mjs`;
  `sshd-harness.mjs` boots a throwaway sshd for `integration-sshd.test.mjs`.
- `market/index.json` — DSH plugin market format 1, generated by `npm run market:index`;
  `scripts/market-index.mjs` only lists versions that exist on npm.
- `docs/` — `AUDIT.md`, `compat.md` (DSH/platform/capability matrix), `verify-e2e.md`
  (manual end-to-end), `dev/release-checklist.md`.

## Style

- Follow the code around the change. Comments explain reasons, not what the code does.
- User-facing plugin text is Chinese; READMEs are Chinese and English and must stay in step.
- Commit messages in English, imperative subject, the reason in the body.
