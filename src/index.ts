import type { Context } from "@deepseek-ai/cordis";

import { Config, resolveConfig } from "./config.js";
import type { PluginConfig } from "./types.js";
import { registerOneShotTools } from "./tools/register.js";
import { registerWslTerminalBackend } from "./wsl/backend.js";
import {
  assertSupportedDshVersion,
  readDshVersion,
  SUPPORTED_DSH_VERSION,
} from "./runtime.js";

export { Config, DEFAULT_CONFIG, resolveConfig } from "./config.js";
export type {
  PluginConfig,
  ResolvedPluginConfig,
  SandboxMode,
  WslExecutionBoundary,
  WslLaunchPlan,
} from "./types.js";
export { WslTerminalBackend, registerWslTerminalBackend } from "./wsl/backend.js";
export { buildWslLaunchPlan, mapWindowsPathToWsl } from "./wsl/launcher.js";
export { buildBwrapArgs } from "./wsl/sandbox.js";
export {
  assertSupportedDshVersion,
  readDshVersion,
  SUPPORTED_DSH_VERSION,
} from "./runtime.js";

export const name = "dsh-plugin-bash-wsl";
export const inject = [
  "terminals",
  "tools",
  "subprocess",
  "sandboxPolicy",
] as const;

export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertSupportedDshVersion();
  const resolved = resolveConfig(config);
  registerWslTerminalBackend(ctx, resolved);
  registerOneShotTools(ctx, resolved);
}
