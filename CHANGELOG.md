# Changelog

## 0.2.4 — 2026-10-29

- Target [DSH `0.2.2-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2) exactly; require Node.js `>=24.9.0` and align the official dependency graph, Cordis `4.0.6-alpha.1` and Schemastery `3.18.6-alpha.1`. Run Windows/Ubuntu CI on Node 24.
- Migrate registered-tool probes to the selected native executor’s batch API, with exact call/result correlation and executable lookups. Add installed-runtime regressions for schema/prompt assembly, denied execution with zero process starts, malformed arguments, and unavailable executors.
- Synchronize persistent-shell initialization with upstream (`stty -echo; set +H`) so Bash history expansion cannot rewrite literal exclamation marks. Preserve incremental completion, output limits, cancellation, ownership and process cleanup.
- Keep both additional shell modes, PowerShell, existing permission boundaries, historical evidence and exact older-host rejection. Desktop/GUI qualification still requires fresh target-runtime and candidate hashes; no formal Release or npm publication is implied.

## 0.2.3 — 2026-10-24

- Retarget the exact Desktop/CLI host contract from DSH `0.2.1-rc.2` to
  [DSH `0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3).
  Align `engines.dsh`, all official peer/development dependencies, runtime
  checks, doctor guidance, the pnpm lockfile, and CLI/Desktop probes.
- Compare the official rc.2 and rc.3 tags: the terminal, subprocess, sandbox,
  approval and Standard-preset interfaces used by this plugin are unchanged.
  rc.3 adds plugin navigation menus, fixes unsent draft reuse, and updates
  DeepSeek API-key model discovery. No shell/tool rewrite is needed.
- Preserve both shell modes, one-shot tools, PowerShell, standing permission
  requirements, fail-closed checks and owner/process cleanup. Add regressions
  that reject old rc.2 and unverified later hosts before any registration.
- Require independently verified rc.3 Desktop ASAR/executable reference hashes
  for interactive qualification instead of reusing hard-coded rc.2 hashes.
  Retain all historical reports, TGZ identities and upstream attributions.
- This is a source update. Automated checks and packaging do not establish
  full Desktop/GUI qualification or publish a GitHub/npm release.

## 0.2.2 — 2026-10-19

This release repairs the CI coverage gap found in the `0.2.1` workflow. The
Ubuntu job passed 283 cases but intentionally skipped 24 Windows-only cases;
the separate Windows job did not run those unit tests. Its real-CLI smoke
stopped at startup, and job-level `continue-on-error` still allowed a green
workflow. That result did not establish Windows compatibility or WSL safety.

- Runs typechecking, the complete Vitest suite, build and package checks on
  both Ubuntu and Windows. The Windows result must contain the PTY broker,
  WSL prompt producer and preflight argument contracts, with no skipped or
  todo cases; missing coverage now fails the job.
- Provisions WSL for the Windows unit job too: the existing preflight argv
  case actually executes WSL rather than mocking it. It now respects the
  selected test distribution, saves diagnostics before assertions, and has a
  test timeout that accommodates its three bounded subprocess probes.
- Replaces the informational WSL job with a required Windows job. It installs
  Ubuntu 24.04 under WSL2 plus bubblewrap, util-linux and coreutils, then checks
  that a real bubblewrap sandbox can start before running the probes.
- Selects the exact locally installed DSH `0.2.1-rc.2` CLI and packs the fresh
  `0.2.2` build. Both smoke suites receive that exact TGZ, whose SHA-256 is
  logged. The test-only isolated profile and helper probes use the same WSL
  distribution; production defaults and permission boundaries are unchanged.
- Attempts the integration smoke even when the preceding security smoke fails,
  provided package preparation succeeded. Uploads unit JSON, smoke diagnostic
  JSON and the tested package even after a check fails, making startup and
  capability failures inspectable. A required capability skip remains failure.
- Updates CLI/Desktop qualification scripts and probe package metadata for
  `0.2.2`, and corrects the documentation's distinction between automated CI
  evidence and full Desktop/GUI release qualification. CI does not run those
  interactive Desktop/GUI gates or publish to npm.
