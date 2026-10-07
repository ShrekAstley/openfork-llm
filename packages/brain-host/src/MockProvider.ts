import type {
  ChatRequest,
  ChatResult,
  LLMProvider,
  Result,
  ToolCall,
} from "./types";

/** A scripted LLM for tests and offline runs (`brain:run -- --mock`). */
export class MockProvider implements LLMProvider {
  readonly calls: ChatRequest[] = [];

  constructor(
    private respond: (
      req: ChatRequest,
      n: number,
    ) => Result<ChatResult> | Promise<Result<ChatResult>> = () =>
      MockProvider.tools([
        {
          name: "plan",
          arguments: { objective: "expand", summary: "grab land" },
        },
        { name: "attack", arguments: { target: "wilderness", percent: 20 } },
      ]),
  ) {}

  static tools(toolCalls: ToolCall[]): Result<ChatResult> {
    return { ok: true, value: { content: "", toolCalls } };
  }

  async chat(req: ChatRequest): Promise<Result<ChatResult>> {
    this.calls.push(req);
    return this.respond(req, this.calls.length - 1);
  }

  async listModels(): Promise<Result<string[]>> {
    return { ok: true, value: ["mock"] };
  }
}
