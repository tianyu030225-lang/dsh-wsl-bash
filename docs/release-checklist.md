# Local release checklist

This is a pre-release checklist only. It must not publish to npm, push to Git, or alter a user DSH installation. Its package install is limited to the local tarball in a fresh temporary profile. CLI checks use the existing offline cache. The current Desktop runtime uses its bundled pnpm with a test-owned store/cache and may resolve the plugin's exact regular dependency from the registry; it never uses `legacy-peer-deps`, never installs peers into the host, and removes the temporary profile afterward.

## Before packaging

- [ ] Confirm package name `dsh-plugin-bash-wsl` and exact plugin version `0.2.1`; retain `v0.2.0` and `v0.1.0` unchanged.
- [ ] Confirm Node `>=22` and exact compatibility with Desktop and CLI `0.2.1-rc.2`.
- [ ] Confirm activation reads the actual host installation anchor rather than the plugin's nearby dependencies.
- [ ] Confirm system-prompt registration, non-interpolation and removal/reload behavior.
- [ ] Confirm existing `pwsh` registration is preserved.
- [ ] Confirm the default layer and both new modes mount `dsh-plugin-bash-wsl/persistent`; retain the shared upstream tool's MIT attribution, command-only input, initialization, serialization, deadline/reset and cleanup contracts. Validate incremental completion, bounded fallback, split-prefix retention and timeout/abort priority on both actual hosts.
- [ ] Confirm two additional modes (`bash-wsl`, `bash-git-bash`) retain the running host's shipped Standard capabilities without changing stock modes, selected default, policy or approval providers.
- [ ] Review the self-contained `SECURITY.md`, `docs/testing.md`, and the repository's `dev/测试/单元/` regression suite.
- [ ] Ensure no credentials, local absolute paths, `.env` files, `node_modules`, coverage, or unrelated archives are tracked.

## Verification

