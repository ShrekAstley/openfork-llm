export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  /** Overrides the provider's default model (per-empire override). */
  model?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export type LLMErrorKind =
  | "offline"
  | "timeout"
  | "bad_status"
  | "malformed"
  | "cancelled";

export interface LLMError {
  kind: LLMErrorKind;
  message: string;
  status?: number;
}

/** Providers never throw; failures are returned. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: LLMError };

export interface LLMProvider {
  chat(req: ChatRequest): Promise<Result<ChatResult>>;
  listModels(): Promise<Result<string[]>>;
}
