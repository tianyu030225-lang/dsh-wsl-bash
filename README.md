# dsh-plugin-bash-wsl 0.2.3

[简体中文](README.zh-CN.md)

Native Git Bash and WSL backends for DSH on Windows. Plugin `0.2.3` targets Desktop and CLI `0.2.1-rc.3` with one shared package. It keeps the existing `pwsh` tool and adds two Web/Desktop modes:

- **WSL 模式** (`bash-wsl`): Standard capabilities with an agent-owned persistent WSL `bash`;
- **Git Bash 模式** (`bash-git-bash`): Standard capabilities with an agent-owned persistent native Git Bash `bash`, requiring explicit full access for the session.

Both modes retain one-shot `wsl_bash`, `git_bash`, and the official `pwsh`. They use the running host's shipped Standard template; they do not replace the stock modes or change the selected default. User customizations to the stock Standard preset are not automatically copied. The headless CLI keeps persistent WSL by default; mode-dropdown selection is a Web/Desktop feature.

The package targets Node.js `>=22` and accepts only DSH `0.2.1-rc.3`. Older DSH versions are not supported by this release; use the documentation at the appropriate historical tag instead. GitHub source publication and npm registry publication are separate steps. An npm release is not currently announced; do not assume that this package name or an unpinned `latest` installs this source.

The default branch documents the current `0.2.3` source. Historical tags and reports describe only their own revisions; `v0.1.0` targets DSH `0.1.0-rc.6`.

Public regression sources, smoke scripts and fixtures are grouped under [`dev/测试/`](dev/测试/). Local test artifacts stay in the ignored root `测试/运行产物/`; they are not included in Git or npm packages. CI uploads its unit results, smoke diagnostic JSON and tested TGZ as Actions artifacts.

`0.2.3` targets [DSH `0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3). It updates the exact host guard, official dependencies, doctor guidance and CLI/Desktop qualification scripts together. Upstream rc.3 adds plugin navigation menus, preserves unsent session drafts and updates API-key model discovery; the terminal, sandbox and permission interfaces used here are unchanged. Both shell modes keep their existing tools, parameters and permission boundaries.

The previous `0.2.2` fixed the Windows/WSL CI coverage gap. The earlier `0.2.1` upgrade followed [DSH `0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), which added **DeepSeek-V4.1-Flash-1017** support. No model performance improvement is claimed. Keep the `0.2.2` source when staying on DSH rc.2.

## 0.2.3 compatibility and release evidence

| Host | Supported DSH version |
| --- | --- |
| Desktop | `0.2.1-rc.3` |
| CLI | `0.2.1-rc.3` |

Automated CI covers Ubuntu/Windows unit tests and real Windows CLI/WSL security and integration probes. A green run is not full Desktop/GUI qualification: those interactive gates in `scripts/release-check.mjs` still require their own fresh evidence. No full `0.2.3` Desktop/GUI qualification is asserted here. The [0.2.0 dual-host report](docs/testing-report-0.2.0.md) remains historical evidence for `v0.2.0` only. Match every test result to its source revision and exact TGZ SHA-256; a filename or version number alone is insufficient.

> **Unofficial community project.** This plugin is an independent, community-maintained extension and is **not affiliated with, endorsed by, or sponsored by DeepSeek**. "DeepSeek Harness" and "DSH" are trademarks of their respective owners. The plugin uses public DSH services and official packages; any plugin defect or behavior change is the responsibility of this repository, not DeepSeek or DSH.

## Security summary

The default mode is `workspace-write`. Restricted WSL takes its writable workspace root from DSH's immutable `sandboxPolicy.workspaceRoot`; a WSL `workdir` is only a cwd inside that root and cannot enlarge the writable bind. Every WSL mode uses bubblewrap (`bwrap`) and `script`, and fails closed when a required dependency or policy service is unavailable. Explicit full access does not confine writes to the workspace. Full-access Git Bash may also use a validated local cwd outside it; choosing a cwd never grants permission.

Restricted WSL modes (`read-only` and `workspace-write`) mask the `/run` Windows interop broker and unset `WSL_INTEROP`/`WSLENV`, so WSL cannot launch Windows `.exe` programs such as `cmd.exe` through that broker. `danger-full-access` intentionally retains host interop as part of its explicit opt-in. This is a targeted Windows-interop boundary, not general IPC or service isolation; reachable local services and network paths can still perform writes when the host permits them.