- [ ] From the source checkout, `npm run typecheck` succeeds.
- [ ] From the source checkout, `npm test` succeeds; conditional Windows/WSL tests clearly report skips with reasons.
- [ ] Run the security matrix in `docs/testing.md`, including denied Git Bash zero-process and missing-bwrap fail-closed cases.
- [ ] Verify every WSL Bash launch clears startup-control variables before Bash, establishes trusted `SHELL=/bin/bash`, and cannot create an outside marker through `BASH_ENV`; restricted interop remains disabled while explicit full access retains its documented behavior.
- [ ] Verify the selected distribution's real `wslpath`/`realpath` mapping, Windows-shaped `wsl.exe --cd`, non-default automount contract, Unicode distribution output under `WSL_UTF8=1`, and clean-Bash `script` doctor probe.
- [ ] Verify persistent TAB/ESC/DEL fidelity, NUL refusal, capture-gap incompleteness, current-prompt protocol barriers, asynchronous stdin failure cleanup, structured one-shot failure rendering, and merged WSL PTY denial diagnostics.
- [ ] On a real Windows+WSL host, run the restricted Windows-outside marker regression from `docs/testing.md`: the `cmd.exe` interop attempt must leave no marker outside the immutable policy workspace. Record a concrete missing capability as a skip; `danger-full-access` is not a pass for this restricted gate. This regression does not claim general IPC or network isolation.
- [ ] Run `npm run build`; it must clear only this checkout's `dist/` before `tsc`, and the release gate's stale sentinel must stay absent.
- [ ] In a temporary profile directory, install the local package tarball without `legacy-peer-deps`. Keep CLI offline when its cache is complete; for Desktop `0.2.1-rc.2`, use the bundled pnpm with a test-owned store/cache and record any exact registry resolution. Cleanup must remove only that temporary profile and verify the user profile was untouched.
- [ ] Treat `file:`/hoisted installs as deployed copies or hardlinks: after every clean rebuild, reinstall the exact TGZ, confirm the runtime `installAnchor`, and compare installed/source `dist` hashes. A `link:` install cannot qualify a release.
- [ ] Independently require the `D-14 old-version runtime rejection` item to PASS: run the preserved 0.1.0 TGZ through the actual Desktop rc.2 `loadProfileDirectory` loader without installing dependencies. Require the explicit rc.6 peer incompatibility diagnostic and omission of the old plugin layer, then use the same owned profile with actual rc.2 `runProfile`/Host initialization to prove `bash`, `wsl_bash`, `git_bash`, the plugin prompt, and plugin prompt schemas are absent. Both loader and Host children must have `exitCode=0/timedOut=false/closeObserved=true/reaped=true/error=null`, with matching host/TGZ identities and containment-checked temporary-root removal. An ordinary old-version pnpm offline-cache diagnostic remains SKIP and has no compatibility authority; missing/malformed TGZ typed rejection and cleanup remain hard checks.
- [ ] Run `dsh --dump-config` against the temporary profile and verify the three tools, defaults, and no unexpected network/Web UI surface.
- [ ] On Windows Node, run `dsh --profile <temporary> --help` as a startup smoke. Help output alone does not prove tool execution.
- [ ] In the real Windows CLI context, execute the installed, registered `bash`, `wsl_bash`, `git_bash` and retained `pwsh` tools; verify state, ownership, cancellation, serialization and cleanup using the mounted plugin and official host tool/registry services.
- [ ] Run `npm pack --dry-run --ignore-scripts`; inspect the file list.
- [ ] Retain a separate actual Desktop runtime report. Windows CLI activation is not proof that Desktop loads or displays the plugin.
- [ ] In the actual Desktop roster, mount both new modes and verify mode-specific prompt/schema assembly, one-shot `pwsh`/WSL/Git availability, WSL persistence and native Git persistence. Restricted native Git must refuse before spawn; full-access execution needs explicit standing permission.
- [ ] On both supported hosts, verify native Git's exact complete OSC identity plus later visible sentinel during continuous background output, actual terminal DSR/DA reply delivery, and same-shell natural-exit cleanup with PID plus creation-time identity. WSL's literal-space adjacency is a separate unchanged contract. Required protocol failures, incomplete/marker-only/stale prompts and promptless silence must remain negative checks; query errors or PID reuse must never be reported as an empty successful cleanup.
- [ ] Keep the old tools-only TGZ/evidence cohort separate. Require fresh core/test/host/artifact bindings and real menu observation for the new modes; a skipped GUI check is not a successful mode-delivery gate.
- [ ] Run new-mode qualification with an explicit `--candidate-tgz`, `--native-modes-cli-evidence`, `--native-modes-gui-roster` and `--gui-evidence`; use the manifest-matching Windows `pnpm.mjs` through `--pack-cli` when selected. The final repack must be byte-identical to that candidate, not the protected historical archive.
- [ ] For human-assisted GUI turns, explicitly verify per-session permissions before prompting. Require the human-authorized standing full-access grant for native Git; require workspace-write for WSL. Observe both expanded tool cards in each mode and quit through the tray/application Exit rather than X.
- [ ] If the exact reviewed Git driver has the documented normal-close observation-ordering defect, preserve its raw FAIL and require the five-file independent supplement described in `docs/testing.md`. Both GUI gates must recompute it, preserve all other assertions and reject missing/tampered proofs, timeout, forced cleanup or residue. Do not use this exception for another driver or failure.
- [ ] In CLI and Desktop evidence, verify source/installed probe `index.mjs` SHA-256 equality against the current fixture; Desktop agents must resolve/mount the actual `standard` preset and initialize the permission metadata through host APIs.
- [ ] Complete the unit/interface, CLI/security and Desktop/artifact matrices. A required host/security skip blocks complete release qualification.
- [ ] Audit the executable, generated `dist/` (including prompt exports), profile sample, patch, public docs/notices and package metadata. Exclude source-only code, `dev/测试`, snapshots, run artifacts, dependencies, private paths and credentials.
- [ ] Treat the isolated profile install, `dsh --dump-config`, actual registered-tool execution and separate Desktop runtime checks above as the tarball's real-load gate; typecheck/tests run only from the source checkout.

## After verification

- [ ] Stop all test-created persistent sessions.
- [ ] Release owned preset Agents and leases; after definition removal and composition disposal, verify no plugin-owned retained mode, prompt, tool or terminal remains and stock modes still exist.
- [ ] Verify no plugin-owned WSL, Git Bash, `script`, `bwrap`, timer, or helper process remains.
- [ ] Remove only the temporary profile, install directory, and test workspace.
- [ ] If GUI acceptance reused a protected authenticated fixture without creating a transient root, record strict fixture/archive preservation, containment and bound driver process/ledger cleanup instead of claiming that fixture was removed.
- [ ] Record skipped Windows-only cases and their reasons in the release report.
- [ ] Do not publish or push unless a separate explicit request authorizes it.
