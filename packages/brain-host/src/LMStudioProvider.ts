import { remoteEndpointReason } from "./LocalEndpoint";
import type {
  ChatRequest,
  ChatResult,
  LLMError,
  LLMProvider,
  Result,
  ToolCall,
} from "./types";

export interface LMStudioOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** false = no native tools; tools are described in the prompt and parsed from content. */
  toolCalling: boolean;
  /** Only "ollama" changes behaviour (model unloading); all speak the same chat API. */
  backend?: string;
  /** Sampling seed sent with every request, for repeatable runs. */
  seed?: number;
  fetch?: typeof fetch;
}

const fail = (kind: LLMError["kind"], message: string, status?: number) =>
  ({ ok: false, error: { kind, message, status } }) as const;

/** Strictly extracts JSON from plain text, a ```json fence, or the first balanced {...}/[...]. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) candidates.push(fence[1].trim());
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{" && t[i] !== "[") continue;
    const end = balancedEnd(t, i);
    if (end > 0) candidates.push(t.slice(i, end + 1));
    break;
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/** Accepts {"tool_calls":[...]}, a single {"name","arguments"}, or an array of those. */
export function parseToolCallsFromContent(text: string): ToolCall[] {
  const json = extractJson(text) as any;
  const list: any[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.tool_calls)
      ? json.tool_calls
      : json
        ? [json]
        : [];
  return list
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({
      name: c.name,
      arguments:
        c.arguments && typeof c.arguments === "object" ? c.arguments : {},
    }));
}

export class LMStudioProvider implements LLMProvider {
  constructor(private o: LMStudioOptions) {
    const why = remoteEndpointReason(o.baseUrl);
    if (why) throw new Error(`refusing ${o.baseUrl}: ${why}`);
  }

  /** Ollama only: keep_alive 0 drops the model from memory. */
  async unload(model: string): Promise<Result<void>> {
    if (this.o.backend !== "ollama") return { ok: true, value: undefined };
    const origin = new URL(this.o.baseUrl).origin;
    const r = await this.request(
      "/api/generate",
      { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) },
      undefined,
      origin,
    );
    return r.ok ? { ok: true, value: undefined } : r;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    base: string = this.o.baseUrl,
    timeoutMs: number = this.o.timeoutMs,
  ): Promise<Result<any>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(
        base.replace(/\/+$/, "") + path,
        // A redirect could carry the prompt to another host.
        { ...init, headers, signal: sig, redirect: "error" },
      );
    } catch (e) {
      if (signal?.aborted) return fail("cancelled", "request cancelled");
      if (timeout.aborted)
        return fail("timeout", `no response in ${timeoutMs}ms`);
      return fail("offline", String((e as Error)?.message ?? e));
    }
    if (!res.ok) {
      // The server's own explanation ("no models loaded", "tools not
      // supported"...) is what tells the user what to fix.
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ");
      return fail(
        "bad_status",
        `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    try {
      return { ok: true, value: await res.json() };
    } catch {
      if (signal?.aborted) return fail("cancelled", "request cancelled");
      if (timeout.aborted) return fail("timeout", "body read timed out");
      return fail("malformed", "response body is not JSON");
    }
  }

  async listModels(): Promise<Result<string[]>> {
    const r = await this.request("/models", { method: "GET" });
    if (!r.ok) return r;
    if (!Array.isArray(r.value?.data))
      return fail("malformed", "no data[] in /models");
    return { ok: true, value: r.value.data.map((m: any) => String(m.id)) };
  }

  async chat(req: ChatRequest): Promise<Result<ChatResult>> {
    const model = req.model ?? this.o.model;
    const wantTools = !!req.tools?.length;
    const native = wantTools && this.o.toolCalling;
    const messages = [...req.messages];
    if (wantTools && !native) {
      messages.unshift({
        role: "system",
        content:
          'Respond ONLY with JSON: {"tool_calls":[{"name":string,"arguments":object}]}. Available tools: ' +
          JSON.stringify(req.tools),
      });
    }
    const body: Record<string, unknown> = {
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: false,
    };
    if (model) body.model = model;
    if (this.o.seed !== undefined) body.seed = this.o.seed;
    if (native)
      body.tools = req.tools!.map((t) => ({ type: "function", function: t }));

    const r = await this.request(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      req.signal,
      undefined,
      req.timeoutMs,
    );
    if (!r.ok) return r;
    const msg = r.value?.choices?.[0]?.message;
    if (!msg) return fail("malformed", "no choices[0].message");
    const content: string = typeof msg.content === "string" ? msg.content : "";

    let toolCalls: ToolCall[] = [];
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const c of msg.tool_calls) {
        let args: unknown = c?.function?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            return fail("malformed", "tool_call arguments are not JSON");
          }
        }
        if (typeof c?.function?.name !== "string")
          return fail("malformed", "tool_call without name");
        toolCalls.push({
          id: c.id,
          name: c.function.name,
          arguments: (args as Record<string, unknown>) ?? {},
        });
      }
    } else if (wantTools) {
      toolCalls = parseToolCallsFromContent(content);
      // Reasoning models keep their answer in a separate field, or spend the
      // whole token budget thinking and leave the content empty.
      const reasoning: string =
        typeof msg.reasoning_content === "string"
          ? msg.reasoning_content
          : typeof msg.reasoning === "string"
            ? msg.reasoning
            : "";
      if (toolCalls.length === 0 && reasoning)
        toolCalls = parseToolCallsFromContent(reasoning);
      if (toolCalls.length === 0) {
        const finish = r.value?.choices?.[0]?.finish_reason;
        const said = content.replace(/\s+/g, " ").trim().slice(0, 160);
        return fail(
          "malformed",
          `no tool call in response (finish_reason ${finish ?? "?"}` +
            `${reasoning ? `, ${reasoning.length} chars of reasoning` : ""}` +
            `${said ? `, model said: "${said}"` : ", empty reply"})` +
            (finish === "length"
              ? "; the reply hit maxOutputTokens, raise it"
              : ""),
        );
      }
    }
    return { ok: true, value: { content, toolCalls } };
  }
}
