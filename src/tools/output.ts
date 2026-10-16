import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MEMORY_LIMIT = 64 * 1024;
export const DEFAULT_SPILL_LIMIT = 64 * 1024 * 1024;

export interface CapturedOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
  /** Exact only for the local BoundedCapture implementation. */
  spillBytes?: number;
  /** Exact only when the producing seam exposes whole-stream byte offsets. */
  totalBytes?: number;
  /** Undefined when the producing seam does not expose spill-cap overflow. */
  overflowed?: boolean;
}

export interface CaptureOptions {
  memoryLimit?: number | undefined;
  spillLimit?: number | undefined;
  spillDirectory?: string | undefined;
  streamName?: string | undefined;
}

/**
 * Bounded output capture.  The visible value is the tail (matching the DSH
 * shell tools), while a separate spill file receives up to spillLimit bytes
 * from the complete stream.  No unbounded string/Buffer is retained.
 */
export class BoundedCapture {
  readonly memoryLimit: number;
  readonly spillLimit: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private tailTruncated = false;
  private fd: number | undefined;
  private spillPathValue: string | undefined;
  private spillBytesValue = 0;
  private totalBytesValue = 0;
  private overflowedValue = false;
  private spillDisabled = false;
  private ended = false;
  private readonly preSpill: Buffer[] = [];
  private preSpillBytes = 0;

  constructor(private readonly options: CaptureOptions = {}) {
    this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.spillLimit = options.spillLimit ?? DEFAULT_SPILL_LIMIT;
    if (!Number.isSafeInteger(this.memoryLimit) || this.memoryLimit <= 0) {
      throw new Error("memoryLimit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.spillLimit) || this.spillLimit <= 0) {
      throw new Error("spillLimit must be a positive safe integer");
    }
  }

  append(chunk: Buffer | string): void {
    if (this.ended) throw new Error("cannot append after capture end");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return;
    this.totalBytesValue += bytes.length;
    this.writeSpill(bytes);
    this.appendTail(bytes);
  }

  end(): CapturedOutput {
    if (!this.ended) {
      const trailing = this.decoder.end();
      if (trailing.length > 0) this.appendTail(Buffer.from(trailing));
      if (this.fd !== undefined) {
        closeSync(this.fd);
        this.fd = undefined;
      }
      this.ended = true;
    }
    const text = Buffer.concat(this.tail, this.tailBytes).toString("utf8");
    return {
      text,
      truncated: this.totalBytesValue > this.memoryLimit || this.tailTruncated,
      ...(this.spillPathValue === undefined ? {} : { spillPath: this.spillPathValue }),
      spillBytes: this.spillBytesValue,
      totalBytes: this.totalBytesValue,
      overflowed: this.overflowedValue,
    };
  }

  private appendTail(bytes: Buffer): void {
    // Decode each chunk before retaining it so a UTF-8 code point split across
    // stream chunks cannot produce replacement characters in the visible tail.
    const decoded = this.decoder.write(bytes);
    if (decoded.length === 0) return;
    const data = Buffer.from(decoded);
    this.tail.push(data);
    this.tailBytes += data.length;
    while (this.tailBytes > this.memoryLimit && this.tail.length > 0) {
      this.tailTruncated = true;
      const first = this.tail[0]!;
      const excess = this.tailBytes - this.memoryLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        continue;
      }
      const sliced = first.subarray(excess);
      let continuation = 0;
      // Never expose a UTF-8 continuation byte at the beginning of the tail.
      // The decoder guarantees that `first` started at a code-point boundary;
      // dropping the partial prefix preserves that invariant for the next
      // stream chunk and avoids U+FFFD in model-visible output.
      while (continuation < sliced.length &&
        (sliced[continuation]! & 0xc0) === 0x80) continuation += 1;
      this.tail[0] = sliced.subarray(continuation);
      this.tailBytes -= excess + continuation;
      break;
    }
  }

  private writeSpill(bytes: Buffer): void {
    if (this.spillDisabled) {
      this.overflowedValue = true;
      return;
    }
    // Do not create spill files for ordinary, bounded output.  Once the
    // visible-memory budget is crossed, flush the bounded prefix followed by
    // the current chunk to make the spill a complete stream (until its own
    // hard cap).
    if (this.fd === undefined && this.totalBytesValue <= this.memoryLimit) {
      this.preSpill.push(Buffer.from(bytes));
      this.preSpillBytes += bytes.length;
      return;
    }
    if (this.fd === undefined) {
      try {
        this.openSpill();
        for (const prefix of this.preSpill) {
          this.writeSpillChunk(prefix);
          if (this.spillBytesValue >= this.spillLimit) break;
        }
        this.preSpill.length = 0;
        this.preSpillBytes = 0;
      } catch {
        // A spill failure must not turn an otherwise bounded command output
        // event into an uncaught process exception.  Keep the visible tail and
        // report that the hard spill guarantee was unavailable.
        this.spillDisabled = true;
        this.overflowedValue = true;
        return;
      }
    }
    try {
      this.writeSpillChunk(bytes);
    } catch {
      this.spillDisabled = true;
      this.overflowedValue = true;
    }
  }

  private writeSpillChunk(bytes: Buffer): void {
    if (this.spillBytesValue >= this.spillLimit) {
      this.overflowedValue = true;
      return;
    }
    const remaining = this.spillLimit - this.spillBytesValue;
    const write = bytes.subarray(0, remaining);
    if (write.length > 0) {
      if (this.fd === undefined) this.openSpill();
      writeSync(this.fd!, write);
      this.spillBytesValue += write.length;
    }
    if (write.length !== bytes.length) this.overflowedValue = true;
  }

  private openSpill(): void {
    const root = this.options.spillDirectory ?? tmpdir();
    mkdirSync(root, { recursive: true });
    let directory = join(root, "dsh-bash-spill");
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    chmodSync(directory, 0o700);
    const name = `${this.options.streamName ?? "stream"}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
    this.spillPathValue = join(directory, name);
    this.fd = openSync(this.spillPathValue, "wx", 0o600);
  }
}

export function renderCapturedOutput(output: CapturedOutput): string {
  if (!output.truncated && output.overflowed !== true) return output.text;
  const path = output.spillPath ?? "(unavailable)";
  const suffix = output.overflowed === true ? "; spill limit reached" : "";
  return `${output.text}\n[output truncated; full output: ${path}${suffix}]`;
}
