import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../../../src/config.js";
import { WslTerminalBackend } from "../../../src/wsl/backend.js";

type OfficialServices = {
  SessionStore: new (ctx: unknown) => unknown;
  SessionProjectionRegistry: new (ctx: unknown) => unknown;
  SandboxPolicyService: new (ctx: unknown, config: unknown) => unknown;
};

// The official policy service validates paths in the current execution world:
// Windows Node receives a Windows absolute path, while WSL/Linux receives the
// same checkout's /mnt/c absolute path. This test does not need the directory
// to exist because it only exercises the mode-fence state transition.
const SANDBOX_WORKSPACE = process.cwd();

function loadOfficialServices(): OfficialServices {
  const policyManifest = realpathSync(
    resolve(
      process.cwd(),
      "node_modules",
      "@deepseek-ai",
      "dsh-sandbox-policy",
      "package.json",
    ),
  );
  const require = createRequire(policyManifest);
  return {
    SessionStore: require("@deepseek-ai/dsh-session").SessionStore,
    SessionProjectionRegistry: require("@deepseek-ai/dsh-session-projection")
      .SessionProjectionRegistry,
    SandboxPolicyService: require("@deepseek-ai/dsh-sandbox-policy")
      .SandboxPolicyService,
  };
}

describe("official session/projection sandbox-mode fence", () => {
  it("rejects a mode event before commit while a persistent owner is active", async () => {
    const { SessionStore, SessionProjectionRegistry, SandboxPolicyService } =
      loadOfficialServices();
    const root = new Context();
    let sessionFiber: { dispose(): Promise<unknown> } | undefined;
    let projectionFiber: { dispose(): Promise<unknown> } | undefined;
    let promptFiber: { dispose(): Promise<unknown> } | undefined;
    let policyFiber: { dispose(): Promise<unknown> } | undefined;
    let detachSession: (() => void) | undefined;

    try {
      sessionFiber = await root.plugin(SessionStore as any);
      projectionFiber = await root.plugin(SessionProjectionRegistry as any);
      promptFiber = await root.plugin(SystemPrompt);
      policyFiber = await root.plugin(SandboxPolicyService as any, {
        mode: "workspace-write",
        workspaceRoot: SANDBOX_WORKSPACE,
      });

      const session = (root as any).sessions.create("sandbox-fence-test", {
        meta: { cwd: SANDBOX_WORKSPACE },
      });
      detachSession = () => (root as any).sessions.get(session.id) &&
        (root as any).sessions.detach?.(session);
      const beforeSeq = session.seq;
      const active = { id: session.id, session, ctx: root };
      const terminals = {
        hasOwnerActivity: vi.fn(() => true),
      };
      const backendContext = {
        terminals,
        sandboxPolicy: (root as any).sandboxPolicy,
        subprocess: {
          spawn: vi.fn(() => {
            throw new Error("preflight-stop");
          }),
        },
      } as any;
      const backend = new WslTerminalBackend(backendContext, resolveConfig());

      await expect(
        backend.spawn({
          type: "wsl",
          sessionId: "sandbox-fence-terminal" as any,
          owner: active as any,
          cwd: SANDBOX_WORKSPACE,
          name: "sandbox-fence",
        }),
      ).rejects.toThrow(/preflight-stop|WSL|sandbox/i);
      expect(terminals.hasOwnerActivity).not.toHaveBeenCalled();

      expect(() => session.append("sandbox/mode", { mode: "read-only" })).toThrow(
        /cannot change sandbox mode/i,
      );
      expect(session.seq).toBe(beforeSeq);
      expect((root as any).sandboxPolicy.resolve({ session }).mode).toBe(
        "workspace-write",
      );
      expect((root as any).sessionProjections.stateOf(session, "sandboxMode"))
        .toBeNull();

      terminals.hasOwnerActivity.mockReturnValue(false);
      expect(() => session.append("sandbox/mode", { mode: "read-only" })).not.toThrow();
      expect((root as any).sandboxPolicy.resolve({ session }).mode).toBe(
        "read-only",
      );
      expect((root as any).sessionProjections.stateOf(session, "sandboxMode")).toBe(
        "read-only",
      );
    } finally {
      if (detachSession !== undefined) {
        try {
          detachSession();
        } catch {
          // SessionStore service disposal below owns the final cleanup.
        }
      }
      if (policyFiber !== undefined) await policyFiber.dispose();
      if (promptFiber !== undefined) await promptFiber.dispose();
      if (projectionFiber !== undefined) await projectionFiber.dispose();
      if (sessionFiber !== undefined) await sessionFiber.dispose();
      await root.fiber.dispose();
    }
  });
});
