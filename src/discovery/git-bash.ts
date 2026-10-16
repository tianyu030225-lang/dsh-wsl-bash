import {
  accessSync,
  constants,
  realpathSync,
  statSync,
  readFileSync,
} from "node:fs";
import { win32 } from "node:path";

export const GIT_BASH_PATH_ENV = "DSH_GIT_BASH_PATH";

export interface GitBashDiscoveryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Optional profile/YAML override, already decoded by the host when possible. */
  config?: GitBashConfig | string | undefined;
  fsImpl?: GitBashFs | undefined;
}

export interface GitBashConfig {
  gitBashPath?: string;
  gitBashExecutable?: string;
  bashPath?: string;
  executable?: string;
}

export interface GitBashFs {
  statSync: typeof statSync;
  accessSync: typeof accessSync;
  realpathSync: typeof realpathSync;
}

const defaultFs: GitBashFs = { statSync, accessSync, realpathSync };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === wanted);
  const value = entry?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => envValue(env, name) ?? match);
}

/** Reject paths that can name a network share, device namespace, or drive-relative path. */
export function rejectUnsafeWindowsPath(candidate: string): void {
  const value = candidate.trim();
  if (value.length === 0) throw new Error("Git Bash path must not be empty");
  if (value.includes("\0")) throw new Error("Git Bash path contains NUL");
  if (/^(?:\\\\|\/\/|\\\\[?.]|\\\?\?\\|\/\?\?\/)/.test(value)) {
    throw new Error("Git Bash path must not use UNC or device namespaces");
  }
  if (!win32.isAbsolute(value) || /^[A-Za-z]:[^\\/]/.test(value)) {
    throw new Error(`Git Bash path must be an absolute local Windows path: ${value}`);
  }
}

function canonicalExecutable(candidate: string, fsImpl: GitBashFs = defaultFs): string | undefined {
  try {
    rejectUnsafeWindowsPath(candidate);
    if (!/bash\.exe$/i.test(candidate.trim())) return undefined;
    if (!fsImpl.statSync(candidate).isFile()) return undefined;
    // Windows ignores X_OK for many file systems, but accessSync still catches
    // missing/denied paths and is useful for injected test filesystems.
    fsImpl.accessSync(candidate, constants.X_OK);
    const resolved = stripLocalExtendedPrefix(fsImpl.realpathSync.native(candidate));
    rejectUnsafeWindowsPath(resolved);
    return win32.normalize(resolved);
  } catch {
    return undefined;
  }
}

/** Windows may expose a local realpath as `\\?\C:\...`; strip only that
 * local-drive spelling after canonicalization.  UNC/device namespaces remain
 * rejected rather than being silently converted. */
function stripLocalExtendedPrefix(value: string): string {
  const local = /^\\\\\?\\([A-Za-z]:\\.*)$/.exec(value);
  return local?.[1] ?? value;
}

export function canonicalGitBashPath(candidate: string, fsImpl?: GitBashFs): string {
  const resolved = canonicalExecutable(candidate, fsImpl);
  if (resolved === undefined) {
    throw new Error(`git-bash: executable does not exist, is not local, or is not executable: ${candidate}`);
  }
  return resolved;
}

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    try {
      rejectUnsafeWindowsPath(candidate);
    } catch {
      continue;
    }
    const normalized = win32.normalize(candidate.trim());
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function appendGitRoot(candidates: string[], root: string | undefined): void {
  if (!root) return;
  try {
    rejectUnsafeWindowsPath(root);
  } catch {
    return;
  }
  candidates.push(
    win32.join(root, "bin", "bash.exe"),
    win32.join(root, "usr", "bin", "bash.exe"),
  );
}

/** Return likely Git for Windows locations in preference order. */
export function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const programFiles = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
  const programW6432 = envValue(env, "ProgramW6432") ?? programFiles;
  const programFiles86 = envValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  for (const directory of [programFiles, programW6432, programFiles86]) {
    appendGitRoot(candidates, win32.join(directory, "Git"));
  }

  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) appendGitRoot(candidates, win32.join(localAppData, "Programs", "Git"));
  const userProfile = envValue(env, "USERPROFILE");
  if (userProfile) {
    appendGitRoot(candidates, win32.join(userProfile, "scoop", "apps", "git", "current"));
    appendGitRoot(candidates, win32.join(userProfile, "AppData", "Local", "Programs", "Git"));
  }
  appendGitRoot(candidates, envValue(env, "GIT_INSTALL_ROOT"));

  // PATH is only used to discover a Git root, never an arbitrary `bash.exe`.
  const pathValue = envValue(env, "PATH") ?? "";
  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (entry.length === 0) continue;
    try {
      rejectUnsafeWindowsPath(entry);
    } catch {
      continue;
    }
    const gitRoot = /^(.*[\\/]git)(?:[\\/].*)?$/i.exec(entry)?.[1];
    if (gitRoot) appendGitRoot(candidates, gitRoot);
    if (/(?:^|[\\/])git(?:[\\/]|$)/i.test(entry)) {
      candidates.push(win32.join(entry, "bash.exe"));
    }
  }
  return uniqueWindowsPaths(candidates);
}

/**
 * Decode the small, deliberately boring YAML override accepted by the plugin.
 * The profile patch normally hands us an object; this parser exists for the
 * standalone doctor/CLI and accepts only scalar `key: value` entries.
 */
export function readGitBashYaml(path: string): GitBashConfig {
  const text = readFileSync(path, "utf8");
  const config: GitBashConfig = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(gitBashPath|gitBashExecutable|bashPath|executable)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2").trim();
    if (!value) continue;
    config[match[1] as keyof GitBashConfig] = value;
  }
  return config;
}

function configuredPath(config: GitBashConfig | string | undefined): string | undefined {
  if (typeof config === "string") return config.trim() || undefined;
  return config?.gitBashPath?.trim() || config?.gitBashExecutable?.trim() || config?.bashPath?.trim() || config?.executable?.trim();
}

export function resolveGitBashPath(
  executable?: string,
  options: GitBashDiscoveryOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("git-bash: Git for Windows is supported only on Windows");

  const override = executable?.trim() || configuredPath(options.config) || envValue(env, GIT_BASH_PATH_ENV);
  const fsImpl = options.fsImpl ?? defaultFs;
  if (override) {
    const expanded = expandEnvironmentVariables(override, env);
    return canonicalGitBashPath(expanded, fsImpl);
  }
  const candidates = gitBashCandidates(env);
  for (const candidate of candidates) {
    const resolved = canonicalExecutable(candidate, fsImpl);
    if (resolved) return resolved;
  }
  throw new Error([
    "git-bash: Git for Windows Bash was not found.",
    `Install Git for Windows or set ${GIT_BASH_PATH_ENV} to a local bash.exe.`,
    candidates.length > 0 ? `Checked: ${candidates.join(", ")}` : "No candidate paths were available.",
  ].join(" "));
}
