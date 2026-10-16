#!/usr/bin/env node

// Test-only negative contract for release-check's optional --pack-cli input.
// No valid pack command is invoked: every case must fail before typecheck,
// build, install, or pack work begins.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runOutputRoot = join(projectRoot, "测试", "运行产物");
const releaseCheck = join(projectRoot, "scripts", "release-check.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isolatedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_).*$|(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)/i.test(name),
  ));
}

function createFixture(label, manifest = undefined, fileName = "pnpm.mjs") {
  const root = mkdtempSync(join(runOutputRoot, `release-pack-cli-${label}-`));
  const packageRoot = join(root, "node_modules", "pnpm");
  const binRoot = join(packageRoot, "bin");
  mkdirSync(binRoot, { recursive: true });
  const scriptPath = join(binRoot, fileName);
  writeFileSync(scriptPath, "#!/usr/bin/env node\n", "utf8");
  if (manifest !== undefined) {
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  }
  return { root, scriptPath };
}

function runRejectedCase(label, args, expectedText) {
  const result = spawnSync(process.execPath, [releaseCheck, ...args], {
    cwd: projectRoot,
    env: isolatedEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert(result.error === undefined, `${label}: child failed to start: ${result.error?.message}`);
  assert(result.status !== 0, `${label}: invalid input unexpectedly exited 0`);
  assert(output.includes(expectedText), `${label}: expected ${JSON.stringify(expectedText)} in ${JSON.stringify(output.slice(-2000))}`);
  assert(!/security pre-build|typecheck|pack command|temporary profile install/i.test(output),
    `${label}: invalid input reached build/install/pack work`);
  return { label, status: "PASS" };
}

function main() {
  if (process.platform !== "win32") {
    console.log("PACK_CLI_CONTRACT SKIP requires Windows Node");
    process.exitCode = 2;
    return;
  }
  assert(existsSync(releaseCheck), "release-check.mjs is missing");
  const fixtures = [];
  const cases = [];
  try {
    cases.push(runRejectedCase(
      "missing-value",
      ["--pack-cli"],
      "--pack-cli requires an absolute pnpm.mjs path",
    ));
    cases.push(runRejectedCase(
      "duplicate-flag",
      ["--pack-cli", "one", "--pack-cli", "two"],
      "--pack-cli must be supplied once",
    ));
    cases.push(runRejectedCase(
      "relative-path",
      ["--pack-cli", "relative/pnpm.mjs"],
      "--pack-cli requires an absolute Windows path",
    ));

    const missing = createFixture("missing");
    fixtures.push(missing);
    cases.push(runRejectedCase(
      "missing-file",
      ["--pack-cli", join(missing.root, "missing-pnpm.mjs")],
      "--pack-cli path could not be resolved",
    ));

    const wrongName = createFixture("wrong-name", { name: "npm", version: "11.21.0" });
    fixtures.push(wrongName);
    cases.push(runRejectedCase(
      "wrong-name",
      ["--pack-cli", wrongName.scriptPath],
      "--pack-cli package name must be pnpm",
    ));

    const wrongVersion = createFixture("wrong-version", { name: "pnpm", version: "11.25.0" });
    fixtures.push(wrongVersion);
    cases.push(runRejectedCase(
      "wrong-version",
      ["--pack-cli", wrongVersion.scriptPath],
      "--pack-cli version must equal 11.21.0",
    ));

    const missingManifest = createFixture("missing-manifest", undefined);
    fixtures.push(missingManifest);
    cases.push(runRejectedCase(
      "missing-manifest",
      ["--pack-cli", missingManifest.scriptPath],
      "--pack-cli adjacent pnpm package.json is missing",
    ));

    const wrongBasename = createFixture("wrong-basename", { name: "pnpm", version: "11.21.0" }, "pnpm.js");
    fixtures.push(wrongBasename);
    cases.push(runRejectedCase(
      "wrong-basename",
      ["--pack-cli", wrongBasename.scriptPath],
      "--pack-cli must point to a regular pnpm.mjs file",
    ));

    assert(cases.length === 8, `expected 8 negative cases, got ${cases.length}`);
    console.log(`PACK_CLI_CONTRACT ${cases.length} PASS`);
  } finally {
    for (const fixture of fixtures) {
      const normalized = resolve(fixture.root);
      const relativePath = relative(resolve(runOutputRoot), normalized);
      assert(relativePath !== ".." && !relativePath.startsWith("..\\")
        && !relativePath.startsWith("../"), `fixture escaped run output root: ${normalized}`);
      rmSync(normalized, { recursive: true, force: true });
    }
  }
}

main();
