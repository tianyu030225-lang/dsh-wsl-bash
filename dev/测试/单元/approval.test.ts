import { describe, expect, it, vi } from "vitest";

import {
  approveOneShotEscalation,
  isStrictWidening,
  type ApprovalContext,
  type ApprovalRequest,
} from "../../../src/tools/approval.js";

const context = (): ApprovalContext => ({
  approver: {},
  agent: { id: "agent-a" },
  callId: "call-1",
  toolName: "git_bash",
  signal: new AbortController().signal,
});

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestedMode: "danger-full-access",
  effectiveMode: "workspace-write",
  justification: "Run the exact approved command",
  subject: "git_bash: exact command",
  ...overrides,
});

describe("approval and exact retry fence", () => {
  it("accepts only a strictly wider mode", () => {
    expect(isStrictWidening("read-only", "workspace-write")).toBe(true);
    expect(isStrictWidening("workspace-write", "danger-full-access")).toBe(true);
    expect(isStrictWidening("workspace-write", "workspace-write")).toBe(false);
    expect(isStrictWidening("danger-full-access", "workspace-write")).toBe(false);
  });

  it("does not call approval for a same-mode request", async () => {
    const approver = vi.fn(async () => "danger-full-access" as const);
    await expect(
      approveOneShotEscalation(
        request({ requestedMode: "workspace-write" }),
        context(),
        approver,
      ),
    ).rejects.toThrow(/strictly widen/);
    expect(approver).not.toHaveBeenCalled();
  });

  it("does not call approval after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const approver = vi.fn(async () => "danger-full-access" as const);
    await expect(
      approveOneShotEscalation(
        request(),
        { ...context(), signal: controller.signal },
        approver,
      ),
    ).rejects.toThrow(/aborted/);
    expect(approver).not.toHaveBeenCalled();
  });

  it("propagates host rejection without spawning", async () => {
    const approver = vi.fn(async () => {
      throw new Error("approval rejected");
    });
    await expect(approveOneShotEscalation(request(), context(), approver)).rejects.toThrow(
      "approval rejected",
    );
    expect(approver).toHaveBeenCalledTimes(1);
  });

  it("requires a non-empty reason for every wider retry", async () => {
    const approver = vi.fn(async () => "danger-full-access" as const);
    await expect(
      approveOneShotEscalation(
        request({ justification: "" }),
        context(),
        approver,
      ),
    ).rejects.toThrow(/justification/);
    expect(approver).not.toHaveBeenCalled();
  });
});
