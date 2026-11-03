import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { describe, expect, it } from "vitest";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("DSH alpha.3 installed Cordis lifecycle contracts", () => {
  it("awaits old-instance cleanup before publishing a restarted configuration", async () => {
    const root = new Context();
    const started = barrier();
    const finish = barrier();
    const events: string[] = [];
    const plugin = Object.assign((ctx: Context, config: { timeoutMs: number }) => {
      events.push(`start:${config.timeoutMs}`);
      ctx.effect(() => async () => {
        if (config.timeoutMs === 7) {
          started.release();
          await finish.promise;
        }
        events.push(`closed:${config.timeoutMs}`);
      });
    }, { Config: z.object({ timeoutMs: z.number().default(7) }) });

    try {
      const fiber = await root.plugin(plugin, {});
      expect(fiber.rawConfig).toEqual({});
      expect(fiber.effectiveConfig).toEqual({ timeoutMs: 7 });
      let settled = false;
      const update = Promise.resolve(fiber.update({ timeoutMs: 9 })).then(() => { settled = true; });
      await started.promise;
      expect(settled).toBe(false);
      expect(events).toEqual(["start:7"]);
      finish.release();
      await update;
      expect(events).toEqual(["start:7", "closed:7", "start:9"]);
      expect(fiber.rawConfig).toEqual({ timeoutMs: 9 });
      expect(fiber.effectiveConfig).toEqual({ timeoutMs: 9 });
    } finally {
      finish.release();
      await root.fiber.dispose();
    }
  });

  it("retains an injected process service until dependent asynchronous cleanup completes", async () => {
    const root = new Context();
    const started = barrier();
    const finish = barrier();
    const events: string[] = [];
    const provider = (ctx: Context) => {
      ctx.provide("shellCleanupFixture", { close: () => { events.push("owner-shell-closed"); } });
      ctx.effect(() => () => { events.push("process-provider-disposed"); });
    };
    const consumer = Object.assign((ctx: Context) => {
      ctx.effect(() => async () => {
        started.release();
        await finish.promise;
        // This is the same lifecycle dependency used by persistent-shell
        // teardown: the provider must still be readable by its consumer.
        (ctx as Context & { shellCleanupFixture: { close(): void } }).shellCleanupFixture.close();
      });
    }, { inject: ["shellCleanupFixture"] });

    try {
      const providerFiber = await root.plugin(provider);
      await root.plugin(consumer);
      let settled = false;
      const disposal = providerFiber.dispose().then(() => { settled = true; });
      await started.promise;
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      finish.release();
      await disposal;
      expect(events).toEqual(["owner-shell-closed", "process-provider-disposed"]);
      expect(root.get("shellCleanupFixture", false)).toBeUndefined();
    } finally {
      finish.release();
      await root.fiber.dispose();
    }
  });
});
