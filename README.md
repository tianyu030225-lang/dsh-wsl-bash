# dsh-plugin-bash-wsl

Native Git Bash and WSL backends for DSH `0.1.0-rc.6`. The plugin keeps the existing `pwsh` tool and adds:

- `bash`: an agent-owned persistent WSL shell;
- `wsl_bash`: a one-shot command in WSL;
- `git_bash`: a one-shot command in Git Bash.

The package targets Node.js `>=22` and the DSH `0.1.0-rc.6` bundle exactly. It is a local, publish-ready artifact; this repository does not publish to npm or install a remote package on your behalf.

> **Unofficial community project.** This plugin is an independent, community-maintained extension and is **not affiliated with, endorsed by, or sponsored by DeepSeek**. "DeepSeek Harness" and "DSH" are trademarks of their respective owners. The plugin builds on the public DSH `0.1.0-rc.6` plugin seams and reuses official packages as dependencies; any bug, security issue, or behavior change in this plugin is the responsibility of this repository, not of DeepSeek or the DSH project.

## Security summary

The default mode is `workspace-write`. The writable root is taken from DSH's immutable `sandboxPolicy.workspaceRoot`; a model-provided `workdir` is only a cwd inside that root. `workdir` can never select or enlarge the writable root. Every WSL mode uses bubblewrap (`bwrap`) and `script`, and fails closed when a required dependency or policy service is unavailable.

Restricted WSL modes (`read-only` and `workspace-write`) mask the `/run` Windows interop broker and unset `WSL_INTEROP`/`WSLENV`, so WSL cannot launch Windows `.exe` programs such as `cmd.exe` through that broker. `danger-full-access` intentionally retains host interop as part of its explicit opt-in. This is a targeted Windows-interop boundary, not general IPC or service isolation; reachable local services and network paths can still perform writes when the host permits them.

Git Bash restricted mode is fail-closed: a denied command starts zero processes. A command runs only in `danger-full-access`, or after the host approval flow grants one exact retry. A persistent session is never upgraded in place. The plugin does not provide network isolation; commands can reach the network when the host/backend permits it. `doctor` is read-only and never installs dependencies.

## Requirements

- Windows with Git Bash and WSL installed;
- Node.js `>=22`;
- DSH `0.1.0-rc.6`;
- for every WSL mode: `bwrap`, `script`, and `realpath` inside the selected WSL distribution;
- for Windows integration tests: a working Git Bash executable and `wsl.exe`.

The default distribution is `Ubuntu`. The plugin starts clean WSL shells (`--noprofile --norc`); configure an explicit distribution or shell arguments only when the host policy allows it.

## Installation

Install from a checked-out directory or a locally produced tarball. Do not use an unpinned registry `latest` tag.

```sh
npm install --save ./dsh-plugin-bash-wsl-0.1.0.tgz
```