All WSL Bash entry points clear inherited Bash startup-control variables before Bash can read them, then establish a trusted `/bin/bash` shell identity inside the sandbox. A user or parent-process `BASH_ENV`, `ENV`, `SHELLOPTS`, or `BASHOPTS` cannot run code ahead of the sandbox checks.

Git Bash restricted mode is fail-closed: a denied command starts zero processes. A one-shot command runs only in `danger-full-access`, or after the host approval flow grants one exact retry. Persistent Git Bash instead requires standing `danger-full-access` for the session; a one-shot approval cannot authorize it. Selecting Git Bash mode never changes permissions. A persistent session is never upgraded in place. The plugin does not provide network isolation; commands can reach the network when the host/backend permits it. `doctor` is read-only and never installs dependencies.

Persistent Git Bash commands execute in native Git Bash, not through PowerShell or WSL. A small host-runtime helper groups terminal and background-process cleanup under Windows Job lifetime ownership; this is not a file sandbox. Missing required host libraries or Job support stops startup instead of falling back to an unmanaged native terminal.

## Requirements

- Windows with Git Bash and WSL installed;
- Node.js `>=22`;
- Desktop or CLI DSH `0.2.1-rc.3`;
- for every WSL mode: `bwrap`, `script`, and `realpath` inside the selected WSL distribution;
- for Windows integration tests: a working Git Bash executable and `wsl.exe`.

The default distribution is `Ubuntu`. The plugin starts clean WSL shells (`--noprofile --norc`); configure an explicit distribution or shell arguments only when the host policy allows it.

## Installation

### Obtain or build the package

Git does not contain `dist/` or generated TGZ files. A GitHub source ZIP is not an installable DSH plugin tarball, and an old same-named TGZ left in a checkout must not be reused as the successor release.

For the `0.2.3` source, use Windows Node.js `>=22` and `pnpm@11.21.0` as declared in `package.json`. Clone this repository and select the intended source revision before installing dependencies. From that checkout, the following Windows PowerShell commands create a separate package output directory:

```powershell
pnpm install --frozen-lockfile
New-Item -ItemType Directory -Force -Path ".packages" | Out-Null
pnpm pack --pack-destination ".packages"
```

The existing `prepack` script runs `pnpm run build`, cleaning and rebuilding only this checkout's `dist/`. Do not omit development dependencies when building from source. The resulting `0.2.3` tarball is `.packages/dsh-plugin-bash-wsl-0.2.3.tgz`; retain its checksum with any release. These are build instructions, not a claim that a newly generated package has passed the release gate.

A `file:` or hoisted local install is a deployed copy or hardlink; a clean rebuild of this checkout can leave the profile's installed inode unchanged. Rebuilding or restarting alone is therefore not update proof. Reinstall the new TGZ into the exact target or isolated profile, confirm the runtime `installAnchor`, and compare the installed `dist` hashes with this build. A `link:` install is suitable only for explicitly verified local development and is never release evidence.

WSL may be the development shell, but Windows DSH remains the target: invoke Windows Node/package-manager tooling when working through WSL, keep the checkout and output on the Windows drive, and do not install DSH into WSL for this plugin. Direct Git-URL installation is not documented as supported; use the built tarball instead. Installing dependencies with `npm install` alone does not build or register the plugin in a DSH profile.

### Install into Windows DSH

Back up the target profile's manifest, lockfile and this plugin before replacement. Give Windows DSH the actual Windows absolute path to the tarball just built or downloaded, not a `/mnt/c/...` path. For example, if the checkout is `C:\work\dsh-wsl-bash`, run in Windows PowerShell:

```powershell
Get-Command dsh
dsh plugin --profile web add "C:\work\dsh-wsl-bash\.packages\dsh-plugin-bash-wsl-0.2.3.tgz"
```

Confirm that `Get-Command dsh` resolves the Windows installation. This command targets its `web` profile. Desktop owns a separate `desktop` profile: open **Settings → Plugins → Add Plugin** and select the same tarball there. Installing into `web` does not install into Desktop. Restart the relevant host and create a new conversation after installation. The package metadata loads `cordis.patch.yml`; keep the existing PowerShell bundle. A minimal isolated headless profile fragment is:

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

