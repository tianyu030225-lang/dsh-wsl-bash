import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-app-boot";
import type {} from "@deepseek-ai/dsh-working-directory";

import { Config, resolveConfig } from "./config.js";
import type { PluginConfig } from "./types.js";
import { registerOneShotTools } from "./tools/register.js";
import { registerWslTerminalBackend } from "./wsl/backend.js";
import { registerGitBashTerminalBackend } from "./git/backend.js";
import { registerShellModes } from "./modes.js";
import { registerBashWslSystemPrompt } from "./prompt.js";
import {
  assertSupportedDshVersion,
  readDshVersion,
  SUPPORTED_DSH_VERSION,
  SUPPORTED_DSH_VERSIONS,
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
export { GitBashTerminalBackend, registerGitBashTerminalBackend } from "./git/backend.js";
export { SHELL_MODES, registerShellModes } from "./modes.js";
export { buildWslLaunchPlan, mapWindowsPathToWsl } from "./wsl/launcher.js";
export { buildBwrapArgs } from "./wsl/sandbox.js";
export {
  assertSupportedDshVersion,
  readDshVersion,
  SUPPORTED_DSH_VERSION,
  SUPPORTED_DSH_VERSIONS,
} from "./runtime.js";
export { BASH_WSL_PROMPT_SECTION, BASH_WSL_SYSTEM_PROMPT, GIT_BASH_SYSTEM_PROMPT } from "./prompt.js";

export const name = "dsh-plugin-bash-wsl";
export const inject = [
  "terminals",
  "tools",
  "subprocess",
  "sandboxPolicy",
  "sessionProjections",
  "profileContext",
  "systemPrompt",
  "workingDirectory",
] as const;

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const anchor = ctx.profileContext?.installAnchor;
  if (typeof anchor !== "string" || anchor.length === 0) {
    throw new Error("dsh-plugin-bash-wsl: profileContext.installAnchor is required to identify the running host");
  }
  assertSupportedDshVersion(readDshVersion(anchor));
  const resolved = resolveConfig(config);
  if (resolved.persistentShell === "git-bash") registerGitBashTerminalBackend(ctx, resolved);
  else registerWslTerminalBackend(ctx, resolved);
  registerOneShotTools(ctx, resolved);
  registerBashWslSystemPrompt(ctx, resolved.persistentShell);
  if (resolved.registerModes) {
    // Headless/CLI hosts need no preset registry. A Web/Desktop host supplies it;
    // an injected child activates when available without waiting for host audit.
    ctx.inject(["agentPresets"], (presetCtx) => registerShellModes(presetCtx, resolved));
  }
}