Run that command in the target DSH profile directory. The package metadata loads its bundled `cordis.patch.yml`; keep the existing PowerShell bundle in the profile. A minimal headless profile `package.json` fragment is:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-plugin-bash-wsl"]
    }
  }
}
```

For an optional profile override, copy the real `profiles/windows.example.cordis.patch.yml` shape and use fields such as `distro`, `shellPath`, and `shellArgs`. The host profile remains the authority for `sandboxPolicy.workspaceRoot`, approval, and agent identity.

Do not put secrets, credentials, or a writable root in the profile patch.

## Tool calls

One-shot `wsl_bash` and `git_bash` calls require `command` and `description`; `description` is for UI/logs and does not affect execution. The persistent `bash` tool requires only `command` and keeps owner-scoped state.

```json
{
  "command": "printf '%s\\n' hello",
  "description": "Print a greeting",
  "workdir": "src"
}
```

Use `wsl_bash` for a stateless command in the default Ubuntu distribution:

```json
{
  "tool": "wsl_bash",
  "command": "git status --short",
  "description": "Show repository status",
  "workdir": "."
}
```

Use `git_bash` for a native Git Bash command. In restricted mode a denied call returns without spawning a process. An approved retry must repeat the same command and specify the exact approved wider mode; it cannot silently change command, cwd, or writable root.

Use `bash` for state that must persist for one agent:

```json
{
  "tool": "bash",
  "command": "export DSH_TEST=kept; cd src; pwd"
}
```

State set by one `bash` call persists into the next call of the same agent session:

```json
{
  "tool": "bash",
  "command": "printf 'var=%s pwd=%s\\n' \"$DSH_TEST\" \"$PWD\""
}
```

Expected output: `var=kept pwd=.../src`.

The model-facing persistent `bash` tool is owner-scoped: another agent cannot list, read, signal, send to, or close its session. Under the official DSH `0.1.0-rc.6` tool contract, a command timeout or cancellation resets/closes that owner's shell; the next call creates a new clean shell. A lower-level terminal backend may interrupt and settle an individual `startSend` operation, but that implementation detail is not a promise that the model-facing tool retains the session. By contrast, timeout or cancellation of one-shot `wsl_bash`/`git_bash` terminates its managed process tree.

When working through the persistent `bash` tool, keep state-dependent steps in the same session and send them sequentially: wait for one call to return before issuing the next. If a later call observes missing variables or a working directory reset to the workspace root, the shell was reset by a timeout/cancellation; re-initialize the needed state before continuing. For state that must survive across agent sessions or long idle gaps, write it to a workspace file instead of relying on shell lifetime.

## Doctor

Run the read-only standalone doctor from the host where the plugin is installed:

```sh
dsh-bash-wsl doctor
```

The standalone command calls `runDoctor` with defaults and process-environment overrides; it does not parse a Cordis profile patch. It uses Ubuntu and `C:\Windows\System32\wsl.exe` by default, with `DSH_WSL_DISTRO`, `DSH_WSL_PATH`, and `DSH_GIT_BASH_PATH` overrides. Workspace mapping uses the current directory by default. It reports DSH version compatibility, Git Bash discovery, WSL distributions, `bwrap`, `script`, `realpath`, and Windows↔WSL path mapping. A missing dependency is a failure for the affected mode; doctor never downloads, installs, edits PATH, changes the profile, or launches a shell with elevated access.

## Uninstall

Stop active persistent sessions first, then remove the local package through the same package manager used for installation:

```sh
npm uninstall dsh-plugin-bash-wsl
```

Remove the plugin entry from the DSH profile and restart DSH. Uninstall does not remove WSL distributions, Git Bash, user files, workspace data, or the preserved `pwsh` plugin. Verify that no plugin-owned process remains before deleting the checkout or tarball.

## Compatibility and troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin does not load | Confirm DSH `0.1.0-rc.6`, Node `>=22`, and installed plugin package `0.1.0`. |
| `workspace-write` is unavailable | Run `doctor`; install `bwrap`/`script` through the host's normal system procedure, then restart DSH. The plugin intentionally does not fall back to unrestricted execution. |
| Path with spaces or Chinese characters fails | Pass it as `workdir`; do not interpolate it into a shell string. Check that it is inside `sandboxPolicy.workspaceRoot`. |
| `workdir` outside the workspace is rejected | Expected. `workdir` is cwd-only and cannot widen the immutable writable root. |
| Git Bash command is denied without a process | Expected in restricted mode. Obtain host approval for the exact wider retry; do not retry with a different command. |
| Windows `.exe`/`cmd.exe` fails inside restricted WSL | Expected: restricted modes hide the `/run` interop broker and unset `WSL_INTEROP`/`WSLENV`. Use a native host tool, or an explicitly approved `danger-full-access` operation only when host interop is acceptable. This is not a general IPC or network boundary. |
| Persistent state is missing | Use `bash`, not `wsl_bash`; verify the same agent owns the session. Persistent sessions use a clean shell and do not inherit unrelated host shell state. |
| Network access is possible | Expected limitation. This plugin does not isolate network traffic; apply a host/network policy if isolation is required. |

For a release candidate, from a source checkout (the npm tarball does not include `scripts/`), run `node scripts/release-check.mjs` and attach its output. It checks source-tree typecheck/tests, an isolated local-tarball profile install with `npm --offline`, `dsh --dump-config`, Windows-host `dsh --help` activation, and both dry-run and tarball package contents. It never publishes, pushes, or mutates the user's DSH profile.

## License and attribution

This package is MIT-licensed. Any copied or adapted code must retain its original copyright and license notices. The implementation should identify borrowed material in `SECURITY.md` or the source file that contains the adaptation. The design borrows safety lessons from the official DSH `rc.6` contract. The adapted terminal state-machine material is identified in `SECURITY.md` and `NOTICE`; no additional audited projects are implied.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md).
