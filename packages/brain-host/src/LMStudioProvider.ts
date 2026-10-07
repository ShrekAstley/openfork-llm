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
  constructor(private o: LMStudioOptions) {}

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Result<any>> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(
        this.o.baseUrl.replace(/\/+$/, "") + path,
        { ...init, headers, signal: sig },
      );
    } catch (e) {
      if (signal?.aborted) return fail("cancelled", "request cancelled");
      if (timeout.aborted)
        return fail("timeout", `no response in ${this.o.timeoutMs}ms`);
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
    if (native)
      body.tools = req.tools!.map((t) => ({ type: "function", function: t }));

    const r = await this.request(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      req.signal,
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
      if (toolCalls.length === 0)
        return fail("malformed", "no tool call in response");
    }
    return { ok: true, value: { content, toolCalls } };
  }
}