For a headless CLI configured to use native Git Bash persistence instead of WSL, override both backend rows together. This does not change the host's permission policy:

```yaml
- id: bash-wsl-native
  config:
    - id: bash-wsl-backend-and-tools
      config:
        persistentShell: git-bash
        backendType: git-bash
    - id: bash-wsl-persistent-tool
      config:
        backendType: git-bash
        description: Persistent native Git Bash; requires explicit full-access permission for this session.
```

## Tool calls

After installation and restart, select **WSL 模式** or **Git Bash 模式** when creating a Web/Desktop conversation. Their `bash` tools keep state in the selected environment. A restricted Git Bash call is denied without starting a process; use the host's permission selector only if full access is appropriate. Do not mistake the agent-mode dropdown for the permission selector. Existing conversations retain their original composition under DSH's preset lifecycle.

One-shot `wsl_bash` and `git_bash` calls require `command` and `description`; `description` is for UI/logs and does not affect execution. The persistent `bash` tool requires only `command` and keeps owner-scoped state.

For `wsl_bash`, `workdir` may be relative, a Windows drive path, or the selected distribution's equivalent Linux path. Production mapping is resolved by that distribution's real `wslpath` and `realpath`, so a configured automount root need not be `/mnt`. All spellings must resolve inside the same host-provided workspace; symlink or junction escapes are rejected.

For `git_bash`, an omitted `workdir` defaults to the trusted agent workspace and relative paths resolve from it, not the DSH process directory. Explicit Windows paths still pass the existing path guards.

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

The managed WSL pipe exposes no verified PID/foreground-group identity. Such metadata is omitted; direct registry foreground signals are rejected instead of reporting a fabricated Linux group. Tool cancellation and managed shell close/reset still work.

The model-facing persistent `bash` tool is owner-scoped: another agent cannot list, read, signal, send to, or close its session. Under both supported official tool contracts, timeout or cancellation resets/closes that owner's shell; the next call creates a new clean shell. The tool initializes with `stty -echo` and uses per-command output markers; the plugin backend owns terminal readiness. Lower-level `startSend` interruption is not a model-tool retention guarantee. One-shot `wsl_bash`/`git_bash` timeout or cancellation terminates its managed process tree.

The plugin mounts its versioned adaptation of the shared official persistent tool through `dsh-plugin-bash-wsl/persistent`. It can recognize the current command's real completion frame in incremental output even after background output evicts that frame from the newest scrollback page. Its fallback buffer is capped at 256 KiB; the rendering limit remains 16,000 characters by default. Deadlines and cancellation take priority over a completion frame. The installed DSH files are not patched; upstream attribution is in `NOTICE`.

When working through the persistent `bash` tool, keep state-dependent steps in the same session and send them sequentially: wait for one call to return before issuing the next. If a later call observes missing variables or a working directory reset to the workspace root, the shell was reset by a timeout/cancellation; re-initialize the needed state before continuing. For state that must survive across agent sessions or long idle gaps, write it to a workspace file instead of relying on shell lifetime.

## Included system instructions

Enabling the plugin automatically registers a scoped, disposable system-prompt section through DSH's official `systemPrompt` service. It teaches the agent to choose persistent `bash` for stateful development, keep Windows projects on Windows storage, distinguish one-shot tools, serialize calls and recover after resets. It also explains approval and cleanup boundaries. It contains no personal paths or account data and never edits user `AGENTS.md`, presets or host policies.

The exact texts are exported as `BASH_WSL_SYSTEM_PROMPT` and `GIT_BASH_SYSTEM_PROMPT` from `dsh-plugin-bash-wsl/prompt` (also from the package root). The selected mode contributes the matching section and shadows the global WSL guidance. Both are static text with template interpolation disabled; disposal of the owning composition removes the section. Guidance covers the command-only persistent interface, non-interactive execution, incomplete output, non-rollback recovery, distinct one-shot approval and preserving Windows build targets. Keep local `AGENTS.md` shell descriptions mode-aware; the plugin does not rewrite that file. Stop active sessions and restart after uninstalling: DSH retains old preset revisions while live agents still reference them. The text does not authorize a command or override an explicit user instruction.

## Doctor

