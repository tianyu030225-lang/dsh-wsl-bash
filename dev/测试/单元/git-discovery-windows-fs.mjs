import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, win32 } from "node:path";

import {
  canonicalGitBashPath,
  gitBashCandidates,
  rejectUnsafeWindowsPath,
  resolveGitBashPath,
} from "../../../dist/discovery/git-bash.js";

if (process.platform !== "win32") {
  throw new Error("Windows Node required; no filesystem work");
}

const repoRoot = win32.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const reportDir = join(repoRoot, "测试", "运行产物");
const startedAt = new Date().toISOString();
const runToken = `${Date.now()}-${process.pid}`;
const reportPath = join(reportDir, `git-discovery-windows-fs-${runToken}.json`);
const rawPath = join(reportDir, `git-discovery-windows-fs-${runToken}.jsonl`);
const fixtureRoot = join(reportDir, `git-discovery-windows-fs-fixture-${runToken}`);
const expectedCandidateSha256 =
  "99aa538370cea3af867ec0de5878a1206966ef60e44b9c3d19843a39dbbc3d33";
const expectedCliSha256 =
  "dbb4a7c1d88c412278fc8baccac7553f6d2310e85f5ffea1470a30106e99c688";
const expectedCliVersion = "0.2.1-alpha.1";
const candidateTgzPath = process.env.DSH_PLUGIN_TGZ?.trim() || undefined;
const cliPackagePath =
  process.env.DSH_CLI_PACKAGE_PATH?.trim() ||
  (process.env.APPDATA?.trim()
    ? join(process.env.APPDATA.trim(), "npm", "node_modules", "@deepseek-ai", "dsh", "package.json")
    : undefined);

const cases = [];
const rawEvents = [];
const linkPaths = [];
let failureCount = 0;
let skipCount = 0;
let fixtureCreated = false;
let gitSourcePath;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function record(id, status, evidence = {}, error = undefined) {
  const row = {
    at: new Date().toISOString(),
    id,
    status,
    evidence,
  };
  if (error !== undefined) row.error = errorText(error);
  cases.push(row);
  rawEvents.push(row);
  if (status === "FAIL") failureCount += 1;
  if (status === "SKIP" || status === "N/A") skipCount += 1;
  return row;
}

function runCase(id, callback) {
  try {
    return record(id, "PASS", callback());
  } catch (error) {
    return record(id, "FAIL", {}, error);
  }
}

function skipCase(id, evidence) {
  return record(id, "SKIP", evidence);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function optionalFileHash(path) {
  try {
    return { exists: true, sha256: sha256File(path) };
  } catch (error) {
    return { exists: false, error: errorText(error) };
  }
}

function stripLocalExtendedPrefix(value) {
  const match = /^\\\\\?\\([A-Za-z]:\\.*)$/.exec(value);
  return match?.[1] ?? value;
}

function canonicalFsPath(path) {
  return win32.normalize(stripLocalExtendedPrefix(realpathSync.native(path)));
}

function sameWindowsPath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function assertResolved(actual, expected, label) {
  assertCondition(
    sameWindowsPath(actual, canonicalFsPath(expected)),
    `${label}: expected ${canonicalFsPath(expected)}, received ${actual}`,
  );
}

function expectThrow(callback, label) {
  try {
    callback();
  } catch (error) {
    return { threw: true, error: errorText(error) };
  }
  throw new Error(`${label}: expected rejection`);
}

function copyGitBash(targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(gitSourcePath, targetPath);
  return {
    path: targetPath,
    size: statSync(targetPath).size,
    isFile: statSync(targetPath).isFile(),
  };
}

function baseEnv(overrides = {}) {
  return {
    ProgramFiles: join(fixtureRoot, "无效 Program Files"),
    ProgramW6432: join(fixtureRoot, "无效 ProgramW6432"),
    "ProgramFiles(x86)": join(fixtureRoot, "无效 Program Files x86"),
    LOCALAPPDATA: join(fixtureRoot, "无效 LocalAppData"),
    USERPROFILE: join(fixtureRoot, "无效 UserProfile"),
    PATH: "",
    ...overrides,
  };
}

function isContainedChild(parent, child) {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel);
}

