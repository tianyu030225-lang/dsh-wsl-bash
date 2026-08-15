/**
 * The small adapter around DSH's rc.6 escalation seam.
 *
 * Keeping this adapter in the tool layer is intentional: the executable
 * runners do not decide whether a user has approved an elevation.  They only
 * receive the resulting mode.  This makes it possible to test argv and
 * fail-closed behaviour without constructing a Cordis context.
 */

import { approveEscalation as dshApproveEscalation } from "@deepseek-ai/dsh-sandbox";
import type { EscalationApproval } from "@deepseek-ai/dsh-sandbox";

export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export interface ApprovalRequest {
  requestedMode: SandboxMode;
  justification: string;
  effectiveMode: SandboxMode;
  subject: string;
}

/** The exact approval ingredients used by the official rc.6 tools. */
export interface ApprovalContext {
  /** Kept structurally loose so host mocks can be used in tests. */
  approver: unknown;
  agent: unknown;
  callId: string;
  toolName: string;
  signal: AbortSignal;
}

export type ApproveEscalation = (
  request: ApprovalRequest,
  context: ApprovalContext,
) => Promise<SandboxMode>;

/**
 * Call the official rc.6 helper.  Do not replace this with an ad-hoc prompt:
 * rc.6 owns strict widening, approval-channel selection, and rejection
 * semantics.
 */
export const approveEscalation: ApproveEscalation = async (request, context) =>
  (await dshApproveEscalation(
    request,
    context as unknown as EscalationApproval<unknown, string>,
  )) as SandboxMode;

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" &&
    (SANDBOX_MODES as readonly string[]).includes(value);
}

export function validateSandboxRequest(
  mode: unknown,
  justification: unknown,
): asserts mode is SandboxMode {
  if (!isSandboxMode(mode)) {
    throw new Error(`invalid sandbox_permissions: ${JSON.stringify(mode)}`);
  }
  if (typeof justification !== "string" || justification.trim().length === 0) {
    throw new Error("sandbox_permissions requires a non-empty justification");
  }
}

/**
 * A local guard used before the official helper.  The helper remains the
 * authority; this guard only prevents a malformed request from reaching it.
 */
export function isStrictWidening(
  effectiveMode: SandboxMode,
  requestedMode: SandboxMode,
): boolean {
  const rank: Record<SandboxMode, number> = {
    "read-only": 0,
    "workspace-write": 1,
    "danger-full-access": 2,
  };
  return rank[requestedMode] > rank[effectiveMode];
}

export async function approveOneShotEscalation(
  request: ApprovalRequest,
  context: ApprovalContext,
  approver: ApproveEscalation = approveEscalation,
): Promise<SandboxMode> {
  validateSandboxRequest(request.requestedMode, request.justification);
  if (!isStrictWidening(request.effectiveMode, request.requestedMode)) {
    throw new Error(
      `sandbox_permissions must strictly widen ${request.effectiveMode}; ` +
      `got ${request.requestedMode}`,
    );
  }
  if (context.signal.aborted) {
    throw new Error("tool call aborted before sandbox escalation");
  }
  return approver(request, context);
}
