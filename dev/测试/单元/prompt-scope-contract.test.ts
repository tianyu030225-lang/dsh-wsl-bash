import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASH_WSL_PROMPT_SECTION,
  BASH_WSL_SYSTEM_PROMPT,
  GIT_BASH_SYSTEM_PROMPT,
  registerBashWslSystemPrompt,
} from "../../../src/prompt.js";

describe("shell-specific system prompt guidance", () => {
  it.each([
    ["WSL", BASH_WSL_SYSTEM_PROMPT],
    ["Git Bash", GIT_BASH_SYSTEM_PROMPT],
  ])("documents the real command-only interface and recovery boundaries in %s mode", (_mode, text) => {
    expect(text).toContain("bash accepts only command");
    expect(text).toContain("Do not invent description, workdir, timeoutMs, session_id, reset, close or stdin parameters");
    expect(text).toContain("cd -- 'src folder'");
    expect(text).toContain("no follow-up input or keypress interface");
    expect(text).toContain("only partial output when a command is waiting for input");
    expect(text).toContain("actual completion/exit status");
    expect(text).toContain("Truncated output is incomplete evidence");
    expect(text).toContain("pwsh returns a background job ID");
    expect(text).toContain("Reset does not roll back file changes or external side effects");
    expect(text).toContain("inspect the actual state before retrying");
    expect(text).toContain("use bash with command exit");
    expect(text).toContain("closing the owner shell can terminate those descendants");
    expect(text).toContain("Persistent Git Bash is denied before process creation without standing session full access");
    expect(text).toContain("one-shot git_bash may use standing full access or one exact host-approved retry of the same command and cwd");
    expect(text).toContain("that one-shot grant never authorizes a persistent shell or changes default permissions");
  });

  it("preserves Windows build targets without treating an interop denial as authorization", () => {
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("Preserve the project's existing target platform, runtime and native dependency/build target");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("using WSL does not authorize changing a Windows-targeted project to Linux binaries or dependencies");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("an interop denial is not permission to bypass it");
  });

  it("registers the WSL environment and path contract literally", () => {
    const section = vi.fn();
    const getSectionOrder = vi.fn(() => 1700);

    registerBashWslSystemPrompt({
      systemPrompt: { section, getSectionOrder },
    } as any);

    expect(section).toHaveBeenCalledWith({
      name: BASH_WSL_PROMPT_SECTION,
      order: 1701,
      text: BASH_WSL_SYSTEM_PROMPT,
      interpolate: false,
    });
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("Ubuntu");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("/mnt/c/...");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("C:\\...");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("wsl_bash");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("git_bash");
    expect(BASH_WSL_SYSTEM_PROMPT).toContain("pwsh");
    expect(BASH_WSL_SYSTEM_PROMPT).not.toContain("native Git for Windows, not WSL");
  });

  it("registers Git Bash mode with native Windows paths and explicit permission scope", () => {
    const section = vi.fn();
    const getSectionOrder = vi.fn(() => 1700);

    registerBashWslSystemPrompt({
      systemPrompt: { section, getSectionOrder },
    } as any, "git-bash");

    expect(section).toHaveBeenCalledWith({
      name: BASH_WSL_PROMPT_SECTION,
      order: 1701,
      text: GIT_BASH_SYSTEM_PROMPT,
      interpolate: false,
    });
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("native Git for Windows");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("/c/...");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("/mnt/c/...");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("danger-full-access");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("selecting Git Bash mode never changes permissions");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("wsl_bash");
    expect(GIT_BASH_SYSTEM_PROMPT).toContain("pwsh");
    expect(GIT_BASH_SYSTEM_PROMPT).not.toMatch(
      /(?:[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/\r\n]+|\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/[^\/\r\n]+)/i,
    );
    expect(GIT_BASH_SYSTEM_PROMPT).not.toMatch(/token|password|secret|api[-_ ]?key/i);
  });
});

