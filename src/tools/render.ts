import { renderCapturedOutput, type CapturedOutput } from "./output.js";
import type { SandboxMode } from "./approval.js";

export interface OneShotRenderable {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: Pick<CapturedOutput, "text" | "truncated" | "spillPath" | "overflowed">;
  stderr: Pick<CapturedOutput, "text" | "truncated" | "spillPath" | "overflowed">;
  failure?: { kind: string; message: string } | undefined;
  sandbox?: {
    mode: SandboxMode;
    enforcement: "bwrap" | "none";
    denied: boolean;
    runnerFailed?: boolean | undefined;
  } | undefined;
}

/** Render one-shot output with the same markers used by the official rc.6 tools. */
export function renderOneShotResult(result: OneShotRenderable): string {
  let body = renderCapturedOutput(result.stdout);
  const stderr = renderCapturedOutput(result.stderr);
  if (stderr.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${stderr}`;
  }
  if (body.length === 0) body = "(no output)";

  const markers: string[] = [];
  if (result.sandbox?.runnerFailed) {
    markers.push(`[sandbox: runner failed under ${result.sandbox.mode} mode; the command may not have run]`);
  } else if (result.sandbox?.denied && result.sandbox.enforcement === "bwrap") {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`);
  }
  if (result.failure?.kind === "sandbox-unavailable") {
    markers.push(`[sandbox: unavailable — ${result.failure.message}]`);
  } else if (result.failure?.kind === "sandbox-denied" && !result.sandbox?.denied) {
    markers.push(`[sandbox: request denied — ${result.failure.message}]`);
  }
  if (result.aborted) markers.push("[aborted]");
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== null && result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return `${body}${markers.join("\n")}`;
}
