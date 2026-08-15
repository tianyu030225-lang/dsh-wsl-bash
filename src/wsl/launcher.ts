import { posix, win32 } from "node:path";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";

import type { ResolvedPluginConfig, WslExecutionBoundary, WslLaunchPlan } from "../types.js";
import { resolveWslExecutable } from "../discovery/wsl.js";

const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[?.]\\|\\\?\?\\|\/\/[?.]\/)/;
const WINDOWS_UNC_PREFIX = /^(?:\\\\|\/\/)/;
const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/s;

function canonicalWslPath(name: string, value: string): string {
  assertNoNul(name, value);
  if (value.trim().length === 0 || /[\r\n]/.test(value) || !value.startsWith("/")) {
    throw new Error(`dsh-plugin-bash-wsl: ${name} must be an absolute single-line WSL path`);
  }
  const normalized = posix.normalize(value);
  if (!normalized.startsWith("/")) {
    throw new Error(`dsh-plugin-bash-wsl: ${name} must remain absolute`);
  }
  return normalized;
}

function isInsideWslRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function assertNoNul(name: string, value: string): void {
  if (value.includes("\0")) {
    throw new Error(`dsh-plugin-bash-wsl: ${name} must not contain NUL bytes`);
  }
}

function assertSandboxMode(mode: WslExecutionBoundary["mode"]): void {
  if (mode !== "read-only" && mode !== "workspace-write" && mode !== "danger-full-access") {
    throw new Error(`dsh-plugin-bash-wsl: unsupported sandbox mode: ${JSON.stringify(mode)}`);
  }
}

function assertSafeWorkspaceRoot(workspaceRoot: string): string {
  assertNoNul("workspaceRoot", workspaceRoot);
  const trimmed = workspaceRoot.trim();
  if (trimmed.length === 0) {
    throw new Error("dsh-plugin-bash-wsl: workspaceRoot must be non-empty");
  }
  if (WINDOWS_DEVICE_PREFIX.test(trimmed) || WINDOWS_UNC_PREFIX.test(trimmed)) {
    throw new Error("dsh-plugin-bash-wsl: workspaceRoot must be a local Windows drive path");
  }
  const match = WINDOWS_DRIVE_PATH.exec(trimmed);
  if (match === null) {
    throw new Error("dsh-plugin-bash-wsl: workspaceRoot must be an absolute Windows drive path");
  }

  const resolved = win32.resolve(trimmed);
  const canonical = win32.normalize(canonicalPath(resolved));
  const parsed = win32.parse(canonical);
  if (canonical === parsed.root) {
    throw new Error("dsh-plugin-bash-wsl: a drive root cannot be a writable workspace");
  }
  const relative = canonical.slice(parsed.root.length).replace(/[\\/]+$/, "");
  const relativeSegments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (
    relativeSegments.length > 0 &&
    relativeSegments.length <= 2 &&
    relativeSegments[0]?.toLowerCase() === "users"
  ) {
    throw new Error("dsh-plugin-bash-wsl: the Windows users container is too broad for a writable workspace");
  }
  return canonical;
}

function resolveContainedWorkdir(workspaceRoot: string, workdir: string | undefined): string {
  if (workdir === undefined || workdir.trim().length === 0) return workspaceRoot;
  assertNoNul("workdir", workdir);
  const value = workdir.trim();
  if (WINDOWS_DEVICE_PREFIX.test(value) || WINDOWS_UNC_PREFIX.test(value)) {
    throw new Error("dsh-plugin-bash-wsl: workdir must not use UNC or device namespaces");
  }
  const resolved = win32.isAbsolute(value)
    ? win32.resolve(value)
    : win32.resolve(workspaceRoot, value);
  const canonical = win32.normalize(canonicalPath(resolved));
  const relative = win32.relative(workspaceRoot, canonical);
  if (relative === "") return workspaceRoot;
  if (relative === ".." || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) {
    throw new Error("dsh-plugin-bash-wsl: workdir must remain inside sandboxPolicy.workspaceRoot");
  }
  return canonical;
}

/** A WSL-side canonicalizer supplied by the runtime backend. */
export type WslPathCanonicalizer = (
  linuxPath: string,
  signal?: AbortSignal,
) => Promise<string>;

export interface WslBoundaryInput {
  mode: WslExecutionBoundary["mode"];
  workspaceRoot: string;
  workdir?: string | undefined;
}

/**
 * Deterministic local-drive conversion used for planning and unit tests.
 * Production callers pass a WSL-side `realpath --canonicalize-existing`
 * callback to `buildWslLaunchPlan`; this function alone never makes a writable
 * bind security decision.
 */
