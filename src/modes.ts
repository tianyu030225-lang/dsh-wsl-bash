import type { Context } from "@deepseek-ai/cordis";
import type { PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";
import type { Schema } from "js-yaml";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createDshHostRequire } from "./runtime.js";
import type { ResolvedPluginConfig } from "./types.js";

export const SHELL_MODES = Object.freeze([
  { id: "bash-wsl", name: "WSL 模式", shell: "wsl", order: 5 },
  { id: "bash-git-bash", name: "Git Bash 模式", shell: "git-bash", order: 6 },
] as const);

/** Use the running host's exported Standard template, including its !!js nodes. */
async function readStandardPlugins(ctx: Context): Promise<PresetDefinition["plugins"]> {
  const hostRequire = createDshHostRequire(ctx.profileContext.installAnchor);
  const registryRequire = createRequire(hostRequire.resolve("@deepseek-ai/dsh-agent-preset-registry"));
  const include = await import(pathToFileURL(registryRequire.resolve("@deepseek-ai/cordis-plugin-include")).href) as {
    entryListSchema: Schema;
  };
  const yaml = registryRequire("js-yaml") as typeof import("js-yaml");
  const patch = yaml.load(
    readFileSync(hostRequire.resolve("@deepseek-ai/dsh-web-app/presets/standard.patch.yml"), "utf8"),
    { schema: include.entryListSchema },
  );
  if (!Array.isArray(patch)) throw new Error("The host Standard preset must be a patch list");
  const rows: unknown[] = patch.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null || !("insert" in item) || !Array.isArray(item.insert)) return [];
    return item.insert;
  });
  const standard = rows.find((row): row is { name: string; config: { id: string; plugins: unknown } } =>
    typeof row === "object" && row !== null && "name" in row && row.name === "@deepseek-ai/dsh-agent-preset" &&
    "config" in row && typeof row.config === "object" && row.config !== null &&
    "id" in row.config && row.config.id === "standard" && "plugins" in row.config,
  );
  const registry = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-agent-preset-registry")).href) as {
    entryListProblem: (rows: unknown) => string | undefined;
  };
  const problem = registry.entryListProblem(standard?.config.plugins);
  if (problem !== undefined) throw new Error(`Cannot compose native shell modes from the host Standard preset: ${problem}`);
  return standard!.config.plugins as PresetDefinition["plugins"];
}

/** Additional definitions; never modify a stock preset or the selected default. */
export async function registerShellModes(ctx: Context, config: ResolvedPluginConfig): Promise<() => Promise<void>> {
  const disposers: (() => Promise<void>)[] = [];
  const disposeModes = async () => {
    const failures: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Native shell mode cleanup failed");
  };
  try {
    for (const mode of SHELL_MODES) {
      // Parse independently so two retained revisions never share mutable config.
      const standard = await readStandardPlugins(ctx);
      const plugins: PresetDefinition["plugins"] = [
        // The mode's persistent `bash` replaces the stock one-shot Bash only.
        // Keep PowerShell and every non-Bash Standard capability unchanged.
        ...standard.filter((row) => row.name !== "@deepseek-ai/dsh-tool-bash"),
        {
          id: "native-bash-terminal",
          name: "cordis:group",
          group: true,
          isolate: { terminals: true },
          config: [
            { id: "terminal-registry", name: "@deepseek-ai/dsh-terminal" },
            {
              id: "native-backend-and-tools",
              name: "dsh-plugin-bash-wsl",
              config: { ...config, backendType: mode.shell, persistentShell: mode.shell, registerModes: false },
            },
            {
              id: "persistent-bash",
              name: "dsh-plugin-bash-wsl/persistent",
              config: {
                backendType: mode.shell,
                timeoutMs: config.timeoutMs,
                maxOutputChars: 16000,
                description: mode.shell === "wsl"
                  ? "Run commands in this agent's persistent WSL Bash shell; cwd, variables and functions persist across serial calls."
                  : "Run commands in this agent's persistent native Git Bash shell. Requires explicit danger-full-access for this session; selecting the mode never grants it. Cwd, variables and functions persist across serial calls.",
              },
            },
          ],
        },
      ];
      disposers.push(await ctx.agentPresets.register({
        id: mode.id,
        name: mode.name,
        order: mode.order,
        description: mode.shell === "wsl"
          ? "标准模式全部能力，使用持久 WSL Bash；同时提供一次性 WSL、Git Bash 和 PowerShell。"
          : "标准模式全部能力，使用持久 Git Bash（需当前会话完全权限）；同时提供一次性 WSL、Git Bash 和 PowerShell。",
        plugins,
      }));
    }
  } catch (error) {
    try { await disposeModes(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Native shell mode registration and cleanup failed");
    }
    throw error;
  }
  return disposeModes;
}