function findInstalledGitBash() {
  const programFiles = process.env.ProgramFiles ?? String.raw`C:\Program Files`;
  const programW6432 = process.env.ProgramW6432 ?? programFiles;
  const programFiles86 = process.env["ProgramFiles(x86)"] ?? String.raw`C:\Program Files (x86)`;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    join(programFiles, "Git", "bin", "bash.exe"),
    join(programW6432, "Git", "bin", "bash.exe"),
    join(programFiles86, "Git", "bin", "bash.exe"),
    ...(localAppData ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
    String.raw`C:\Program Files\Git\usr\bin\bash.exe`,
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through known local Git-for-Windows locations only.
    }
  }
  return undefined;
}

const sourceHash = optionalFileHash(join(repoRoot, "src", "discovery", "git-bash.ts"));
const distHash = optionalFileHash(join(repoRoot, "dist", "discovery", "git-bash.js"));
const candidateHash = optionalFileHash(candidateTgzPath);
const cliHash = optionalFileHash(cliPackagePath);
let cliMetadata;
try {
  cliMetadata = JSON.parse(readFileSync(cliPackagePath, "utf8"));
} catch (error) {
  cliMetadata = { error: errorText(error) };
}

try {
  mkdirSync(reportDir, { recursive: true });
  assertCondition(process.platform === "win32", `expected Windows Node process.platform, got ${process.platform}`);
  assertCondition(!existsSync(fixtureRoot), `refusing to reuse existing fixture: ${fixtureRoot}`);
  mkdirSync(fixtureRoot, { recursive: true });
  fixtureCreated = true;

  runCase("BIND-01 runtime and frozen artifacts", () => {
    assertCondition(process.platform === "win32", "Windows Node runtime required");
    assertCondition(/\\node\.exe$/i.test(process.execPath), `unexpected Node executable: ${process.execPath}`);
    assertCondition(sourceHash.exists, `source discovery module missing: ${sourceHash.error ?? "unknown error"}`);
    assertCondition(distHash.exists, `dist discovery module missing: ${distHash.error ?? "unknown error"}`);
    assertCondition(candidateHash.exists, `candidate TGZ missing: ${candidateTgzPath}`);
    assertCondition(candidateHash.sha256 === expectedCandidateSha256, "candidate TGZ SHA mismatch");
    assertCondition(cliHash.exists, `CLI package anchor missing: ${cliPackagePath}`);
    assertCondition(cliHash.sha256 === expectedCliSha256, "CLI package SHA mismatch");
    assertCondition(cliMetadata.version === expectedCliVersion, `CLI version mismatch: ${cliMetadata.version}`);
    return {
      processPlatform: process.platform,
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      cliVersion: cliMetadata.version,
      cliPackagePath,
      cliPackageSha256: cliHash.sha256,
      candidateTgzPath,
      candidateTgzSha256: candidateHash.sha256,
      sourceSha256: sourceHash.sha256,
      distSha256: distHash.sha256,
      fsInjection: false,
      discoveryMock: false,
      childProcessApiImported: false,
      spawnedBashDshWsl: 0,
      executedCopiedFile: false,
    };
  });

  gitSourcePath = findInstalledGitBash();
  if (gitSourcePath === undefined) {
    skipCase("SOURCE-01 installed Git Bash copy source", {
      status: "N/A",
      reason: "No installed local Git for Windows bash.exe found in known paths",
      discoveryOnly: true,
      noFallbackToOtherTool: true,
    });
  } else {
    runCase("SOURCE-01 installed Git Bash copy source", () => ({
      gitSourcePath,
      isFile: statSync(gitSourcePath).isFile(),
      size: statSync(gitSourcePath).size,
      sourceSha256: sha256File(gitSourcePath),
      copiedOnlyForFsChecks: true,
      executed: false,
    }));

    const paths = {
      normal: join(fixtureRoot, "中文 空格路径", "Git", "bin", "bash.exe"),
      explicit: join(fixtureRoot, "显式 优先", "bash.exe"),
      config: join(fixtureRoot, "配置 优先", "bash.exe"),
      configLower: join(fixtureRoot, "配置较低优先", "bash.exe"),
      env: join(fixtureRoot, "环境变量 优先", "bash.exe"),
      expanded: join(fixtureRoot, "展开 中文 路径", "bash.exe"),
      defaultFirst: join(fixtureRoot, "默认一", "Git", "bin", "bash.exe"),
      defaultSecond: join(fixtureRoot, "默认二", "Git", "bin", "bash.exe"),
      invalidDirectory: join(fixtureRoot, "invalid directory bash.exe"),
      wrongExtension: join(fixtureRoot, "invalid extension", "not-bash.cmd"),
      missing: join(fixtureRoot, "missing", "bash.exe"),
    };

    for (const path of [
      paths.normal,
      paths.explicit,
      paths.config,
      paths.configLower,
      paths.env,
      paths.expanded,
      paths.defaultFirst,
      paths.defaultSecond,
    ]) copyGitBash(path);
    mkdirSync(paths.invalidDirectory, { recursive: true });
    mkdirSync(dirname(paths.wrongExtension), { recursive: true });
    copyFileSync(gitSourcePath, paths.wrongExtension);

    runCase("FS-01 Chinese-space path and realpath", () => {
      const expected = canonicalFsPath(paths.normal);
      const resolved = canonicalGitBashPath(paths.normal);
      assertResolved(resolved, paths.normal, "normal local path");
      return {
        input: paths.normal,
        nativeRealpath: realpathSync.native(paths.normal),
        resolved,
        expected,
        executed: false,
      };
    });

    runCase("PRIORITY-01 explicit over config and env", () => {
      const env = baseEnv({ dSh_GiT_BaSh_PaTh: paths.env });
      const resolved = resolveGitBashPath(paths.explicit, {
        platform: "win32",
        config: { gitBashPath: paths.config },
        env,
      });
      assertResolved(resolved, paths.explicit, "explicit override");
      return { resolved, explicit: paths.explicit, config: paths.config, env: paths.env };
    });

    runCase("PRIORITY-02 config over environment", () => {
      const env = baseEnv({ dSh_GiT_BaSh_PaTh: paths.env });
      const resolved = resolveGitBashPath(undefined, {
        platform: "win32",
        config: { gitBashPath: paths.config, gitBashExecutable: paths.configLower },
        env,
      });
      assertResolved(resolved, paths.config, "config override");
      return { resolved, configGitBashPath: paths.config, configGitBashExecutable: paths.configLower, env: paths.env };
    });

    runCase("PRIORITY-03 case-insensitive environment key", () => {
      const env = baseEnv({ dSh_GiT_BaSh_PaTh: paths.env });
      const resolved = resolveGitBashPath(undefined, { platform: "win32", env });
      assertResolved(resolved, paths.env, "case-insensitive DSH_GIT_BASH_PATH");
      return { envKey: "dSh_GiT_BaSh_PaTh", resolved };
    });

    runCase("PRIORITY-04 environment expansion and case", () => {
      const relativeExpanded = win32.relative(fixtureRoot, paths.expanded);
      const env = baseEnv({ dSh_Discovery_Root: fixtureRoot });
      const configured = `%DSH_DISCOVERY_ROOT%\\${relativeExpanded}`;
      const resolved = resolveGitBashPath(undefined, {
        platform: "win32",
        config: { executable: configured },
        env,
      });
      assertResolved(resolved, paths.expanded, "expanded config path");
      return { envKey: "dSh_Discovery_Root", configured, expandedTo: resolved };
    });

    runCase("DEFAULT-01 ordered local roots", () => {
      const env = baseEnv({
        ProgramFiles: join(fixtureRoot, "默认一"),
        ProgramW6432: join(fixtureRoot, "默认二"),
        "ProgramFiles(x86)": join(fixtureRoot, "默认三"),
        LOCALAPPDATA: join(fixtureRoot, "默认 LocalAppData"),
        USERPROFILE: join(fixtureRoot, "默认 UserProfile"),
        GIT_INSTALL_ROOT: join(fixtureRoot, "默认 GitInstallRoot"),
        PATH: join(fixtureRoot, "默认 PATH", "bin"),
      });
      const candidates = gitBashCandidates(env);
      assertCondition(candidates.length > 1, "expected multiple ordered candidates");
      assertCondition(sameWindowsPath(candidates[0], paths.defaultFirst), `first candidate mismatch: ${candidates[0]}`);
      const resolved = resolveGitBashPath(undefined, { platform: "win32", env });
      assertResolved(resolved, paths.defaultFirst, "ordered root selection");
      return { firstCandidates: candidates.slice(0, 4), resolved, selectedBy: "ProgramFiles root before ProgramW6432" };
    });

    runCase("DEFAULT-02 PATH arbitrary bare bash is not selected", () => {
      const arbitraryBash = join(fixtureRoot, "arbitrary PATH", "bash.exe");
      const copied = copyGitBash(arbitraryBash);
      assertCondition(existsSync(arbitraryBash) && statSync(arbitraryBash).isFile(), "arbitrary PATH bash fixture was not created");
      const env = baseEnv({
        PATH: `${dirname(arbitraryBash)};${join(fixtureRoot, "plain PATH", "bash.exe")}`,
      });
      const candidates = gitBashCandidates(env);
      assertCondition(!candidates.some((candidate) => sameWindowsPath(candidate, arbitraryBash)), "arbitrary PATH bash.exe was selected");
      const rejected = expectThrow(
        () => resolveGitBashPath(undefined, { platform: "win32", env }),
        "arbitrary PATH discovery",
      );
      return { arbitraryBash, copied, fixtureExists: existsSync(arbitraryBash), isFile: statSync(arbitraryBash).isFile(), candidates, rejected };
    });

    runCase("INVALID-01 explicit invalid does not fall back", () => {
      const env = baseEnv({ dSh_GiT_BaSh_PaTh: paths.env });
      const rejected = expectThrow(
        () => resolveGitBashPath(paths.invalidDirectory, { platform: "win32", env }),
        "invalid explicit override",
      );
      return { explicit: paths.invalidDirectory, fallbackEnvironment: paths.env, rejected };
    });

    runCase("INVALID-02 directory, missing, and wrong extension", () => {
      const rejected = {};
      for (const [label, path] of Object.entries({
        directoryNamedBashExe: paths.invalidDirectory,
        missingBashExe: paths.missing,
        wrongExtension: paths.wrongExtension,
      })) rejected[label] = expectThrow(() => canonicalGitBashPath(path), label);
      return { paths: { directoryNamedBashExe: paths.invalidDirectory, missingBashExe: paths.missing, wrongExtension: paths.wrongExtension }, rejected };
    });

    runCase("INVALID-03 UNC device drive-relative and NUL", () => {
      const unsafe = {
        unc: String.raw`\\server\share\bash.exe`,
        deviceQuestion: String.raw`\\?\C:\Windows\System32\bash.exe`,
        deviceDot: String.raw`\\.\C:\Windows\System32\bash.exe`,
        ntDevice: String.raw`\??\C:\Windows\System32\bash.exe`,
        driveRelative: String.raw`C:relative\bash.exe`,
        relative: String.raw`relative\bash.exe`,
        nul: `${paths.normal}\0`,
      };
      const rejected = {};
      for (const [label, path] of Object.entries(unsafe)) {
        rejected[label] = {
          direct: expectThrow(() => rejectUnsafeWindowsPath(path), `${label} direct rejection`),
          canonical: expectThrow(() => canonicalGitBashPath(path), `${label} canonical rejection`),
        };
      }
      return { unsafe, rejected };
    });

    const symlinkAlias = join(fixtureRoot, "符号链接 alias", "bash.exe");
    try {
      mkdirSync(dirname(symlinkAlias), { recursive: true });
      symlinkSync(paths.normal, symlinkAlias, "file");
      linkPaths.push(symlinkAlias);
      runCase("REALPATH-02 file symlink canonicalization", () => {
        const resolved = canonicalGitBashPath(symlinkAlias);
        assertResolved(resolved, paths.normal, "file symlink target");
        return { alias: symlinkAlias, target: paths.normal, resolved, executed: false };
      });
    } catch (error) {
      const code = error?.code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        skipCase("REALPATH-02 file symlink canonicalization", {
          status: "N/A",
          capability: "Windows file symlink creation unavailable",
          code,
          error: errorText(error),
          noAclChange: true,
          noFallback: true,
        });
      } else {
        record("REALPATH-02 file symlink canonicalization", "FAIL", {}, error);
      }
    }

    const junctionRoot = join(fixtureRoot, "junction-target");
    const junctionAlias = join(fixtureRoot, "junction alias");
    try {
      mkdirSync(junctionRoot, { recursive: true });
      copyFileSync(gitSourcePath, join(junctionRoot, "bash.exe"));
      symlinkSync(junctionRoot, junctionAlias, "junction");
      linkPaths.push(junctionAlias);
      runCase("REALPATH-03 junction canonicalization", () => {
        const candidate = join(junctionAlias, "bash.exe");
        const resolved = canonicalGitBashPath(candidate);
        assertResolved(resolved, join(junctionRoot, "bash.exe"), "junction target");
        return { alias: candidate, target: join(junctionRoot, "bash.exe"), resolved, executed: false };
      });
    } catch (error) {
      const code = error?.code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        skipCase("REALPATH-03 junction canonicalization", {
          status: "N/A",
          capability: "Windows junction creation unavailable",
          code,
          error: errorText(error),
          noAclChange: true,
          noFallback: true,
        });
      } else {
        record("REALPATH-03 junction canonicalization", "FAIL", {}, error);
      }
    }
  }
} catch (error) {
  record("HARNESS-01 unexpected setup failure", "FAIL", {}, error);
} finally {
  const cleanup = {
    attempted: false,
    containmentChecked: isContainedChild(reportDir, fixtureRoot),
    removed: false,
    fixtureExistsAfter: undefined,
    errors: [],
  };
  cleanup.attempted = true;
  for (const linkPath of [...linkPaths].reverse()) {
    try {
      if (existsSync(linkPath)) unlinkSync(linkPath);
    } catch (error) {
      cleanup.errors.push({ path: linkPath, error: errorText(error) });
    }
  }
  if (fixtureCreated && cleanup.containmentChecked) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      cleanup.removed = true;
    } catch (error) {
      cleanup.errors.push({ path: fixtureRoot, error: errorText(error) });
    }
  } else if (fixtureCreated) {
    cleanup.errors.push({ path: fixtureRoot, error: "fixture containment check failed; deletion refused" });
  }
  cleanup.fixtureExistsAfter = existsSync(fixtureRoot);

  cleanup.satisfied = fixtureCreated
    ? cleanup.containmentChecked && cleanup.removed && cleanup.fixtureExistsAfter === false && cleanup.errors.length === 0
    : cleanup.fixtureExistsAfter === false && cleanup.errors.length === 0;
  if (cleanup.satisfied) {
    record("CLEANUP-01 fixture containment and residue", "PASS", cleanup);
  } else {
    record(
      "CLEANUP-01 fixture containment and residue",
      "FAIL",
      cleanup,
      new Error("owned fixture cleanup did not satisfy containment/removal/residue requirements"),
    );
  }

  const status = failureCount > 0 ? "FAIL" : skipCount > 0 ? "SKIP" : "PASS";
  const report = {
    schemaVersion: 1,
    suite: "git-discovery-windows-fs",
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    runtime: {
      processPlatform: process.platform,
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      processId: process.pid,
      parentProcessId: process.ppid,
      childProcessApiImported: false,
      spawnedBashDshWsl: 0,
      executedCopiedFile: false,
      DSHInvoked: false,
      GitInvoked: false,
      WslInvoked: false,
    },
    binding: {
      source: { path: join(repoRoot, "src", "discovery", "git-bash.ts"), ...sourceHash },
      dist: { path: join(repoRoot, "dist", "discovery", "git-bash.js"), ...distHash },
      candidateTgz: { path: candidateTgzPath, ...candidateHash, expectedSha256: expectedCandidateSha256 },
      cliPackage: { path: cliPackagePath, ...cliHash, version: cliMetadata.version, expectedVersion: expectedCliVersion, expectedSha256: expectedCliSha256 },
      gitSourcePath,
      testUsesFsInjection: false,
      testMocksDiscovery: false,
      testExecutesGitBash: false,
    },
    fixture: {
      root: fixtureRoot,
      reportDir,
      containmentChecked: cleanup.containmentChecked,
      cleanup,
    },
    cases,
    counts: {
      pass: cases.filter((row) => row.status === "PASS").length,
      fail: cases.filter((row) => row.status === "FAIL").length,
      skip: skipCount,
    },
    capabilityNotes: [
      "Copied installed bash.exe bytes into private fixtures; no copied executable was launched.",
      "Windows access/stat results are filesystem checks only; this test does not claim POSIX execute-bit or PE-signature validation.",
      "Symlink/junction permission failures are recorded as SKIP/N/A without ACL changes or fallback claims.",
      "This is Windows Node real-FS discovery evidence, not DSH tool or host end-to-end evidence.",
    ],
  };
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(rawPath, `${rawEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  } catch (error) {
    console.error(`REPORT_WRITE_FAIL ${errorText(error)}`);
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ status, reportPath, rawPath, counts: report.counts, cleanup: cleanup }, null, 2));
  if (status === "FAIL") process.exitCode = 1;
}
