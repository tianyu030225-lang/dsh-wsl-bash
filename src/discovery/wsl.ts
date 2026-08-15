import { posix, win32 } from "node:path";

export const DEFAULT_WSL_DISTRO = "Ubuntu";
export const DEFAULT_WSL_PATH = "C:\\Windows\\System32\\wsl.exe";

export interface WslDiscoveryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  executable?: string | undefined;
  distro?: string | undefined;
}

export interface WslWorkspacePaths {
  /** The immutable policy root, represented in the WSL namespace. */
  workspaceRoot: string;
  /** The only model-controlled path: the command's cwd. */
  cwd: string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === wanted);
  const value = entry?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function rejectUnsafeWslPath(value: string): void {
  if (!value || value.includes("\0")) throw new Error("WSL path must be a non-empty string without NUL");
  if (/^(?:\\\\|\/\/|\\\\[?.]|\\\?\?\\|\/\?\?\/)/.test(value)) {
    throw new Error("WSL path must not use UNC or device namespaces");
  }
}

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

/** Convert a local Windows drive path to WSL's /mnt/<drive> namespace. */
export function windowsPathToWsl(value: string): string {
  rejectUnsafeWslPath(value);
  const trimmed = value.trim();
  if (!isWindowsAbsolutePath(trimmed)) {
    // Model workdirs often arrive as Windows relative paths even though the
    // policy root is later represented in the POSIX WSL namespace.
    return posix.normalize(trimmed.replaceAll("\\", "/"));
  }
  const drive = trimmed[0]!.toLowerCase();
  const rest = trimmed.slice(2).replaceAll("\\", "/");
  return posix.normalize(`/mnt/${drive}/${rest.replace(/^\/+/, "")}`);
}

function within(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${posix.sep}`) && !posix.isAbsolute(relative));
}

/**
 * Resolve the per-call cwd while preserving the policy's immutable root.  A
 * model workdir may select a directory below that root, but cannot replace the
 * root or escape it with `..`.
 */
export function resolveWslWorkspacePaths(
  workspaceRoot: string,
  modelWorkdir?: string,
): WslWorkspacePaths {
  rejectUnsafeWslPath(workspaceRoot);
  const root = windowsPathToWsl(workspaceRoot);
  if (!root.startsWith("/")) throw new Error("sandboxPolicy.workspaceRoot must be absolute");
  if (isBroadWorkspaceRoot(root)) {
    throw new Error("sandboxPolicy.workspaceRoot is too broad for a confined WSL call");
  }

  let cwd: string;
  if (modelWorkdir === undefined || modelWorkdir.trim().length === 0) cwd = root;
  else {
    rejectUnsafeWslPath(modelWorkdir);
    const raw = windowsPathToWsl(modelWorkdir.trim());
    cwd = raw.startsWith("/") ? posix.normalize(raw) : posix.resolve(root, raw);
  }
  if (!within(root, cwd)) {
    throw new Error("workdir must remain below sandboxPolicy.workspaceRoot");
  }
  return { workspaceRoot: root, cwd };
}

function isBroadWorkspaceRoot(root: string): boolean {
  const normalized = posix.normalize(root).replace(/\/+$/, "") || "/";
  return normalized === "/" ||
    normalized === "/mnt" ||
    normalized === "/tmp" ||
    /^\/mnt\/[a-z]$/i.test(normalized) ||
    /^\/mnt\/[a-z]\/Users(?:\/[^/]+)?$/i.test(normalized);
}

export function resolveWslExecutable(options: WslDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("wsl_bash: WSL is supported only on Windows");
  const env = options.env ?? process.env;
  const value = options.executable?.trim() ||
    envValue(env, "DSH_WSL_PATH") ||
    (() => {
      const root = envValue(env, "WINDIR") || envValue(env, "SystemRoot") || "C:\\Windows";
      return win32.join(root, "System32", "wsl.exe");
    })();
  // Keep the legacy bare setting as a safe alias, but never hand a bare name
  // to Windows process lookup where a workspace-local wsl.exe could shadow it.
  if (/^wsl(?:\.exe)?$/i.test(value)) {
    const root = envValue(env, "WINDIR") || envValue(env, "SystemRoot") || "C:\\Windows";
    return win32.normalize(win32.join(root, "System32", "wsl.exe"));
  }
  rejectUnsafeWslPath(value);
  if (!win32.isAbsolute(value) || win32.basename(value).toLowerCase() !== "wsl.exe") {
    throw new Error("wsl_bash: configured executable must be an absolute wsl.exe path");
  }
  return win32.normalize(value);
}

export function resolveWslDistro(options: WslDiscoveryOptions = {}): string {
  const distro = options.distro?.trim() || envValue(options.env ?? process.env, "DSH_WSL_DISTRO") || DEFAULT_WSL_DISTRO;
  if (!distro || distro.includes("\0") || /[\r\n]/.test(distro)) throw new Error("wsl_bash: invalid distro name");
  return distro;
}
