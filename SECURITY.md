# Security model

This document is the security contract for plugin `dsh-plugin-bash-wsl` `0.1.0`, compatible with DSH `0.1.0-rc.6`. It records deliberate limits as well as required fail-closed behavior. A test that contradicts this document is a release blocker; do not weaken the assertion to make an implementation pass.

## Assets and trust boundaries

The host DSH process, its loaded `sandboxPolicy`, approval service, and agent identity are trusted inputs. Model arguments, tool descriptions, `workdir`, command text, environment supplied by the model, path spelling, and session IDs are untrusted. The plugin must preserve the host's `pwsh` registration and must not modify DSH core, profiles, or user ACLs.

The only writable workspace root is the immutable, host-provided `sandboxPolicy.workspaceRoot`. Canonical containment must be checked after resolving Windows/WSL paths and reparse/symlink components. `/`, `/mnt`, `/mnt/c`, a drive root, UNC paths, device namespaces, and an unrelated directory are never valid workspace roots. A model `workdir` is a cwd relative to or contained by that root; it is not a second root and must not alter mounts.

## Backend rules

### WSL

`bash` is a persistent WSL session. `wsl_bash` is one-shot WSL. The default distribution is Ubuntu and the default shell is clean. Every WSL mode uses `/usr/bin/bwrap` and `/usr/bin/script`; restricted modes use a read-only host view with a bind limited to the trusted workspace root, mask the `/run` Windows interop broker, and unset `WSL_INTEROP`/`WSLENV`. This prevents WSL Windows `.exe` interop such as `cmd.exe` in restricted modes. `danger-full-access` uses a full `/` bind inside the parent-tied bwrap process and intentionally retains host interop. A missing `bwrap`, `script`, WSL distribution, spawn seam, or sandbox policy is an error before spawn. No fallback to unsandboxed WSL is allowed. This is a targeted Windows-interop boundary, not general IPC or service isolation; reachable local services and network paths remain outside the claim.

### Doctor

The standalone `dsh-bash-wsl doctor` command calls `runDoctor` with defaults and process-environment overrides; it does not parse a Cordis profile patch. It uses Ubuntu and `C:\Windows\System32\wsl.exe` by default, with `DSH_WSL_DISTRO`, `DSH_WSL_PATH`, and `DSH_GIT_BASH_PATH` overrides. Workspace mapping defaults to the current directory. Doctor is read-only and never changes host or profile state.

The persistent session stores its effective mode at creation. A later request cannot upgrade or downgrade it in place. A wider approved operation is a new one-shot invocation with the exact command and cwd, followed by normal cleanup.

### Git Bash

`git_bash` discovery has deterministic priority and rejects UNC/device paths. It passes command data as argv/structured input; it does not build a PowerShell command string. Restricted mode performs policy and approval checks before process creation. A denial must be observable as zero child processes. Only the host's explicit `danger-full-access` or one exact approved retry may spawn. Missing guard/runner/policy fails closed.

The plugin does not claim that Git Bash itself is a sandbox. Native Windows ACL/token enforcement, if supplied by the host, remains the host's responsibility. The plugin must not claim network isolation: WSL, Git Bash, and `pwsh` can reach the network when the host permits it.

### Persistent session ownership

Every persistent session has an owner agent and an immutable backend/mode. `list`, `read`, `send`, `signal`, and `close` enforce that owner. Agent A must not affect Agent B's session, even when it knows a session ID. The model-facing DSH `0.1.0-rc.6` persistent `bash` tool resets/closes the owner's shell when its command deadline expires or its upstream signal is aborted; the next invocation creates a new clean shell. A lower-level terminal backend may deliver `SIGINT` and settle an individual `startSend` operation, but that internal behavior is not the model-facing retention contract. Creation failure, natural shell exit, explicit close, owner destroy, and plugin unload are also cleanup boundaries that remove registry entries, timers, buffers, and reap the process tree. One-shot WSL/Git Bash timeout or cancellation separately terminates its managed process tree.

## Required fail-closed invariants

- Invalid config, unsupported DSH version, or missing required service prevents plugin activation.
- Model `workdir` never chooses the writable root.
- Empty/relative/space-containing/Chinese paths are handled as path values, not shell fragments.
- `command` is intentionally a Bash program, so Bash syntax such as quotes, newlines, `$()`, backticks, semicolons, and globs executes according to Bash. `command`, `workdir`, `description`, and related approval/path fields remain in their defined argv/parameter slots and cannot inject an outer PowerShell wrapper or extra `wsl.exe`/`bwrap` options.
- Output is bounded at 64 MiB per captured stream (or a lower configured cap); truncation is explicit and never silently disables the cap.
- Model-facing persistent `bash` timeout/cancellation resets and reaps the owner shell; the next call starts a clean shell. One-shot timeout/cancellation kills the complete managed process tree and settles exactly once. Any lower-level `startSend` signal/settlement behavior is an internal backend detail, not a session-retention guarantee.
- Approval rejection, unavailable approval, stale mode, or inexact retry executes zero processes.
- A missing WSL sandbox dependency never downgrades to unrestricted execution.  
- Restricted WSL modes mask the `/run` interop broker and unset `WSL_INTEROP`/`WSLENV`; a real Windows/WSL regression that attempts to create a marker outside the policy workspace through `cmd.exe` must leave that marker absent. `danger-full-access` is an explicit exception. This assertion is not a claim of general IPC or network isolation.
- Doctor is read-only and never installs or changes host state.

## Threat model and non-goals

The plugin protects the host workspace boundary, agent session ownership, command/argv separation, targeted restricted-mode Windows interop, and process cleanup. It does not protect against a user who intentionally grants `danger-full-access`, a compromised host/kernel, a malicious DSH host, or data exfiltration over an allowed network. General IPC isolation and service-mediated writes are explicitly out of scope: reachable local or network services may still perform writes when the host permits them. Network isolation is explicitly out of scope. It does not provide a Web UI, remote execution service, npm publishing, or an installer that patches a DSH installation.

This baseline is self-contained. Its release-blocking regressions cover four boundaries: model `workdir` must not enlarge the immutable WSL writable bind; missing sandbox services must not silently become full access; restricted WSL Windows interop must not create an outside-workspace marker; and persistent sessions must remain isolated by agent owner. The documentation also explicitly discloses that WSL does not provide general IPC or network isolation.

## Reporting and release gate

Report a suspected boundary bypass privately to the repository owner with a minimal reproduction, host/DSH versions, backend, effective mode, and whether a child process was created. Do not include secrets or publish an exploit before remediation.

Before a release candidate, from a source checkout, run `node scripts/release-check.mjs` and review the generated package file list. Required checks include source-tree typecheck/tests, a build that clears only this checkout's old `dist/` output, an isolated local-tarball profile install with `npm --offline`, `dsh --dump-config`, Windows-host `dsh --help` real activation, `npm pack --dry-run`, and tarball content. The npm tarball does not include the source-only `bin/*.ts`, `scripts/`, `docs/`, `test/`, or `src/` directories. The temporary profile is removed during cleanup; no registry resolution or user-profile mutation is part of the gate. Windows-only checks must be marked skipped with the concrete missing capability; a skip is not a pass.

## Attribution

This package is MIT-licensed. The plugin uses the DSH `0.1.0-rc.6` public plugin seams and safety concepts documented by the DSH project. Any copied or adapted code from DSH or third-party audited projects must keep the source license/copyright notice and identify the source and commit here or beside the adaptation. No security guarantee from a referenced project is being imported by reference.
