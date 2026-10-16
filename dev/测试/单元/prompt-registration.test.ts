import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

import {
  BASH_WSL_PROMPT_SECTION,
  BASH_WSL_SYSTEM_PROMPT,
  registerBashWslSystemPrompt,
} from "../../../src/prompt.js";

describe("automatic Bash/WSL system-prompt contribution", () => {
  it("registers one ordered, literal section at the Bash tool boundary", () => {
    const section = vi.fn(() => vi.fn());
    const getSectionOrder = vi.fn((name: string) => {
      expect(name).toBe("TOOL_BASH");
      return 1700;
    });

    registerBashWslSystemPrompt({
      systemPrompt: { section, getSectionOrder },
    } as any);

    expect(getSectionOrder).toHaveBeenCalledOnce();
    expect(section).toHaveBeenCalledOnce();
    expect(section).toHaveBeenCalledWith({
      name: BASH_WSL_PROMPT_SECTION,
      order: 1701,
      text: BASH_WSL_SYSTEM_PROMPT,
      interpolate: false,
    });
  });

  it("documents all three shell choices without user-specific paths or credentials", () => {
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("bash");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("wsl_bash");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("git_bash");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("pwsh");
    expect(BASH_WSL_SYSTEM_PROMPT).not.toMatch(
      /(?:[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/\r\n]+|\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/[^\/\r\n]+)/i,
    );
    expect(BASH_WSL_SYSTEM_PROMPT).not.toMatch(/token|password|secret|api[-_ ]?key/i);
  });

  it("explains state ownership, serial calls, reset recovery, and Windows paths", () => {
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/current directory, environment variables and shell functions/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/same agent while its shell remains alive/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/Send commands sequentially and wait for one call to finish before the next/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/Timeout, cancellation or shell exit resets the persistent shell/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/Windows file tools use the corresponding C:\\.* paths/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/In restricted WSL, workdir selects a directory inside the approved workspace/i);
    expect(BASH_WSL_SYSTEM_PROMPT).toMatch(/Explicit full access is not workspace confinement/i);
  });

  it("removes the section when the owning real SystemPrompt/Cordis plugin unloads", async () => {
    const root = new Context();
    const serviceFiber = await root.plugin(SystemPrompt);
    const plugin = Object.assign(
      (ctx: Context) => registerBashWslSystemPrompt(ctx),
      { inject: ["systemPrompt"] },
    );
    let pluginFiber: { ctx: Context; dispose(): Promise<unknown> } | undefined;

    try {
      pluginFiber = await root.plugin(plugin);
      const scope = pluginFiber.ctx;
      let assembly = await root.systemPrompt.assemble({ scope: scope as any });
      expect(assembly.sections).toContainEqual(expect.objectContaining({
        name: BASH_WSL_PROMPT_SECTION,
        text: BASH_WSL_SYSTEM_PROMPT,
        interpolate: false,
      }));
      expect(renderPrompt(assembly)).toContain(BASH_WSL_SYSTEM_PROMPT);

      await pluginFiber.dispose();
      pluginFiber = undefined;
      assembly = await root.systemPrompt.assemble({ scope: scope as any });
      expect(assembly.sections).not.toContainEqual(expect.objectContaining({
        name: BASH_WSL_PROMPT_SECTION,
      }));

      pluginFiber = await root.plugin(plugin);
      assembly = await root.systemPrompt.assemble({ scope: pluginFiber.ctx as any });
      expect(
        assembly.sections.filter(
          (entry: { name?: string }) => entry.name === BASH_WSL_PROMPT_SECTION,
        ),
      ).toHaveLength(1);
    } finally {
      if (pluginFiber !== undefined) await pluginFiber.dispose();
      await serviceFiber.dispose();
      await root.fiber.dispose();
    }
  });
});
