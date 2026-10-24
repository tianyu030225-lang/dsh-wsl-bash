# 0.2.3 source validation

Date: 2026-10-24 (Asia/Shanghai). This report records a source-compatibility
update, not a full release qualification. No GitHub Release or npm publication
is performed by these checks.

## Upstream comparison

- Previous host: DSH `0.2.1-rc.2`, tag commit
  `687f282e8625c6b8d11ff58211a90524be2e4317`.
- Target host: DSH `0.2.1-rc.3`, tag commit
  `1f81c047fc48fa190a683e469daa699857e9afe8`.
- [Official release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)
  and [complete comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3).

The compared tags leave the host terminal, subprocess, sandbox, permission,
approval and Standard-preset interfaces used here unchanged. The session
controller change is client-side draft reuse, not the remote wire contract.
The host guard, dependency graph and current acceptance identities are
retargeted together. Historical reports and upstream code attribution are
preserved.

## Local checks

Environment: Linux x64, Node.js `24.19.0`; dependency installation and lockfile
verification use the declared `pnpm@11.21.0`. Windows CI uses Node.js 22.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| Installed official development package versions | All exact `0.2.1-rc.3` |
| TypeScript typecheck | PASS |
| Vitest | 285 passed, 24 Windows-only skipped, 0 failed; 309 total |
| Clean build and stale-dist cleanup | PASS |
| Tarball contents and private-path audit | PASS; 143 files |
| Security/final pack byte identity | PASS |
| Standalone process observer, mode validator, Git gap, Desktop lifecycle, raw observer, terminal query, Desktop probe identity and output-cap regressions | PASS |
| GUI session driver offline assertions | 28 passed, 0 failed |
| GUI evidence combiner offline assertions | 2 passed, 0 failed |
| Release-check SKIP classification contract | PASS |

The locally audited `dsh-plugin-bash-wsl-0.2.3.tgz` has SHA-256
`14c6d708e2c7c11c67418024ae0bda3f9fd72c412bb2c1ef2ac2ac956e90e19d`.
This binds only that local package. A Windows CI package or a later repack must
record its own checksum; filenames do not establish artifact identity.

pnpm generated exact-version cooldown exceptions for the unified rc.3 graph.
They cover only the requested `@deepseek-ai/dsh*` rc.3 packages, without a
floating version or a global cooldown override. The existing dependency build
allowlist remains unchanged.

## Full release gate

`node scripts/release-check.mjs` returns **BLOCKED** on this Linux host:
21 passed, 12 skipped, 4 failed. The failures are the Windows-only pack-CLI
contract, missing Windows CLI integration evidence, the absent protected
historical root TGZ, and an empty isolated offline npm dependency cache.
Windows/WSL, installed Electron, independently verified rc.3 ASAR/executable
references, preserved historical fixtures and GUI D16 evidence are unavailable
here. None of these missing requirements is converted into a pass.

The existing GitHub CI separately runs Ubuntu/Windows typecheck, all Windows
unit contracts, build/package checks, and real Windows/WSL security/integration
smokes against a fresh exact TGZ. Its run remains distinct from full interactive
Desktop/GUI qualification. Fresh Desktop reference hashes must be supplied via
`DSH_DESKTOP_ASAR_SHA256` and `DSH_DESKTOP_EXE_SHA256`; old rc.2 binary hashes and
historical PASS results are not accepted for this candidate.
