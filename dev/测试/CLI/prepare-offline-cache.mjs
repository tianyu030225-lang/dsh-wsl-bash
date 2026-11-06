import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, RUN_ROOT, cleanupOwnedTestRoot } from "./test-harness.mjs";

// Frozen installs can restore tarballs without resolving registry metadata.
// Resolve only the plugin's runtime dependencies before the offline CLI tests.
// Never add peers, run dependency scripts, or install into a real DSH profile.
const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("Run this helper with pnpm run test:prepare-offline-cache");
const version = execFileSync(process.execPath, [pnpmCli, "--version"], { encoding: "utf8" }).trim();
if (`pnpm@${version}` !== manifest.packageManager) {
  throw new Error(`Expected ${manifest.packageManager}, received package manager ${version}`);
}

mkdirSync(RUN_ROOT, { recursive: true });
const root = mkdtempSync(join(RUN_ROOT, "offline-cache-preparation-"));
try {
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dsh-wsl-bash-offline-cache-fixture",
    private: true,
    dependencies: manifest.dependencies,
  }, null, 2) + "\n");
  // Reuse exact version exceptions and build policy; no global cooldown bypass.
  writeFileSync(join(root, "pnpm-workspace.yaml"),
    readFileSync(join(PROJECT_ROOT, "pnpm-workspace.yaml"), "utf8") + "\nautoInstallPeers: false\n");
  const npmrc = join(root, "npmrc");
  writeFileSync(npmrc, "# owned cache preparation; no credentials\n");
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_userconfig: npmrc,
  };
  // The isolated CLI does not inherit PNPM_HOME. Use its default store too.
  delete env.PNPM_HOME;
  execFileSync(process.execPath, [pnpmCli, "install", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: root, env, stdio: "inherit", timeout: 180_000, windowsHide: true,
  });
  // Verify the same graph resolves offline without a lockfile or node_modules.
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
  rmSync(join(root, "pnpm-lock.yaml"), { force: true });
  execFileSync(process.execPath, [pnpmCli, "install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: root, env, stdio: "inherit", timeout: 180_000, windowsHide: true,
  });
} finally {
  cleanupOwnedTestRoot(root);
}