export async function mapWindowsPathToWsl(
  _config: ResolvedPluginConfig,
  windowsPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  assertNoNul("Windows path", windowsPath);
  if (WINDOWS_DEVICE_PREFIX.test(windowsPath) || WINDOWS_UNC_PREFIX.test(windowsPath)) {
    throw new Error("dsh-plugin-bash-wsl: remote and device paths cannot be mapped into WSL");
  }
  const resolved = win32.resolve(windowsPath);
  const match = WINDOWS_DRIVE_PATH.exec(resolved);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("dsh-plugin-bash-wsl: expected an absolute Windows drive path");
  }
  const drive = match[1].toLowerCase();
  const tail = match[2].replaceAll("\\", "/");
  return tail.length === 0 ? `/mnt/${drive}` : `/mnt/${drive}/${tail}`;
}

export async function buildWslLaunchPlan(
  config: ResolvedPluginConfig,
  boundary: WslBoundaryInput,
  signal?: AbortSignal,
  canonicalize?: WslPathCanonicalizer,
): Promise<WslLaunchPlan> {
  signal?.throwIfAborted();
  assertSandboxMode(boundary.mode);
  assertNoNul("wslExecutable", config.wslExecutable);
  assertNoNul("distro", config.distro);
  const wslExecutable = process.platform === "win32"
    ? resolveWslExecutable({
        executable: config.wslExecutable,
        env: process.env,
        platform: "win32",
      })
    : config.wslExecutable.trim();
  if (wslExecutable.length === 0 || !/(?:^|[\\/])wsl(?:\.exe)?$/i.test(wslExecutable)) {
    throw new Error("dsh-plugin-bash-wsl: wslExecutable must point to wsl.exe");
  }
  if (config.distro.trim().length === 0 || /[\r\n]/.test(config.distro)) {
    throw new Error("dsh-plugin-bash-wsl: distro must be a non-empty single-line name");
  }
  const workspaceRoot = assertSafeWorkspaceRoot(boundary.workspaceRoot);
  const workdir = resolveContainedWorkdir(workspaceRoot, boundary.workdir);
  const [mappedWorkspaceRootLinux, mappedWorkdirLinux] = await Promise.all([
    mapWindowsPathToWsl(config, workspaceRoot, signal),
    mapWindowsPathToWsl(config, workdir, signal),
  ]);
  signal?.throwIfAborted();
  let workspaceRootLinux = mappedWorkspaceRootLinux;
  let workdirLinux = mappedWorkdirLinux;
  if (canonicalize !== undefined) {
    const [canonicalWorkspaceRootLinux, canonicalWorkdirLinux] = await Promise.all([
      canonicalize(mappedWorkspaceRootLinux, signal),
      canonicalize(mappedWorkdirLinux, signal),
    ]);
    const canonicalRoot = canonicalWslPath(
      "canonical workspaceRootLinux",
      canonicalWorkspaceRootLinux,
    );
    const canonicalWorkdir = canonicalWslPath(
      "canonical workdirLinux",
      canonicalWorkdirLinux,
    );
    // A symlink, mount, or WSL path translation that changes either value is
    // rejected. This keeps the bwrap bind tied to the immutable Windows policy
    // root captured above instead of silently following a different target.
    if (canonicalRoot !== mappedWorkspaceRootLinux) {
      throw new Error(
        "dsh-plugin-bash-wsl: WSL realpath no longer maps to the immutable policy workspace root",
      );
    }
    if (canonicalWorkdir !== mappedWorkdirLinux || !isInsideWslRoot(canonicalRoot, canonicalWorkdir)) {
      throw new Error(
        "dsh-plugin-bash-wsl: WSL realpath escaped the immutable policy workspace root",
      );
    }
    workspaceRootLinux = canonicalRoot;
    workdirLinux = canonicalWorkdir;
  }
  return {
    executable: wslExecutable,
    args: ["-d", config.distro, "--exec"],
    workspaceRootLinux,
    workdirLinux,
    mode: boundary.mode,
  };
}

/** @internal Runtime-only Windows path validation shared with the backend. */
export function resolveHostBoundary(boundary: WslBoundaryInput): {
  workspaceRoot: string;
  workdir: string;
} {
  assertSandboxMode(boundary.mode);
  const workspaceRoot = assertSafeWorkspaceRoot(boundary.workspaceRoot);
  return {
    workspaceRoot,
    workdir: resolveContainedWorkdir(workspaceRoot, boundary.workdir),
  };
}