Run the read-only standalone doctor from the host where the plugin is installed:

```sh
dsh-bash-wsl doctor
```

The standalone command uses defaults and environment overrides; it does not parse profile patches. It discovers a DSH package via module resolution, which is not proof of the running Desktop/CLI version. Plugin activation instead reads the actual host's `profileContext.installAnchor`; embedded doctor callers can supply that anchor explicitly. Defaults are Ubuntu and `C:\Windows\System32\wsl.exe`, with `DSH_WSL_DISTRO`, `DSH_WSL_PATH` and `DSH_GIT_BASH_PATH` overrides. Workspace mapping uses the current directory. Doctor reports compatibility, Git Bash, WSL, sandbox dependencies and path mapping; it never downloads, installs, edits PATH/profile or escalates access.

## Uninstall

Stop active persistent sessions first. For a Windows CLI `web` installation, remove only this package from that same profile:

```sh
dsh plugin --profile web remove dsh-plugin-bash-wsl
```

For Desktop, remove it through the Desktop plugin manager instead; do not substitute the CLI's `web` profile. Restart the relevant host. Uninstall does not remove WSL distributions, Git Bash, user files, workspace data, or the preserved `pwsh` plugin. Verify that no plugin-owned process remains before deleting the checkout or tarball.

## Compatibility and troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin does not load | Confirm plugin `0.2.3`, Node `>=22`, and an actual host version of `0.2.1-rc.3`. Do not grant a version exemption to bypass the check. |
| Works in CLI but absent in Desktop | `web` and `desktop` are separate profiles. Check the profile that the actual host loaded and restart it after installation. |
| `workspace-write` is unavailable | Run `doctor`; install `bwrap`/`script` through the host's normal system procedure, then restart DSH. The plugin intentionally does not fall back to unrestricted execution. |
| Path with spaces or Chinese characters fails | One-shot tools accept `workdir`; persistent `bash` accepts only `command`, so use a correctly quoted `cd` there. Respect the applicable workspace boundary. |
| WSL `workdir` outside the workspace is rejected | Expected. WSL `workdir` is cwd-only and cannot widen the immutable writable root. |
| Git Bash command is denied without a process | Expected in restricted mode. Obtain host approval for the exact wider retry; do not retry with a different command. |
| Persistent Git Bash is denied | The session needs explicit `danger-full-access`. A one-shot approval is not a persistent-shell permission; choosing the Git Bash mode does not grant full access. |
| New modes are missing | Check that the running Web/Desktop profile loaded the new package and restart it. A headless CLI has no mode dropdown. |
| Windows `.exe`/`cmd.exe` fails inside restricted WSL | Expected: restricted modes hide the `/run` interop broker and unset `WSL_INTEROP`/`WSLENV`. Use a native host tool, or an explicitly approved `danger-full-access` operation only when host interop is acceptable. This is not a general IPC or network boundary. |
| Persistent state is missing | Use `bash`, not `wsl_bash`; verify the same agent owns the session. Persistent sessions use a clean shell and do not inherit unrelated host shell state. |
| Network access is possible | Expected limitation. This plugin does not isolate network traffic; apply a host/network policy if isolation is required. |

Desktop qualification requires `DSH_DESKTOP_ASAR_SHA256` and `DSH_DESKTOP_EXE_SHA256` from a separately verified rc.3 distribution. The scripts compare the installed binaries with those references; missing references block full qualification. Old rc.2 binary hashes and test results do not qualify this version.

For a release candidate, run `node scripts/release-check.mjs` from the source checkout and retain the separate CLI and Desktop test reports. Typecheck, unit tests and archive inspection do not substitute for actual Desktop runtime activation. The gate uses isolated local profiles; skips are not passes. New validation code and reusable fixtures belong under `dev/测试`; temporary run data remains under `测试/运行产物`. Upstream snapshots and run artifacts must not enter Git or the tarball. No test publishes, pushes or modifies real user profiles.

## License and attribution

This package is MIT-licensed. Any copied or adapted code must retain its original copyright and license notices. The implementation should identify borrowed material in `SECURITY.md` or the source file that contains the adaptation. The design borrows safety lessons from the official DSH `rc.6` contract. The adapted terminal state-machine material is identified in `SECURITY.md` and `NOTICE`; no additional audited projects are implied.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md).
