# Contributing

Contributions must target DSH `0.1.0-rc.6`, Node.js `>=22`, and the package's fail-closed security model.

Before editing, read the self-contained security contract in `SECURITY.md` and the repository test/release guidance in `docs/testing.md` and `docs/release-checklist.md`. Keep changes small and preserve user-owned changes. Do not alter the DSH core bundle, install a remote package, or change the existing `pwsh` registration.

## Test expectations

Run the repository's typecheck and tests. Security tests must exercise both the success and denied paths. In particular, prove that a rejected restricted Git Bash request starts zero processes, that missing WSL dependencies do not fall back to full access, that a model `workdir` cannot change `sandboxPolicy.workspaceRoot`, and that a second agent cannot control the first agent's persistent session.

Windows-only integration tests should be conditional only on the actual capability (Git Bash, WSL, `bwrap`, or the Windows host). The skip message must name the missing capability and must never be reported as a pass.

Use temporary directories for fixtures. Do not write outside the test workspace, use real user files, or leave processes behind. Model-facing persistent `bash` tests must assert that command timeout/cancellation resets and closes the owner shell, and that the next call creates a clean shell. If lower-level backend tests cover `startSend`, keep its `SIGINT`/settlement behavior explicitly separate from the model-tool contract. Persistent sessions must be fully cleaned up after create failure, natural exit, explicit close, owner destroy/plugin unload, and abnormal transport exit. One-shot WSL/Git Bash tests must assert that timeout/cancellation reaps the managed process tree.

## Documentation and attribution

Update both `README.md` and `README.zh-CN.md` when user-visible behavior changes. Update `SECURITY.md` when a trust boundary or non-goal changes. If code is copied or adapted, retain its MIT or upstream notice and add the source/commit to the attribution section.

## Release checks

From a source checkout, run `node scripts/release-check.mjs` before asking for review; the npm tarball does not include the source-only `scripts/` directory. It must finish without publishing or pushing, and its tarball manifest must not include secrets, local paths, build caches, test workspaces, or unrelated package files.
