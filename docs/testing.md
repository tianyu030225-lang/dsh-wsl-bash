# Test and security regression matrix

The test suite is intentionally split into deterministic unit/contract tests and conditional Windows/WSL integration tests. A skipped integration test must state the missing capability (for example `Git Bash executable not found` or `bwrap unavailable`) and is not a pass.

## Required coverage

| Area | Regression assertion |
| --- | --- |
| Configuration | Plugin `0.1.0` with DSH `0.1.0-rc.6`, Node `>=22`, defaults `distro: Ubuntu`, `shellPath: /bin/bash`, and clean `shellArgs`; malformed mode, distro, path, and timeout fail before spawn. |
| Git Bash discovery | Deterministic configured/path/default priority; reject UNC, device namespace, directories, and non-executable candidates. |
| Path handling | Windows↔WSL conversion round-trips spaces and Chinese names; canonical containment rejects `..`, symlink/junction escapes, drive roots, `/mnt/c`, UNC, and device paths. |
| Command boundary | `command` is a Bash program, so Bash syntax such as quotes, newlines, `$()`, backticks, semicolons, and globs executes as intended. The `command`, `workdir`, `description`, and related fields remain in their defined argv/parameter slots and cannot inject an outer PowerShell wrapper or extra `wsl.exe`/`bwrap` options. |
| Output and limits | stdout/stderr truncation is explicit; each captured stream is capped at 64 MiB (or lower configured cap); no unbounded buffering. |
| Timeout/cancel | Model-facing persistent `bash` timeout/cancellation resets and closes the owner shell; the next call creates a clean shell. Lower-level `startSend` signal/settlement tests are separate implementation-detail coverage. One-shot WSL/Git Bash timeout or cancellation kills the complete managed process tree and settles once. |
| Approval | Restricted Git Bash denial starts zero processes. Unavailable/rejected approval starts zero processes. Only the exact command/cwd/mode approved for a single retry can spawn. |
| Sandbox | A model `workdir` cannot change the writable root. Missing `bwrap`, `script`, WSL, or policy provider fails closed. Restricted WSL modes mask the `/run` Windows interop broker and unset `WSL_INTEROP`/`WSLENV`; `danger-full-access` intentionally retains interop. This targeted guard is not general IPC or network isolation. |
| Windows-outside marker | On a real Windows+WSL host, a restricted WSL command attempts to use `cmd.exe` to create a marker outside the immutable workspace; the marker must remain absent. Record a concrete missing Windows/WSL capability as a skip, not a pass; `danger-full-access` is not evidence for this restricted assertion. |
| Agent ownership | Agent A cannot list/read/send/signal/close Agent B's persistent session. Session mode/backend cannot be changed after creation. |
| Lifecycle | Create failure, natural exit, explicit close, owner destroy, plugin unload, and model-facing persistent timeout/cancellation leave no owner shell, process, timer, buffer, or registry residue. The next persistent `bash` call must be a clean shell; one-shot cancellation cleanup is tested separately. |
| Workspace | Writes inside the policy root succeed; writes outside it fail. A model-supplied external cwd cannot widen the bind. |
| Persistent shell | cwd, environment, function, and background-job state persist for the owner only during a live shell; clean shell flags are used. Model-facing timeout/cancellation resets the owner shell, so the next call starts clean. Lower-level SIGINT/abnormal backend behavior is tested separately. |
| Compatibility | `pwsh` remains registered and usable; the plugin does not replace or mutate it. |
| Doctor/release | Doctor is read-only/no-install, uses standalone defaults/environment overrides (`DSH_WSL_DISTRO`, `DSH_WSL_PATH`, `DSH_GIT_BASH_PATH`) rather than parsing a Cordis profile patch, and maps the current directory by default. From the source checkout, release checks typecheck/tests, then audits tarball contents and performs isolated profile install/load, dump-config, and activation checks. |

## Test seam expectations

Tests should inject process discovery/spawn, WSL conversion, approval, policy, timers, and agent identity. Do not rely on PID/name polling as the only cleanup evidence. Assert both the fake process calls and the backend's registry/owner state. For process tests, use an explicit temporary directory under the test root and clean it in `finally`.

The unit suite must run on Linux/WSL without pretending to test Windows-only token or executable behavior. Integration cases can be gated by actual capability probes. The test output should include the skip reason and should fail if a supposedly restricted operation calls the injected spawn seam.

## Suggested commands

Run these commands from a source checkout; the npm tarball does not contain the source-only `scripts/`, `docs/`, `test/`, or `src/` directories.

```sh
npm run typecheck
npm test
node scripts/release-check.mjs
```

The exact npm scripts are owned by the package manifest. If a repository does not define one of these commands, the release check must report the missing command as a failure rather than silently omitting the gate.