describe("system prompt scope and lifecycle", () => {
  let root: Context | undefined;
  let serviceFiber: { dispose(): Promise<unknown> } | undefined;
  let pluginFiber: { ctx: Context; dispose(): Promise<unknown> } | undefined;

  afterEach(async () => {
    if (pluginFiber !== undefined) await pluginFiber.dispose();
    if (serviceFiber !== undefined) await serviceFiber.dispose();
    if (root !== undefined) await root.fiber.dispose();
    pluginFiber = undefined;
    serviceFiber = undefined;
    root = undefined;
  });

  it("only exposes the selected shell environment in the owning scope and removes it on unload", async () => {
    root = new Context();
    serviceFiber = await root.plugin(SystemPrompt);
    const plugin = Object.assign(
      (ctx: Context) => registerBashWslSystemPrompt(ctx, "git-bash"),
      { inject: ["systemPrompt"] },
    );

    pluginFiber = await root.plugin(plugin);
    const scope = pluginFiber.ctx;
    let assembly = await root.systemPrompt.assemble({ scope: scope as any });
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: BASH_WSL_PROMPT_SECTION,
      text: GIT_BASH_SYSTEM_PROMPT,
      interpolate: false,
    }));
    expect(renderPrompt(assembly)).toContain("native Git for Windows");
    expect(renderPrompt(assembly)).not.toContain("configured WSL distribution (Ubuntu by default)");

    await pluginFiber.dispose();
    pluginFiber = undefined;
    assembly = await root.systemPrompt.assemble({ scope: scope as any });
    expect(assembly.sections).not.toContainEqual(expect.objectContaining({
      name: BASH_WSL_PROMPT_SECTION,
    }));
  });

  it("keeps global, WSL, Git Bash, and child-agent scopes isolated through the official dsh-scope API", async () => {
    root = new Context();
    serviceFiber = await root.plugin(SystemPrompt);
    const hostAnchor = realpathSync.native(
      resolve(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "package.json"),
    );
    const hostRequire = createRequire(hostAnchor);
    const scopeApi = await import(
      pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-scope")).href,
    ) as {
      createScope: (
        ctx: Context,
        key: object,
        options?: { parent?: object },
      ) => { ctx: Context; dispose(): Promise<unknown> };
      scopeOf: (ctx: Context) => object | undefined;
    };

    const globalPlugin = Object.assign(
      (ctx: Context) => registerBashWslSystemPrompt(ctx, "wsl"),
      { inject: ["systemPrompt"] },
    );
    const globalFiber = await root.plugin(globalPlugin);
    const wslKey = {};
    const gitKey = {};
    const wslScope = scopeApi.createScope(globalFiber.ctx, wslKey);
    const gitScope = scopeApi.createScope(globalFiber.ctx, gitKey);
    const wslAgentScope = scopeApi.createScope(wslScope.ctx, {}, { parent: wslKey });
    const gitAgentScope = scopeApi.createScope(gitScope.ctx, {}, { parent: gitKey });

    const sectionText = async (scope: Context): Promise<string> => {
      const scopeKey = scopeApi.scopeOf(scope);
      const assembly = await root!.systemPrompt.assemble(
        scopeKey === undefined ? {} : { scope: scopeKey },
      );
      const section = assembly.sections.find((entry) => entry.name === BASH_WSL_PROMPT_SECTION);
      return section?.text ?? "";
    };

    try {
      registerBashWslSystemPrompt(wslScope.ctx, "wsl");
      registerBashWslSystemPrompt(gitScope.ctx, "git-bash");

      await expect(sectionText(root)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(wslScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(wslAgentScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(gitScope.ctx)).resolves.toBe(GIT_BASH_SYSTEM_PROMPT);
      await expect(sectionText(gitAgentScope.ctx)).resolves.toBe(GIT_BASH_SYSTEM_PROMPT);

      await gitScope.dispose();
      await expect(sectionText(gitScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(gitAgentScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(root)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);

      await wslScope.dispose();
      await expect(sectionText(wslScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(wslAgentScope.ctx)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
      await expect(sectionText(root)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);

      const freshGitScope = scopeApi.createScope(globalFiber.ctx, {});
      try {
        registerBashWslSystemPrompt(freshGitScope.ctx, "git-bash");
        await expect(sectionText(freshGitScope.ctx)).resolves.toBe(GIT_BASH_SYSTEM_PROMPT);
      } finally {
        await freshGitScope.dispose();
      }
      await expect(sectionText(root)).resolves.toBe(BASH_WSL_SYSTEM_PROMPT);
    } finally {
      await wslAgentScope.dispose();
      await gitAgentScope.dispose();
      await wslScope.dispose();
      await gitScope.dispose();
      await globalFiber.dispose();
    }
  });
});
