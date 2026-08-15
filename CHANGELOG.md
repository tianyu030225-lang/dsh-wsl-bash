# Changelog

## Unreleased

Real-environment hardening and regression coverage:

- Sets the persistent PTY's rows/cols from plugin config before Bash starts.
  `script` inherits no window size from a pipe, so without this the shell saw
  a 0x0 PTY and pagers/TUI width detection misbehaved.
- Adds a real-WSL security probe (`npm run smoke:security`) that verifies the
  PTY geometry end to end and confirms the WSL interop escape stays blocked:
  `cmd.exe` must fail to exec inside restricted sandboxes, so no Windows
  process can write outside the read-only bind. The probe writes only a fixed
  marker under `C:\Windows\Temp` and removes it afterwards.
- Adds an official-tool protocol integration smoke (`npm run smoke:integration`)
  that drives the backend through the exact rc.6 `dsh-tool-bash-persistent`
  protocol (initialization line, marker wrap, `promptCompleted`, scrollback
  paging) and proves cwd/env state persists across two commands.
- Both probes are wired into the release gate; they SKIP (not pass) when no
  WSL2 distro is available.

## 0.1.0

Initial local release for DSH `0.1.0-rc.6`.

- Adds agent-owned persistent WSL `bash`.
- Adds one-shot `wsl_bash` and `git_bash`.
- Preserves the existing `pwsh` tool.
- Uses `workspace-write` by default and a policy-owned immutable workspace root.
- Requires WSL `bwrap` and `script` for every WSL mode and fails closed when dependencies are missing.
- Makes Git Bash restricted mode zero-process on denial and limits wider execution to an explicit host-approved exact retry.
- Adds read-only `doctor`, bilingual installation/troubleshooting docs, security model, lifecycle tests, and a local release checklist.
- Fails plugin activation unless the host DSH package is exactly `0.1.0-rc.6`; the release gate now exercises a real Windows DSH mount.
- Clears generated `dist/` before every build and verifies a stale sentinel cannot enter the tarball; the package ships only the executable `bin/dsh-bash-wsl.mjs` plus required notices/docs.

This release candidate is not published to npm and does not provide network isolation.