- Restores the omitted `0.2.1` upgrade motivation below: compatibility with
  the DSH host release that added DeepSeek-V4.1-Flash-1017 support.

## 0.2.1

This security, reliability, and host-compatibility update keeps the same tool
names, mode names, parameters, and permission model as `0.2.0`.

- Upgrade motivation (added retrospectively in `0.2.2`): DeepSeek released
  **DeepSeek-V4.1-Flash-1017**, and [DSH `0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
  added support for that model. Plugin `0.2.1` was updated to the corresponding
  host contract so users upgrading DSH could retain the Windows WSL/Git Bash
  tools. This is host compatibility, not a model performance benchmark or a
  claim that the model requires this community plugin.
- Targets the current Desktop and CLI DSH `0.2.1-rc.2` host contract exactly;
  earlier DSH builds remain on plugin `0.2.0` or `0.1.0` as documented.
- Uses the host's `workingDirectory` service for persistent and one-shot shells,
  so new sessions follow the current agent workspace while the immutable sandbox
  workspace remains the authority for containment.
- Declares the exact host through `engines.dsh` and aligns every official peer
  dependency with the same `0.2.1-rc.2` release.

- Sanitizes Bash startup-control variables before every WSL Bash launch and
  establishes a trusted `SHELL` inside the sandbox without restoring Windows
  interop in restricted modes.
- Resolves Windows paths through the selected distribution's real `wslpath` and
  `realpath`, while passing the validated Windows path to `wsl.exe --cd`; this
  supports non-default automount roots without weakening containment checks.
- Makes doctor probes use clean Bash, UTF-8 WSL launcher output, and the selected
  distribution's actual launch result, while remaining read-only.
- Preserves terminal control bytes safely, rejects NUL, reports incomplete output
  after any capture gap, binds protocol replies to the current prompt, and makes
  stdin write failures ordered transport failures.
- Preserves and renders structured one-shot failures, including spawn and runner
  diagnostics, and checks WSL PTY permission denial in the merged output stream.
- Replaces platform-shaped test assumptions with filesystem seams and semantic
  skip classification checks. Release evidence remains tied to one exact TGZ.

## 0.2.0

This is the successor to `0.1.0` in the same repository, with one package for both supported hosts. npm publication is separate from GitHub source publication.

### Prompt and publication-documentation revisions

- Clarifies the persistent tool's command-only interface, non-interactive use, completion/truncation evidence, owner-shell close behavior and recovery without assuming side-effect rollback.
- Distinguishes standing permission for persistent Git Bash from exact one-shot approval, and preserves Windows project targets when WSL is only the command environment. No terminal-core or permission-enforcement changes.
- Adds clean-source package creation, independent Windows CLI/Desktop installation instructions and public repository/issue metadata; excludes machine-specific notes and diagnostic helpers from Git.
- Keeps the earlier dual-host report explicitly bound to its frozen candidate. These later prompt/documentation revisions do not inherit its artifact identity or claim a new full release-gate run.

### Runtime changes

- Adds separate WSL and Git Bash Web/Desktop modes, retaining the actual host's shipped Standard capabilities and one-shot WSL/Git Bash/PowerShell tools without replacing stock modes or defaults.
- Adds native Git Bash persistence through the actual host's official PTY backend. It requires standing full-access permission; mode selection and single-command approvals never grant a persistent-shell permission.
- Groups the native ConPTY, helper, Bash and background jobs under kill-on-close Windows lifetime ownership; does not rely on the host's early `pid=0` snapshot or leave terminal cleanup to host exit. Native transport and control still require fresh dual-host acceptance before release.
- Keeps the final shell result when managed-child exit precedes control-pipe delivery; missing or malformed exit facts still fail closed after a bounded drain, with timers and listeners disposed.
- Retains a complete WSL prompt when background output follows it, without treating promptless silence or a different foreground group as shell readiness.
- Emits the OSC marker and controlled prompt text in one short `printf`, avoiding background output between the prompt hook and a separate Readline prompt write. Readiness requires a complete prompt retained for a polling interval, not silence from unrelated background jobs; deadlines remain unchanged.
- Uses the public native session factory to preserve a complete Git Bash prompt despite continuous background output, with the actual host's terminal-protocol replies drained before readiness. Windows pseudo-group identity never authorizes promptless idle completion; output, protocol queues and deadlines remain bounded.
- Ends the native controlled prompt in visible text, since ConPTY can replace trailing spaces with cursor-motion sequences. WSL retains its separate, complete literal-space prompt contract.
- Carries the complete native prompt identity in the OSC payload and requires its later visible sentinel too: ConPTY may forward that control event before repainting earlier command output. Native status fields and delimiters are exact; marker-only, text-only and stale operation state do not authorize readiness. The WSL adjacency contract is unchanged.
- Never sends an expired command after a delayed protocol drain; timeout and cancellation retain operation ownership until pending replies are drained or the session is closed.
- Batches native protocol input with bounded backpressure instead of pausing on every small PTY packet. Drains the captured input prefix without waiting for future background output, while requiring the current prompt and its protocol replies to be parsed and delivered.
- Recognizes the real completion frame in incremental terminal output when background noise has already evicted it from the newest scrollback page, while retaining deadlines, reset and owner isolation and bounding the fallback buffer.
- Starts owner-scoped shell reset immediately on caller cancellation, even while terminal operation settlement is pending; serialized follow-up calls wait for that cleanup.
- Preserves the canonical timeout/reset result when the tool's own deadline expires between polls or rejects a send; unrelated transport errors still fail normally.
- Supplies mode-specific, non-interpolated system instructions and registers presets only when the host exposes its preset registry. Release qualification requires the mandatory Windows CLI, Desktop and GUI gates.
- Supports Desktop DSH `0.2.0-rc.2` and CLI `0.2.1-alpha.1` in one Windows plugin; old DSH remains on plugin `0.1.0`.
- Reads the actual host's `profileContext.installAnchor` instead of trusting a nearby peer package; unsupported hosts fail before registration.
- Adds disposable, non-interpolated system instructions via the official service and exports the bundled text through `./prompt`.
- Aligns the validation matrix with the current official persistent tool, independent Desktop/CLI profiles and local test artifacts.
- Rejects incomplete persistent WSL canonical-path responses and preserves the existing sandbox, approval and owner boundaries.
- Enforces the documented 64MiB one-shot output cap and omits PID metadata unavailable from the 0.2 pipe API; unverified registry foreground signals fail before delivery.
- Caps decoded visible output in both local and managed capture, and marks truncation when malformed UTF-8 expansion forces the bounded tail to discard bytes.
- Returns structured spawn failures from the standalone process helper and completes timer/abort cleanup instead of rejecting early on a missing executable.
- Uses WSL direct `--exec` for one-shot commands and doctor/probe calls, preventing the default shell from expanding nested Bash text before the sandbox.
- Accepts equivalent Windows and `/mnt/<drive>/...` WSL working-directory spellings through the same canonical, immutable workspace boundary.
- Resolves registered Git Bash omitted and relative working directories from the trusted agent workspace rather than the host process directory, while preserving explicit-path guards and approval checks.

Real-environment hardening retained from the previous development baseline:

- Sets the persistent PTY's rows/cols from plugin config before Bash starts.
  `script` inherits no window size from a pipe, so without this the shell saw
  a 0x0 PTY and pagers/TUI width detection misbehaved.
- Adds a real-WSL security probe (`npm run smoke:security`) that verifies the
  PTY geometry end to end and confirms the WSL interop escape stays blocked:
  `cmd.exe` must fail to exec inside restricted sandboxes, so no Windows
  process can write outside the read-only bind. Markers use unique, owned
  sibling fixtures below the test run directory and are removed afterward.
- Adds an official-tool protocol integration smoke (`npm run smoke:integration`)
  that uses the actual official persistent tool in an isolated runtime and
  proves cwd/environment state persists across commands.
- Both probes are wired into the release gate; they SKIP (not pass) when no
  WSL2 distro is available; a required capability skip blocks full qualification.

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
