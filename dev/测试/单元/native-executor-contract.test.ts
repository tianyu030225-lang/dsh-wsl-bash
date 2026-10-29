import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolsService from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../../../src/config.js";
import { registerOneShotTools } from "../../../src/tools/register.js";

const hostRequire = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"));

async function setup(withExecutor = true) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  const spawn = vi.fn(() => { throw new Error("restricted Git Bash must start zero processes"); });
  const services: Record<string, unknown> = {
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "C:\\fixture" }) },
    subprocess: { spawn },
  };
  // Use the real installed registry, schema validation, executor and pipeline;
  // inject only the policy/process boundary so this is portable without WSL.
  registerOneShotTools({
    tools: ctx.tools,
    get: (name: string) => services[name],
  } as unknown as Context, resolveConfig());
  if (withExecutor) {
    await ctx.plugin(await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-tool-executor-native")).href));
  }
  return { ctx, spawn };
}

function input(args: Record<string, unknown>) {
  return {
    calls: [{ type: "tool-call" as const, id: "native-contract" as any, name: "git_bash", arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  };
}

describe("alpha.2 installed native-executor compatibility", () => {
  it("routes registered tools through batch dispatch and retains zero-process denial", async () => {
    const { ctx, spawn } = await setup();
    try {
      expect(ctx.tools.executable("git_bash")).toBeDefined();
      const assembly = await ctx.systemPrompt.assemble({});
      expect(assembly.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["wsl_bash", "git_bash"]));
      const batch = await ctx.tools.execute(input({ command: "printf denied", description: "denied native execution" }));
      expect(batch.results).toHaveLength(1);
      expect(batch.results[0]).toMatchObject({
        callId: "native-contract",
        result: { isError: false, value: { sandbox: { mode: "workspace-write", denied: true } } },
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });

  it("rejects malformed model arguments before reaching the process boundary", async () => {
    const { ctx, spawn } = await setup();
    try {
      const batch = await ctx.tools.execute(input({ command: "printf denied" }));
      expect(batch.results[0]?.result.isError).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });

  it("fails closed when the host has no selected executor", async () => {
    const { ctx, spawn } = await setup(false);
    try {
      await expect(ctx.tools.execute(input({ command: "printf denied", description: "missing executor" })))
        .rejects.toThrow(/selected tool executor is unavailable/);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });
});
