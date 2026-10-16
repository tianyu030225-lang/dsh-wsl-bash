# Contributing

Plugin `0.2.0` contributions target Desktop DSH `0.2.0-rc.2` and CLI `0.2.1-alpha.1`, Node.js `>=22`, and the fail-closed security model. Keep plugin `0.1.0` for old DSH `0.1.0-rc.6`; do not add a legacy branch to the new runtime.

This is one repository's next version, not separate CLI and Desktop packages. For a clean source checkout, follow the build/package steps in `README.md` with Windows Node and the declared `pnpm@11.21.0`; package creation runs the existing build hook and is not an npm publication. The npm package intentionally omits `src`; inspect the matching Git source revision when debugging source/declaration-map references.

Before editing, read the self-contained security contract in `SECURITY.md` and the repository test/release guidance in `docs/testing.md` and `docs/release-checklist.md`. Keep changes small and preserve user-owned changes. Do not alter the DSH core bundle, install a remote package, or change the existing `pwsh` registration.

## Test expectations

Run the repository's typecheck and tests. Security tests must exercise both the success and denied paths. In particular, prove that a rejected restricted Git Bash request starts zero processes, that missing WSL dependencies do not fall back to full access, that a model `workdir` cannot change `sandboxPolicy.workspaceRoot`, and that a second agent cannot control the first agent's persistent session.

Windows-only integration tests should be conditional only on the actual capability (Git Bash, WSL, `bwrap`, or the Windows host). The skip message must name the missing capability and must never be reported as a pass.

Put all new validation code under `dev/测试` and temporary fixtures under `测试/运行产物`. Do not use real user profiles/files or leave processes behind. Persistent tool timeout/cancellation must close the owner shell, and the next call must start clean. Keep lower-level `startSend` behavior separate from that contract. Cover create failure, natural exit, explicit close, owner/plugin disposal and abnormal transport exit, plus one-shot process-tree cleanup. Exercise the actual official persistent tool; do not substitute a copied old protocol for a real host test.

## Documentation and attribution

Update both `README.md` and `README.zh-CN.md` when user-visible behavior changes. Update `SECURITY.md` when a trust boundary or non-goal changes. If code is copied or adapted, retain its MIT or upstream notice and add the source/commit to the attribution section.

Do not stage machine-specific handoff notes, real-profile installation helpers, authentication files, pause logs or generated terminal captures. Preserve portable regression code and synthetic fixtures under `dev/测试`; do not exclude that directory as a whole. Keep historical reports tied to their recorded source and artifact identities, and do not relabel an old PASS as a result for a later revision. The current CI push trigger covers `main`/`master`; pushing only a development branch does not itself prove that CI ran. Its informational Windows probe is not a replacement for the separate required real-host release evidence.

## Release checks

From a source checkout, run `node scripts/release-check.mjs` before asking for review; the npm tarball does not include the source-only `scripts/` directory. It must finish without publishing or pushing, and its tarball manifest must not include secrets, local paths, build caches, test workspaces, or unrelated package files.
