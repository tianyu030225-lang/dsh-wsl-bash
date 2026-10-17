#!/usr/bin/env node

/**
 * Test-only binding for an isolated Desktop GUI fixture.
 *
 * The default remains the historical human fixture and its canonical TGZ. A
 * caller that supplies a candidate path must put that file inside the owned
 * fixture root; this keeps package selection from ever reading a real profile.
 * The helper returns a relative artifact label for evidence and keeps the
 * absolute path private to the launcher/session process.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const RUN_ROOT = join(REPO_ROOT, "测试", "运行产物");
export const OWNED_ROOT = join(RUN_ROOT, "gui-human-canonical-20261010-2340");
export const FIXTURE_ID = "gui-human-canonical-20261010-2340";
// This names the protected historical fixture, not the current release. Fresh
// candidates are always supplied explicitly with their own SHA-256 binding.
export const DEFAULT_TGZ_NAME = "dsh-plugin-bash-wsl-0.2.0.tgz";
export const CANONICAL_TGZ_SHA256 =
  "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
export const FRESH_GUI_CANDIDATE_PATH = join(
  RUN_ROOT,
  "new-modes-pack-20261014-native-protocol-batching",
  DEFAULT_TGZ_NAME,
);
export const FRESH_GUI_CANDIDATE_SHA256 =
  "99aa538370cea3af867ec0de5878a1206966ef60e44b9c3d19843a39dbbc3d33";

function normalizeSha(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex string`);
  }
  return text;
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function classifyGuiCandidateLocation(candidatePath) {
  const candidate = resolve(candidatePath);
  const ownedRoot = realpathSync(OWNED_ROOT);
  const runRoot = realpathSync(RUN_ROOT);
  return {
    insideOwnedFixture: inside(ownedRoot, candidate),
    insideRunArtifacts: inside(runRoot, candidate),
  };
}

function relativeArtifact(root, child) {
  return relative(resolve(root), resolve(child)).replaceAll("\\", "/");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function resolveGuiCandidateBinding({
  requireFreshCandidate = process.env.DSH_GUI_REQUIRE_FRESH_CANDIDATE === "1",
} = {}) {
  if (!existsSync(OWNED_ROOT)) throw new Error("owned GUI fixture root is missing");
  const rootReal = realpathSync(OWNED_ROOT);
  const suppliedPath = process.env.DSH_GUI_CANDIDATE_TGZ
    ?? process.env.DSH_GUI_TGZ_PATH;
  const suppliedValue = typeof suppliedPath === "string" ? suppliedPath.trim() : "";
  const supplied = suppliedValue.length > 0;
  if (supplied && !isAbsolute(suppliedValue)) {
    throw new Error("DSH_GUI_CANDIDATE_TGZ must be an absolute Windows path");
  }
  const candidatePath = supplied
    ? resolve(suppliedValue)
    : process.env.DSH_GUI_TGZ_NAME === undefined && requireFreshCandidate
      ? FRESH_GUI_CANDIDATE_PATH
      : join(OWNED_ROOT, process.env.DSH_GUI_TGZ_NAME ?? DEFAULT_TGZ_NAME);
  if (!isAbsolute(candidatePath)) {
    throw new Error("GUI candidate TGZ must resolve to an absolute Windows path");
  }
  if (!existsSync(candidatePath)) throw new Error("GUI candidate TGZ is missing");
  const candidateReal = realpathSync(candidatePath);
  const candidateInsideOwnedFixture = inside(rootReal, candidateReal);
  const candidateInsideRunArtifacts = inside(realpathSync(RUN_ROOT), candidateReal);
  if (!candidateInsideOwnedFixture && !candidateInsideRunArtifacts) {
    throw new Error("GUI candidate TGZ escaped the owned fixture/run-artifact roots");
  }
  if (!candidateReal.toLowerCase().endsWith(".tgz")) {
    throw new Error("GUI candidate must be a .tgz file");
  }
  const freshRequired = Boolean(requireFreshCandidate || supplied);
  const expected = process.env.DSH_GUI_CANDIDATE_SHA256;
  const expectedSha256 = freshRequired
    ? normalizeSha(expected ?? FRESH_GUI_CANDIDATE_SHA256, "DSH_GUI_CANDIDATE_SHA256")
    : expected === undefined
      ? null
      : normalizeSha(expected, "DSH_GUI_CANDIDATE_SHA256");
  const tgzSha256 = await sha256File(candidateReal);
  const isCanonical = tgzSha256 === CANONICAL_TGZ_SHA256;
  if (freshRequired && isCanonical) {
    throw new Error("fresh GUI candidate must not reuse the protected canonical TGZ");
  }
  if (expectedSha256 !== null && expectedSha256 !== tgzSha256) {
    throw new Error("GUI candidate TGZ SHA-256 does not match DSH_GUI_CANDIDATE_SHA256");
  }
  return {
    path: candidateReal,
    tgzSha256,
    tgzRelativePath: relativeArtifact(
      candidateInsideOwnedFixture ? rootReal : realpathSync(RUN_ROOT),
      candidateReal,
    ),
    candidateLocation: candidateInsideOwnedFixture ? "owned-fixture" : "run-artifacts",
    candidateInsideOwnedFixture,
    candidateInsideRunArtifacts,
    expectedSha256,
    supplied,
    freshRequired,
    isCanonical,
    candidateIndependent: !isCanonical,
  };
}

export async function collectGuiSourceHashes() {
  const files = {
    probe: join(REPO_ROOT, "dev", "测试", "桌面", "new-modes-desktop-artifact.mjs"),
    sessionDriver: join(REPO_ROOT, "dev", "测试", "桌面", "run-owned-gui-session.mjs"),
    launcher: join(REPO_ROOT, "dev", "测试", "桌面", "launch-owned-gui.mjs"),
    wrapper: join(REPO_ROOT, "dev", "测试", "桌面", "run-owned-gui-session-wrapper.mjs"),
    candidateBinding: fileURLToPath(import.meta.url),
  };
  const hashes = {};
  for (const [name, path] of Object.entries(files)) {
    if (!existsSync(path)) throw new Error(`GUI source binding file is missing: ${name}`);
    hashes[name] = await sha256File(path);
  }
  return hashes;
}

