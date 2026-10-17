import { describe, expect, it, vi } from "vitest";
import { ESCALATION_TARGETS } from "@deepseek-ai/dsh-sandbox";

import { resolveConfig } from "../../../src/config.js";
import { registerOneShotTools } from "../../../src/tools/register.js";

type RegisteredTool = {
  name: string;
  parameters: {
    type?: string;
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  output: { schema: { type?: string; additionalProperties?: boolean; properties?: Record<string, any> } };
  execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown>;
};

function registerTools(existingContext?: any) {
  const register = vi.fn();
  const ctx = existingContext ?? {};
  ctx.tools = { register };
  registerOneShotTools(ctx, resolveConfig());
  return {
    ctx,
    tools: register.mock.calls.map(([tool]) => tool as RegisteredTool),
  };
}

function executionContext(options: {
  policy?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  spawn?: ReturnType<typeof vi.fn>;
}) {
  const spawn = options.spawn ?? vi.fn();
  const policy = options.policy ?? {
    mode: "workspace-write",
    workspaceRoot: "C:\\Users\\Alice\\work\\dsh 插件 测试",
  };
  const approval = options.approval ?? {
    request: vi.fn(async () => "rejected"),
  };
  const services = new Map([
    ["sandboxPolicy", { resolve: vi.fn(() => policy) }],
    ["subprocess", { spawn }],
    ["approval", approval],
  ]);
  const ctx = {
    get: vi.fn((name: string) => services.get(name)),
    workingDirectory: {
      ensure: vi.fn(async () => String(policy.workspaceRoot ?? "C:\\fixture")),
    },
  } as any;
  return { ctx, spawn, approval, policy };
}

describe("0.2 tool registration and fail-closed execution", () => {
  it("registers exactly the two stateless tools with strict schemas", () => {
    const { tools } = registerTools();

    expect(tools.map((tool) => tool.name)).toEqual(["wsl_bash", "git_bash"]);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.required).toEqual(expect.arrayContaining(["command", "description"]));
      expect(tool.parameters.properties.command).toMatchObject({ type: "string" });
      expect(tool.parameters.properties.description).toMatchObject({ type: "string" });
      expect(tool.parameters.properties.sandbox_permissions).toMatchObject({
        type: "string",
        enum: [...ESCALATION_TARGETS],
      });
      expect(tool.output.schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.output.schema.properties?.kind).toMatchObject({
        type: "string",
        const: "foreground",
      });
        expect(tool.output.schema.properties?.failure).toMatchObject({
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            message: { type: "string" },
          },
        });
    }
  });

  it("rejects malformed calls before any process seam is reached", async () => {
    const { tools } = registerTools();
    const { ctx, spawn } = executionContext({});
    const wsl = tools.find((tool) => tool.name === "wsl_bash");
    expect(wsl).toBeDefined();

    await expect(wsl!.execute({ command: "", description: "" }, {
      agent: { id: "agent-a" },
      callId: "call-invalid",
      signal: new AbortController().signal,
    } as any)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.get).not.toHaveBeenCalledWith("subprocess");
  });

  it("returns a denial and starts zero processes when approval rejects Git Bash escalation", async () => {
    const spawn = vi.fn();
    const approvalRequest = vi.fn(async () => "rejected");
    const execution = executionContext({
      spawn,
      approval: { request: approvalRequest },
    });
    const { ctx, tools } = { ...execution, ...registerTools(execution.ctx) };
    const gitBash = tools.find((tool) => tool.name === "git_bash");
    expect(gitBash).toBeDefined();
    const agent = { id: "agent-a" };

    const result = await gitBash!.execute({
      command: "printf ok",
      description: "local test",
      sandbox_permissions: "danger-full-access",
      justification: "test exact approval rejection",
    }, {
      agent,
      callId: "call-rejected",
      signal: new AbortController().signal,
    } as any) as any;

    expect(approvalRequest).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      toolName: "git_bash",
    }));
    expect(result.sandbox.denied).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.get).toHaveBeenCalledWith("sandboxPolicy");
  });

  it("keeps approval requests tied to their originating agent under concurrent calls", async () => {
    const spawn = vi.fn();
    const seenAgents: unknown[] = [];
    const approvalRequest = vi.fn(async ({ agent }: { agent: unknown }) => {
      seenAgents.push(agent);
      return "rejected";
    });
    const execution = executionContext({
      spawn,
      approval: { request: approvalRequest },
    });
    const { ctx, tools } = { ...execution, ...registerTools(execution.ctx) };
    const gitBash = tools.find((tool) => tool.name === "git_bash");
    expect(gitBash).toBeDefined();
    const agentA = { id: "agent-a" };
    const agentB = { id: "agent-b" };
    const args = {
      command: "printf ok",
      description: "concurrent local test",
      sandbox_permissions: "danger-full-access",
      justification: "test owner isolation",
    };

    await Promise.all([
      gitBash!.execute(args, {
        agent: agentA,
        callId: "call-a",
        signal: new AbortController().signal,
      } as any),
      gitBash!.execute(args, {
        agent: agentB,
        callId: "call-b",
        signal: new AbortController().signal,
      } as any),
    ]);

    expect(seenAgents).toEqual(expect.arrayContaining([agentA, agentB]));
    expect(approvalRequest).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.get).toHaveBeenCalledWith("approval");
  });
});
