/**
 * Test-only orchestration for the opt-in native-mode release gate.
 * The existing release-check script supplies the gate's isolated environment,
 * protected artifact paths, and process-tree cleanup helper; this module owns
 * only candidate/backend/GUI evidence binding.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  validateNativeModesCliEvidence,
  validateNativeModesDesktopEvidence,
  validateNativeModesGuiRosterEvidence,
} from "./native-modes-release-validator.mjs";

function addResult(results, label, status, detail) {
  results.push({ label, status, detail });
}

function readProbeEvidence(root, runOutputRoot, output) {
  const evidenceText = /Evidence:\s*(.+)\s*$/im.exec(output)?.[1]?.trim();
  if (evidenceText === undefined) return undefined;
  try {
    const evidencePath = resolve(root, evidenceText);
    const outputRoot = realpathSync(runOutputRoot);
    const evidenceRealPath = realpathSync(evidencePath);
    const evidenceRelative = relative(outputRoot, evidenceRealPath);
    const escaped = evidenceRelative === ".."
      || evidenceRelative.startsWith(`..${evidenceRealPath.includes("\\") ? "\\" : "/"}`)
      || isAbsolute(evidenceRelative);
    if (escaped || evidenceRelative.length === 0 || !existsSync(evidenceRealPath)) return undefined;
    return JSON.parse(readFileSync(evidenceRealPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function runNativeModesReleaseGate(options) {
  const {
    candidateInput,
    cliNativeInput,
    guiRosterInput,
    tarball,
    rootTgz,
    root,
    runOutputRoot,
    expectedAsarSha256,
    expectedExecutableSha256,
    expectedCliVersion,
    expectedCliPackageSha256,
    cliProbeSourceSha256,
      cliProbeObserverSha256,
    nativeModesDesktopProbePath,
    desktopPaths,
    securityStatus,
    cliStatus,
    platform,
    fileSha256,
    cleanupSpawnTree,
    environment,
  } = options;
  const results = [];
  const candidatePath = candidateInput.path;
  const candidateSha256 = fileSha256(candidatePath);
  const candidateIndependent = candidatePath !== resolve(rootTgz)
    && (tarball === undefined || candidatePath !== resolve(tarball))
    && candidateSha256 !== "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
  addResult(results, "new native modes candidate TGZ input", candidateIndependent ? "PASS" : "FAIL",
    candidateIndependent
      ? `independent candidate ${candidateInput.relativePath}, SHA-256 ${candidateSha256}`
      : "candidate must be independent of the protected root canonical 9cb TGZ");

  if (cliNativeInput?.kind === "missing") {
    addResult(results, "new native modes fresh CLI native evidence", "SKIP",
      "no --native-modes-cli-evidence was supplied; old generic/tool-only CLI evidence cannot qualify the new native modes");
  } else if (cliNativeInput?.kind === "invalid") {
    addResult(results, "new native modes fresh CLI native evidence", "FAIL", cliNativeInput.detail);
  } else {
    let cliEvidence;
    try { cliEvidence = JSON.parse(readFileSync(cliNativeInput.path, "utf8")); }
    catch (error) {
      addResult(results, "new native modes fresh CLI native evidence", "FAIL",
        `fresh CLI native evidence JSON could not be read: ${error.message}`);
    }
    if (cliEvidence !== undefined) {
      const cliAudit = validateNativeModesCliEvidence(cliEvidence, {
        candidateSha256,
        cliProbeSourceSha256,
          cliProbeObserverSha256,
        expectedCliVersion,
        expectedCliPackageSha256,
      });
      addResult(results, "new native modes fresh CLI native evidence", cliAudit.ok ? "PASS" : "FAIL", cliAudit.detail);
    }
  }

  const finalExists = tarball !== undefined && existsSync(tarball);
  const finalSha256 = finalExists ? fileSha256(tarball) : undefined;
  const candidateFinalIdentityOk = candidateIndependent
    && finalExists
    && candidateSha256 === finalSha256
    && readFileSync(candidatePath).byteLength === readFileSync(tarball).byteLength;

  const freshNativeCliStatus = results.find((result) => result.label === "new native modes fresh CLI native evidence")?.status;
  const freshCliCoreOk = securityStatus === "PASS"
    && cliStatus === "PASS"
    && freshNativeCliStatus === "PASS";
  const candidateDesktopCapability = platform === "win32"
    && existsSync(nativeModesDesktopProbePath)
    && existsSync(desktopPaths?.asar ?? "")
    && existsSync(desktopPaths?.executable ?? "");
  if (!candidateIndependent || !candidateFinalIdentityOk || !freshCliCoreOk) {
    addResult(results, "new native modes Desktop backend qualification", "FAIL",
      `candidate/final=${candidateFinalIdentityOk ? "match" : "mismatch"}; fresh security/CLI/native-CLI=${freshCliCoreOk ? "PASS" : "missing"}`);
  } else if (!candidateDesktopCapability) {
    addResult(results, "new native modes Desktop backend qualification", "SKIP",
      "actual Windows rc.3 Desktop executable/app.asar or native-mode probe is unavailable");
  } else {
    const nativeModesProbe = spawnSync(process.execPath, [nativeModesDesktopProbePath, "--tgz", candidatePath], {
      cwd: root,
      encoding: "utf8",
      timeout: 900_000,
      windowsHide: true,
      env: environment,
    });
    const nativeModesProbeCleanup = cleanupSpawnTree(nativeModesProbe);
    const nativeModesProbeOutput = `${nativeModesProbe.stdout ?? ""}${nativeModesProbe.stderr ?? ""}`.trim();
    const nativeModesSummary = /New native modes Desktop probe:\s+(\d+) passed,\s+(\d+) skipped,\s+(\d+) failed/i.exec(nativeModesProbeOutput);
    const nativeModesEvidence = readProbeEvidence(root, runOutputRoot, nativeModesProbeOutput);
    const nativeModesAudit = validateNativeModesDesktopEvidence(nativeModesEvidence, {
      candidateSha256,
      probeSourceSha256: fileSha256(nativeModesDesktopProbePath),
      expectedAsarSha256,
      expectedExecutableSha256,
    });
    const nativeModesComplete = nativeModesProbe.status === 0
      && nativeModesProbe.error === undefined
      && nativeModesProbeCleanup?.reaped !== false
      && nativeModesSummary?.[2] === "0"
      && nativeModesSummary?.[3] === "0"
      && nativeModesAudit.ok;
    addResult(results, "new native modes Desktop backend qualification", nativeModesComplete ? "PASS" : "FAIL",
      nativeModesComplete
        ? `${nativeModesSummary[0]}; candidate/final SHA ${candidateSha256}; strict scoped mode, prompt, lifecycle, unload, and cleanup evidence matched`
        : nativeModesProbeCleanup?.reaped === false
          ? "native-mode Desktop child timeout/reaping was not proven"
          : `native-mode Desktop evidence incomplete: summary=${nativeModesSummary?.[0] ?? "missing"}; ${nativeModesAudit.detail}`);
  }

  if (guiRosterInput.kind === "missing") {
    addResult(results, "new native modes independent GUI roster", "SKIP",
      "no --native-modes-gui-roster was supplied; headless Desktop backend evidence cannot substitute for GUI mode visibility");
  } else if (guiRosterInput.kind === "invalid") {
    addResult(results, "new native modes independent GUI roster", "FAIL", guiRosterInput.detail);
  } else {
    let guiRosterEvidence;
    try { guiRosterEvidence = JSON.parse(readFileSync(guiRosterInput.path, "utf8")); } catch (error) {
      addResult(results, "new native modes independent GUI roster", "FAIL", `GUI roster evidence JSON could not be read: ${error.message}`);
    }
    if (guiRosterEvidence !== undefined) {
      const driverSourceFiles = {
        probe: "dev/测试/桌面/new-modes-desktop-artifact.mjs",
        sessionDriver: "dev/测试/桌面/run-owned-gui-session.mjs",
        launcher: "dev/测试/桌面/launch-owned-gui.mjs",
        wrapper: "dev/测试/桌面/run-owned-gui-session-wrapper.mjs",
        candidateBinding: "dev/测试/桌面/gui-candidate-binding.mjs",
      };
      const driverSourceHashes = Object.fromEntries(
        Object.entries(driverSourceFiles).map(([name, relativePath]) => {
          const sourcePath = resolve(root, relativePath);
          return [name, existsSync(sourcePath) ? fileSha256(sourcePath) : undefined];
        }),
      );
      const guiRosterAudit = validateNativeModesGuiRosterEvidence(guiRosterEvidence, {
        candidateSha256,
        expectedAsarSha256,
        expectedExecutableSha256,
        root,
        runOutputRoot,
        fileSha256,
        driverSourceHashes,
        nativeProbeSourceSha256: existsSync(nativeModesDesktopProbePath)
          ? fileSha256(nativeModesDesktopProbePath)
          : undefined,
      });
      addResult(results, "new native modes independent GUI roster", guiRosterAudit.ok ? "PASS" : "FAIL", guiRosterAudit.detail);
    }
  }
  return results;
}
