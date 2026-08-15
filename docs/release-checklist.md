# Local release checklist

This is a pre-release checklist only. It must not publish to npm, push to Git, or alter a user DSH installation. Its package install is limited to the local tarball in a fresh temporary profile and uses `npm --offline`; it does not resolve packages from the registry.

## Before packaging

- [ ] Confirm package name `dsh-plugin-bash-wsl` and exact plugin version `0.1.0`.
- [ ] Confirm Node engine `>=22` and DSH peer/runtime compatibility `0.1.0-rc.6`.
- [ ] Confirm existing `pwsh` registration is preserved.
- [ ] Review the self-contained `SECURITY.md`, `docs/testing.md`, and the repository's `test/` regression suite.
- [ ] Ensure no credentials, local absolute paths, `.env` files, `node_modules`, coverage, or unrelated archives are tracked.

## Verification

- [ ] From the source checkout, `npm run typecheck` succeeds.
- [ ] From the source checkout, `npm test` succeeds; conditional Windows/WSL tests clearly report skips with reasons.
- [ ] Run the security matrix in `docs/testing.md`, including denied Git Bash zero-process and missing-bwrap fail-closed cases.
- [ ] On a real Windows+WSL host, run the restricted Windows-outside marker regression from `docs/testing.md`: the `cmd.exe` interop attempt must leave no marker outside the immutable policy workspace. Record a concrete missing capability as a skip; `danger-full-access` is not a pass for this restricted gate. This regression does not claim general IPC or network isolation.
- [ ] Run `npm run build`; it must clear only this checkout's `dist/` before `tsc`, and the release gate's stale sentinel must stay absent.
- [ ] In a temporary profile directory, install the local package tarball with `npm --offline`; cleanup must remove only that temporary profile and verify the user profile was untouched.
- [ ] Run `dsh --dump-config` against the temporary profile and verify the three tools, defaults, and no unexpected network/Web UI surface.
- [ ] On Windows Node, run `dsh --profile <temporary> --help` and verify headless startup reaches help with the plugin mounted; this is the real activation gate.
- [ ] Run `npm pack --dry-run --ignore-scripts`; inspect the file list.
- [ ] Create a tarball in a temporary directory and audit the declared package artifact: `bin/dsh-bash-wsl.mjs`, `dist/`, `profiles/`, `cordis.patch.yml`, `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, and package metadata. Do not expect source-only `bin/*.ts`, `tests/`, `test/`, `scripts/`, `docs/`, `fixtures/`, or `src/` directories in the tarball.
- [ ] Treat the isolated profile install, `dsh --dump-config`, and Windows-host activation checks above as the tarball's real-load gate; typecheck/tests run only from the source checkout.

## After verification

- [ ] Stop all test-created persistent sessions.
- [ ] Verify no plugin-owned WSL, Git Bash, `script`, `bwrap`, timer, or helper process remains.
- [ ] Remove only the temporary profile, install directory, and test workspace.
- [ ] Record skipped Windows-only cases and their reasons in the release report.
- [ ] Do not publish or push unless a separate explicit request authorizes it.
