import type { ChatRequest, ChatResult, LLMError, LLMProvider } from "./types";

export interface RequestMeta {
  empireId: string;
  worldTick: number;
  simTime: number;
  empireRevision: number;
  /** Higher runs first; ties are FIFO. */
  priority: number;
}

export type InferenceStatus = "ok" | "stale" | "failed" | "cancelled";

export interface InferenceResult {
  status: InferenceStatus;
  /** The model's answer when status is "ok"; the fallback otherwise. */
  result: ChatResult;
  error?: LLMError;
  meta: RequestMeta;
  latencyMs: number;
  /** chars / 4 estimates. */
  tokensIn: number;
  tokensOut: number;
}

export interface InferenceHandle {
  promise: Promise<InferenceResult>;
  cancel(): void;
}

export interface LLMManagerOptions {
  maxConcurrent: number;
  /** True if a response for this meta is too old to apply. Checked at dequeue and on response. */
  isStale?: (meta: RequestMeta) => boolean;
  fallback?: ChatResult;
}

interface Job {
  meta: RequestMeta;
  req: ChatRequest;
  seq: number;
  ctrl: AbortController;
  done: boolean;
  resolve: (r: InferenceResult) => void;
}

const EMPTY: ChatResult = { content: "", toolCalls: [] };
const estTokens = (chars: number) => Math.ceil(chars / 4);

export class LLMManager {
  private queue: Job[] = [];
  private running = 0;
  private seq = 0;

  constructor(
    private provider: LLMProvider,
    private o: LLMManagerOptions,
  ) {}

  /** Never rejects: failures resolve with status != "ok" and the fallback result. */
  submit(meta: RequestMeta, req: ChatRequest): InferenceHandle {
    const ctrl = new AbortController();
    let job!: Job;
    const promise = new Promise<InferenceResult>((resolve) => {
      job = { meta, req, seq: this.seq++, ctrl, done: false, resolve };
    });
    this.queue.push(job);
    this.pump();
    return { promise, cancel: () => this.cancel(job) };
  }

  get pending(): number {
    return this.queue.length;
  }

  private cancel(job: Job) {
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.finish(job, "cancelled", 0);
    } else {
      job.ctrl.abort(); // in flight: provider returns "cancelled"
    }
  }

  private finish(
    job: Job,
    status: InferenceStatus,
    latencyMs: number,
    ok?: ChatResult,
    error?: LLMError,
  ) {
    if (job.done) return;
    job.done = true;
    const result = ok ?? this.o.fallback ?? EMPTY;
    job.resolve({
      status,
      result,
      error,
      meta: job.meta,
      latencyMs,
      tokensIn: estTokens(
        job.req.messages.reduce((n, m) => n + m.content.length, 0),
      ),
      tokensOut: estTokens(
        result.content.length + JSON.stringify(result.toolCalls).length,
      ),
    });
  }

  private pump() {
    while (this.running < this.o.maxConcurrent && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[best];
        if (
          a.meta.priority > b.meta.priority ||
          (a.meta.priority === b.meta.priority && a.seq < b.seq)
        )
          best = i;
      }
      const job = this.queue.splice(best, 1)[0];
      if (this.o.isStale?.(job.meta)) {
        this.finish(job, "stale", 0);
        continue;
      }
      this.running++;
      void this.run(job);
    }
  }

  private async run(job: Job) {
    const t0 = performance.now();
    let r: Awaited<ReturnType<LLMProvider["chat"]>>;
    try {
      r = await this.provider.chat({ ...job.req, signal: job.ctrl.signal });
    } catch (e) {
      r = {
        ok: false,
        error: { kind: "offline", message: String((e as Error)?.message ?? e) },
      };
    }
    const ms = Math.round(performance.now() - t0);
    if (!r.ok)
      this.finish(
        job,
        r.error.kind === "cancelled" ? "cancelled" : "failed",
        ms,
        undefined,
        r.error,
      );
    else if (this.o.isStale?.(job.meta)) this.finish(job, "stale", ms);
    else this.finish(job, "ok", ms, r.value);
    this.running--;
    this.pump();
  }
}
