# dsh-remote-console

English | [中文](README.md)

An SSH remote console for the DeepSeek Harness right sidebar. You type your SSH password
yourself; the agent reads and writes the **same PTY** through plain text, and everything
both sides do lands in one replayable log.

The plugin does not reimplement a terminal: rendering, input and window management reuse
DSH's own terminal. It only adds remote launchers to the shell list, captures that PTY's
byte stream, and gives the agent tools that write into the same terminal.

## Why

Agent remote execution is usually a second, invisible SSH channel: you cannot see what it
types, nobody can answer the password/sudo/host-key prompts, and shell state (`cd`,
`export`) is lost between calls.

This plugin puts the agent inside **the terminal you are already watching**. Its commands
appear in the window like human typing, and the exit code comes from the shell's own
`PROMPT_COMMAND` hook (an OSC marker), not from guessing at prompts.

## Install

Requires DSH `>= 0.2.1-rc.2 <0.3.0` and a system `ssh` client.

**CLI-managed profile** (e.g. `web`):

```bash
# 1. install into a profile (replace "web" with your profile name)
dsh plugin --profile web add /path/to/dsh-remote-console

# 2. add it to that profile's bundle list
#    $DSH_HOME/profiles/web/package.json:
#      "dsh": { "profile": { "bundles": [ ..., "dsh-remote-console" ] } }

# 3. confirm the layer is composed (expect: id: dsh-remote-console)
dsh --profile web --dump-config | grep -A2 dsh-remote-console
```

**Electron desktop app**: the `desktop` profile is owned by the app and the CLI refuses it
(`profile "desktop" is managed exclusively by the Electron application`). Install through the
in-app plugin manager with the repository address (`github:cccodder/dsh-remote-console`); it
writes `dependencies` and `dsh.profile.bundles` for you. The global `dsh` CLI may be older
than the DSH bundled in the app — the app's version is the one that counts.

No Python, no edits to `~/.ssh/config`, no shell rc changes.

## Usage

1. Right sidebar → the "SSH 远程" guide card → pick a host (from `~/.ssh/config`, or add one).
2. The terminal runs `ssh -M -S <sock> -t <host>`; `ssh` prompts for the password itself —
   the plugin never sees it.
3. Agent tools after login:

| Tool | Purpose |
| --- | --- |
| `remote_status` | Console, host, socket, state, last screen lines |
| `remote_run(command)` | Write into the same PTY (visible in the window), return output + real exit code (the PTY merges stderr into it) |
| `remote_exec(command, cwd?)` | Out-of-band execution over the ControlMaster socket: native stdout/stderr/exit code, no terminal noise |
| `remote_screen(lines)` | Current screen as plain text (ANSI stripped) |
| `remote_log(cursor)` | Incremental read of the unified JSONL log (human commands, agent commands, both outputs) |
| `remote_close()` | Close the ssh master and clean up socket/rendezvous files |

**`exit` semantics**: host launchers and "new session" are one-shot — when the remote shell
exits (`exit`/`logout` in a command, or ssh drops), the whole console ends, every `remote_*`
tool stops working, and a human must reopen the terminal and log in again. Such commands ask
for approval first, and the terminal says plainly that it has ended instead of pretending
the session is still usable.

## Security

- **Credentials never pass through the plugin**: the password is typed into `ssh`'s own
  prompt. `hosts.tsv` stores only host/user/port (mode 0600), the data dir is 0700, and no
  key material is ever written.
- **No writes during authentication**: while the screen sits on `password:`, `(yes/no)?`,
  `Permission denied`, etc., agent writes are rejected (`AUTH_REQUIRED`).
- **Dangerous-command approval**: `remote_run`/`remote_exec` bypass the DSH sandbox, so the
  plugin adds a gate: patterns such as `rm -rf`, `mkfs`, `dd of=/dev/*`,
  `shutdown/reboot`, fork bombs, `curl | sh`, `git push --force`, `DROP TABLE` trigger a
  one-shot approval card through DSH's `ctx.approval`. A grant covers that command only;
  with no approval service mounted the command fails closed. `exit`/`logout`/`pkill ssh` in
  `remote_run` (which end the whole console) ask for approval too.
- **Logs disappear**: the per-session JSONL is deleted when the PTY ends; logs left behind
  by a DSH crash are swept on the next plugin start. Known secret shapes (Bearer tokens,
  `sk-*`, `password=/token=/secret=`) are redacted, but plaintext secrets inside command
  arguments can still appear during the session — prefer env vars or `ssh-agent`.
- **Closing means revoking**: closing the terminal tab kills the process tree immediately;
  closing the browser kills it 8 s after the last window hold disappears (a refresh
  reconnects and cancels); if DSH crashes, the PTY master disappears and `ssh` exits on HUP.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_REMOTE_CONSOLE_DIR` | `$DSH_HOME/remote-console` | Data dir (logs/sessions/socks/bin) |
| `DSH_SSH_CONFIG` | `~/.ssh/config` | Host alias source |
| `DSH_RC_DANGER_GUARD` | `approve` | `off` disables the approval gate (still audited) |
| `DSH_RC_DRYRUN` | `0` | Wrapper dry-run: print the ssh command without running it |
| `DSH_RC_NO_CLEAR` | `0` | `1` disables the automatic screen clear |
| `DSH_RC_SELFTEST` | `0` | Run the built-in self test once at startup |

## Compatibility

- The plugin wraps DSH's terminal services (`ctx.subprocess.spawnTerminal`,
  `ctx.terminalController.shells|retain`, client `ctx.webTerminals.launchShells`). This is
  the common community-plugin approach but **not a documented extension point**; DSH
  changes to those internals need a matching update (`engines.dsh` declares the tested range).
- Remote shells start as `bash -li` to install the `PROMPT_COMMAND` hook. Without bash the
  plugin falls back to sentinel framing — same capability, slightly noisier screen.
- No full terminal emulation: in-line overwrite is simplified, so `remote_screen` can
  differ from the real screen in extreme TUI cases; trust `remote_run`/`remote_exec` for results.

## Development

```bash
npm test    # 61 tests: pure helpers, danger/terminating patterns, wrapper menu, plugin load, command channel
```

Tests need neither `ssh` nor a real PTY: `tests/link-peers.mjs` symlinks the peer packages
from your global DSH install, and `tests/console.test.mjs` replays OSC frames from a fake
remote shell.

## License

MIT. See [LICENSE](LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
