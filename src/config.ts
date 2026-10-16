import z from "@deepseek-ai/schemastery";

import type { PluginConfig, ResolvedPluginConfig } from "./types.js";
import { MAX_TIMEOUT_MS } from "./tools/process.js";

const KIB = 1024;
const MIB = 1024 * KIB;

export const DEFAULT_CONFIG: Readonly<ResolvedPluginConfig> = Object.freeze({
  persistentShell: "wsl",
  registerModes: true,
  backendType: "wsl",
  distro: "Ubuntu",
  wslExecutable: "wsl.exe",
  shellPath: "/bin/bash",
  shellArgs: Object.freeze(["--noprofile", "--norc", "-i"]),
  rows: 40,
  cols: 160,
  scrollbackLines: 10_000,
  scrollbackMaxBytes: 4 * MIB,
  maxReadBytes: 256 * KIB,
  pollIntervalMs: 50,
  idleSilenceMs: 3_000,
  timeoutMs: 300_000,
  disposeGraceMs: 3_000,
  oneShotTimeoutMs: 120_000,
  oneShotMaxOutputBytes: 64 * KIB,
  oneShotMaxSpillBytes: 64 * MIB,
});

export const Config: z<PluginConfig> = z.object({
  persistentShell: z.union(["wsl", "git-bash"]).default(DEFAULT_CONFIG.persistentShell),
  registerModes: z.boolean().default(DEFAULT_CONFIG.registerModes),
  backendType: z.string().default(DEFAULT_CONFIG.backendType),
  distro: z.string().default(DEFAULT_CONFIG.distro),
  wslExecutable: z.string().default(DEFAULT_CONFIG.wslExecutable),
  gitBashExecutable: z.string(),
  shellPath: z.string().default(DEFAULT_CONFIG.shellPath),
  shellArgs: z.array(z.string()).default([...DEFAULT_CONFIG.shellArgs]),
  rows: z.number().default(DEFAULT_CONFIG.rows),
  cols: z.number().default(DEFAULT_CONFIG.cols),
  scrollbackLines: z.number().default(DEFAULT_CONFIG.scrollbackLines),
  scrollbackMaxBytes: z.number().default(DEFAULT_CONFIG.scrollbackMaxBytes),
  maxReadBytes: z.number().default(DEFAULT_CONFIG.maxReadBytes),
  pollIntervalMs: z.number().default(DEFAULT_CONFIG.pollIntervalMs),
  idleSilenceMs: z.number().default(DEFAULT_CONFIG.idleSilenceMs),
  timeoutMs: z.number().default(DEFAULT_CONFIG.timeoutMs),
  disposeGraceMs: z.number().default(DEFAULT_CONFIG.disposeGraceMs),
  oneShotTimeoutMs: z.number().default(DEFAULT_CONFIG.oneShotTimeoutMs),
  oneShotMaxOutputBytes: z.number().default(DEFAULT_CONFIG.oneShotMaxOutputBytes),
  oneShotMaxSpillBytes: z.number().default(DEFAULT_CONFIG.oneShotMaxSpillBytes),
});

const NON_EMPTY_FIELDS = [
  "backendType",
  "distro",
  "wslExecutable",
  "shellPath",
] as const;

const POSITIVE_INTEGER_FIELDS = [
  "rows",
  "cols",
  "scrollbackLines",
  "scrollbackMaxBytes",
  "maxReadBytes",
  "pollIntervalMs",
  "idleSilenceMs",
  "timeoutMs",
  "disposeGraceMs",
  "oneShotTimeoutMs",
  "oneShotMaxOutputBytes",
  "oneShotMaxSpillBytes",
] as const;

export function resolveConfig(input: PluginConfig = {}): ResolvedPluginConfig {
  const config: ResolvedPluginConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    shellArgs: input.shellArgs === undefined ? [...DEFAULT_CONFIG.shellArgs] : [...input.shellArgs],
  };

  if (config.persistentShell !== "wsl" && config.persistentShell !== "git-bash") {
    throw new Error("dsh-plugin-bash-wsl: persistentShell must be wsl or git-bash");
  }
  if (typeof config.registerModes !== "boolean") {
    throw new Error("dsh-plugin-bash-wsl: registerModes must be a boolean");
  }

  for (const field of NON_EMPTY_FIELDS) {
    if (config[field].trim().length === 0) {
      throw new Error(`dsh-plugin-bash-wsl: ${field} must be non-empty`);
    }
  }
  if (config.gitBashExecutable !== undefined && config.gitBashExecutable.trim().length === 0) {
    throw new Error("dsh-plugin-bash-wsl: gitBashExecutable must be non-empty when set");
  }
  if (config.shellArgs.some((arg) => arg.includes("\0"))) {
    throw new Error("dsh-plugin-bash-wsl: shellArgs must not contain NUL bytes");
  }
  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = config[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-plugin-bash-wsl: ${field} must be a positive safe integer`);
    }
  }
  if (config.maxReadBytes > config.scrollbackMaxBytes) {
    throw new Error("dsh-plugin-bash-wsl: maxReadBytes must not exceed scrollbackMaxBytes");
  }
  if (config.oneShotTimeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`dsh-plugin-bash-wsl: oneShotTimeoutMs must not exceed ${MAX_TIMEOUT_MS}ms`);
  }
  if (config.oneShotMaxOutputBytes > config.oneShotMaxSpillBytes) {
    throw new Error("dsh-plugin-bash-wsl: oneShotMaxOutputBytes must not exceed oneShotMaxSpillBytes");
  }
  if (config.oneShotMaxSpillBytes > 64 * MIB) {
    throw new Error("dsh-plugin-bash-wsl: oneShotMaxSpillBytes must not exceed the 64MiB output safety cap");
  }

  return Object.freeze(config);
}
