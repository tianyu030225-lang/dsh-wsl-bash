#!/usr/bin/env node

/**
 * Local, non-publishing release gate for dsh-plugin-bash-wsl.
 *
 * The script deliberately does not invoke `npm publish`, `git push`, or mutate
 * a user's host profile. The temporary profile install is local and offline;
 * rc.6 bundles resolve from the installed DSH host, and every result is
 * reported as PASS/FAIL/SKIP.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJsonPath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const expectedName = "dsh-plugin-bash-wsl";
// The plugin's semantic version is independent from the pinned DSH peer line.
const expectedVersion = packageJson.version;
const results = [];
const temporary = mkdtempSync(join(tmpdir(), "dsh-bash-release-"));
const dshHome = join(temporary, "dsh-home");
const dshProfileName = "release-check";
const dshProfileDir = join(dshHome, "profiles", dshProfileName);
mkdirSync(dshProfileDir, { recursive: true });

function record(label, status, detail = "") {
  results.push({ label, status, detail });
  const suffix = detail ? ` — ${detail.replace(/\s+/g, " ").slice(0, 240)}` : "";
  console.log(`${status.padEnd(5)} ${label}${suffix}`);
}

function commandPath(name) {
  const bin = join(root, "node_modules", ".bin", name);
  const candidates = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`] : [bin];
  return candidates.find((candidate) => existsSync(candidate));
}

function isWindowsShim(executable) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./\\:=+-]+$/.test(value)) return value;
  if (/[\r\n\0]/.test(value)) throw new Error("release-check: invalid command argument");
  return `"${value.replace(/(["^])/g, "^$1").replace(/%/g, "^%")}"`;
}

function run(label, executable, args, options = {}) {
  const windowsShim = isWindowsShim(executable);
  const result = spawnSync(
    windowsShim ? process.env.ComSpec ?? "cmd.exe" : executable,
    windowsShim ? ["/d", "/s", "/c", [executable, ...args].map(quoteCmdArg).join(" ")] : args,
    {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    record(label, "FAIL", result.error?.message ?? (output || `exit ${result.status}`));
    return { ok: false, output, result };
  }
  record(label, "PASS", output);
  return { ok: true, output, result };
}

function skip(label, reason) {
  record(label, "SKIP", reason);
}

function plantStaleDistSentinel(path) {
  const distDir = join(root, "dist");
  if (existsSync(distDir)) {
    const distStat = lstatSync(distDir);
    if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
      throw new Error(`refusing to seed stale sentinel in unexpected dist path: ${distDir}`);
    }
  } else {
    mkdirSync(distDir);
  }
  writeFileSync(path, "stale release-check sentinel\n");
}

function removeStaleDistSentinel(path) {
  const distDir = join(root, "dist");
  if (!existsSync(distDir)) return;
  const distStat = lstatSync(distDir);
  if (distStat.isSymbolicLink() || !distStat.isDirectory() || !existsSync(path)) return;
  const sentinelStat = lstatSync(path);
  if (sentinelStat.isSymbolicLink() || !sentinelStat.isFile()) return;
  rmSync(path, { force: true });
}

function assertPackageMetadata() {
  if (packageJson.name !== expectedName) {
    record("package metadata", "FAIL", `name=${packageJson.name}, expected ${expectedName}`);
  } else if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || expectedVersion === "0.1.0-rc.6") {
    record("package metadata", "FAIL", `plugin version must be independent semver, got ${expectedVersion}`);
  } else if (packageJson.engines?.node !== ">=22") {
    record("package metadata", "FAIL", `engines.node=${packageJson.engines?.node}`);
  } else {
    record("package metadata", "PASS", `${expectedName}@${expectedVersion}, Node ${packageJson.engines.node}`);
  }
}

function packageManagerExecutable() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return npm;
}

function inspectTarball(tarball) {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  if (!tarball || !existsSync(tarball)) {
    record("tarball content", "FAIL", "npm pack did not produce a tarball");
    return;
  }
  const result = spawnSync(tar, ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    record("tarball content", "FAIL", result.error?.message ?? result.stderr ?? `exit ${result.status}`);
    return;
  }
  const names = String(result.stdout).split(/\r?\n/).filter(Boolean);
  const forbidden = names.filter((name) =>
    /(?:^|\/)(?:node_modules|coverage|\.env(?:\.|$)|\.git)(?:\/|$)|(?:^|\/)(?:.*password.*|.*secret.*)$/i.test(name),
  );
  const required = [
    "package/README.md",
    "package/README.zh-CN.md",
    "package/SECURITY.md",
    "package/CONTRIBUTING.md",
    "package/CHANGELOG.md",
    "package/NOTICE",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/cordis.patch.yml",
    "package/bin/dsh-bash-wsl.mjs",
  ];
  const staleSentinel = "package/dist/stale-secret.js";
  const unexpectedBinSources = names.filter((name) => /^package\/bin\/.*\.ts$/i.test(name));
  const missing = required.filter((name) => !names.includes(name));
  if (forbidden.length > 0 || missing.length > 0 || names.includes(staleSentinel) || unexpectedBinSources.length > 0) {
    record("tarball content", "FAIL", `forbidden=${forbidden.join(",") || "none"}; missing=${missing.join(",") || "none"}; stale=${names.includes(staleSentinel) ? staleSentinel : "none"}; bin-sources=${unexpectedBinSources.join(",") || "none"}`);
    return;
  }
  record("tarball content", "PASS", `${names.length} files`);
}

try {
  assertPackageMetadata();
  let profileInstalled = false;

  const tsc = commandPath("tsc");
  if (tsc) run("typecheck", tsc, ["-p", "tsconfig.json", "--noEmit"], { timeout: 180_000 });
  else skip("typecheck", "node_modules/.bin/tsc is unavailable; install dependencies through the host workflow");

  const vitest = commandPath("vitest");
  if (vitest) run("tests", vitest, ["run"], { timeout: 180_000 });
  else skip("tests", "node_modules/.bin/vitest is unavailable; install dependencies through the host workflow");

  // Real-environment security regression: PTY geometry and the WSL interop
  // escape block. Requires a live WSL2 distro; SKIP is not a pass.
  const wslAvailability = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (wslAvailability.error || wslAvailability.status !== 0) {
    skip("real security probe (PTY geometry + interop escape)", "wsl.exe unavailable in this host");
  } else {
    const probe = spawnSync(process.execPath, [join(root, "smoke", "security-probe.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
    });
    const probeOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    const geometryOk = /PTY geometry OK/.test(probeOutput);
    const escapeBlocked = /interop escape blocked/.test(probeOutput);
    const probeDone = probeOutput.includes("SECURITY PROBE OK");
    if (probe.error || probe.status !== 0 || !geometryOk || !escapeBlocked || !probeDone) {
      record("real security probe (PTY geometry + interop escape)", "FAIL", (probe.error?.message ?? probeOutput).slice(0, 240));
    } else {
      record("real security probe (PTY geometry + interop escape)", "PASS", "PTY geometry applied; interop escape blocked");
    }
  }

  // Seed a generated-output sentinel before the build. The build must remove
  // the complete old dist tree before tsc writes new output, otherwise a stale
  // file could silently enter the release tarball.
  const staleSentinelPath = join(root, "dist", "stale-secret.js");
  plantStaleDistSentinel(staleSentinelPath);

  // `npm pack --ignore-scripts` intentionally skips lifecycle hooks, so build
  // explicitly before inspecting the release archive. This also works from a
  // clean checkout where dist/ has not been generated yet.
  const npm = packageManagerExecutable();
  const build = run("build", npm, ["run", "build"], { timeout: 180_000 });
  if (!build.ok) {
    record("stale dist cleanup", "FAIL", "build failed before the stale-output sentinel could be validated");
  } else if (existsSync(staleSentinelPath)) {
    record("stale dist cleanup", "FAIL", "build left dist/stale-secret.js behind");
  } else {
    record("stale dist cleanup", "PASS", "build removed the pre-existing dist sentinel");
  }

  // DSH's launcher expects a profile manifest plus an empty user patch. The
  // plugin must be installed into this throw-away profile so its bundle
  // metadata, peer line, and patch layer are exercised together.
  writeFileSync(join(dshProfileDir, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(dshProfileDir, "cordis.yml"), "[]\n");
  writeFileSync(join(dshProfileDir, "package.json"), JSON.stringify({
    name: `dsh-profile-${dshProfileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + "\n");

  const dryRun = run("npm pack --dry-run", npm, ["pack", "--dry-run", "--ignore-scripts"], { timeout: 120_000 });

  const pack = run("npm pack tarball", npm, ["pack", "--ignore-scripts", "--pack-destination", temporary], {
    cwd: root,
    timeout: 120_000,
  });
  // npm's human-readable notice stream differs between npm versions. The
  // package filename itself is deterministic from the metadata we just read.
  const packedName = pack.ok ? `${expectedName}-${expectedVersion}.tgz` : undefined;
  const tarball = packedName ? join(temporary, packedName) : undefined;
  if (pack.ok) {
    inspectTarball(tarball);
  }

  if (tarball && existsSync(tarball)) {
    const profileManifest = {
      name: `dsh-profile-${dshProfileName}`,
      private: true,
      dependencies: {
        [expectedName]: `file:${tarball}`,
      },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", expectedName],
        },
      },
    };
    writeFileSync(join(dshProfileDir, "package.json"), JSON.stringify(profileManifest, null, 2) + "\n");
    const install = run("temporary profile install", npm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--legacy-peer-deps",
      tarball,
    ], { cwd: dshProfileDir, timeout: 180_000 });
    if (install.ok) {
      const installed = existsSync(join(dshProfileDir, "node_modules", expectedName));
      if (installed) {
        profileInstalled = true;
        record("temporary profile package presence", "PASS", expectedName);
      }
      else record("temporary profile package presence", "FAIL", "package directory was not created");
      const dumpManifest = readFileSync(join(dshProfileDir, "package.json"), "utf8");
      if (!dumpManifest.includes(`"${expectedName}"`)) {
        record("temporary profile manifest", "FAIL", `${expectedName} dependency missing after install`);
      }
    }
  } else {
    skip("temporary profile install", "no tarball was created");
  }

  const dsh = process.env.DSH_BIN || (process.platform === "win32" ? "dsh.cmd" : "dsh");
  if (!profileInstalled) {
    skip("dsh --dump-config", "temporary profile install did not pass");
  } else {
    const dshProbe = run("dsh --dump-config", dsh, ["--profile", dshProfileName, "--dump-config"], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PROFILE: dshProfileName,
    },
    timeout: 60_000,
    });
    if (!dshProbe.ok && dshProbe.result.error?.code === "ENOENT") {
      skip("dsh --dump-config", "DSH executable is unavailable in this host; this is not a pass");
    } else if (dshProbe.ok) {
      const dump = dshProbe.output;
    const requiredRows = [
      "# == dsh-plugin-bash-wsl",
      "name: '@deepseek-ai/dsh-terminal'",
      "name: dsh-plugin-bash-wsl",
      "name: '@deepseek-ai/dsh-tool-bash-persistent'",
      "name: '@deepseek-ai/dsh-tool-pwsh'",
    ];
    const missingRows = requiredRows.filter((row) => !dump.includes(row));
    const windowsShellGuards =
      "name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'";
    const windowsPwshGuard =
      "name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'";
      if (missingRows.length > 0 || !dump.includes(windowsShellGuards) || !dump.includes(windowsPwshGuard)) {
        if (!dump.includes(windowsShellGuards)) missingRows.push("Windows tool-bash disabled guard");
        if (!dump.includes(windowsPwshGuard)) missingRows.push("Windows tool-pwsh guard");
        record("dsh --dump-config", "FAIL", `missing bundle rows: ${missingRows.join(", ")}`);
      }
    }
  }

  if (process.platform !== "win32") {
    skip("dsh real activation", "requires the Windows Node host; WSL process.platform=linux disables this plugin");
  } else {
    const activation = run("dsh real activation", dsh, ["--profile", dshProfileName, "--help"], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_PROFILE: dshProfileName,
        DSH_TELEMETRY_DISABLED: "1",
      },
      timeout: 60_000,
    });
    if (activation.ok && !/Usage: dsh --profile headless/.test(activation.output)) {
      record("dsh real activation", "FAIL", "host returned success but headless initialization help was not mounted");
    }
  }
} finally {
  removeStaleDistSentinel(join(root, "dist", "stale-secret.js"));
  rmSync(temporary, { recursive: true, force: true });
}

const failed = results.filter((entry) => entry.status === "FAIL").length;
const skipped = results.filter((entry) => entry.status === "SKIP").length;
console.log(`\nRelease check: ${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
if (skipped > 0) console.log("Skipped checks are not passes; run the gate again on the required host capabilities before release.");
process.exitCode = failed > 0 || skipped > 0 ? 1 : 0;
