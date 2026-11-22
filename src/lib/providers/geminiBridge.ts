/**
 * Lets the brain route keep speaking Gemini's streaming protocol while the
 * answer comes from somewhere else on the machine:
 *
 *   - an OpenAI-compatible router (9router: /v1/chat/completions), or
 *   - a coding CLI run headless (Claude Code, Gemini CLI).
 *
 * Everything here is pure: a Gemini `streamGenerateContent` request goes in,
 * and Gemini SSE lines (`data: {...}\n\n`) come out, so the route's parser,
 * tool loop and retries do not need to know which backend answered.
 */

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  systemInstruction?: { parts: Array<{ text?: string }> };
  contents: GeminiContent[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number; thinkingConfig?: Record<string, unknown> };
  tools?: Array<Record<string, unknown>>;
  toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
}

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionsRequest {
  model: string;
  stream: true;
  stream_options: { include_usage: true };
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
  tool_choice?: "required";
}

const systemText = (req: GeminiRequest) =>
  (req.systemInstruction?.parts ?? []).map((p) => p.text ?? "").filter(Boolean).join("\n\n");

const visibleText = (parts: GeminiPart[]) =>
  parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("\n\n");

const isForced = (req: GeminiRequest) => req.toolConfig?.functionCallingConfig?.mode === "ANY";

/** Gemini declares schemas with upper-case type names ("OBJECT"); JSON Schema wants them lower-case. */
function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : k === "enum" || k === "required" ? v : toJsonSchema(v);
  }
  return out;
}

export function toChatCompletionsRequest(req: GeminiRequest, model: string): ChatCompletionsRequest {
  const messages: ChatMessage[] = [];
  const system = systemText(req);
  if (system) messages.push({ role: "system", content: system });

  // Gemini pairs a call with its response by position; OpenAI needs an id on both sides.
  let seq = 0;
  const open: Array<{ id: string; name: string }> = [];

  for (const turn of req.contents) {
    if (turn.role === "model") {
      const calls = turn.parts.filter((p) => p.functionCall).map((p) => {
        const id = `call_${++seq}`;
        open.push({ id, name: p.functionCall!.name });
        return { id, type: "function" as const, function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) } };
      });
      const text = visibleText(turn.parts);
      if (!text && !calls.length) continue;
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    for (const p of turn.parts) {
      if (!p.functionResponse) continue;
      const at = open.findIndex((c) => c.name === p.functionResponse!.name);
      const call = at >= 0 ? open.splice(at, 1)[0] : open.shift();
      if (!call) continue; // a response with no call cannot be expressed; drop it rather than break the request
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(p.functionResponse.response ?? {}) });
    }
    const content: ChatContentPart[] = [];
    for (const p of turn.parts) {
      if (typeof p.text === "string" && p.text) content.push({ type: "text", text: p.text });
      else if (p.inlineData) content.push({ type: "image_url", image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } });
    }
    if (!content.length) continue;
    const onlyText = content.every((c) => c.type === "text");
    messages.push({ role: "user", content: onlyText ? content.map((c) => (c as { text: string }).text).join("\n\n") : content });
  }

  const declarations = (req.tools ?? []).flatMap((t) =>
    Array.isArray(t.functionDeclarations) ? (t.functionDeclarations as Array<{ name: string; description?: string; parameters?: unknown }>) : [],
  );
  const tools = declarations.map((d) => ({
    type: "function" as const,
    function: { name: d.name, ...(d.description ? { description: d.description } : {}), parameters: toJsonSchema(d.parameters ?? { type: "object", properties: {} }) },
  }));

  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(typeof req.generationConfig?.temperature === "number" ? { temperature: req.generationConfig.temperature } : {}),
    ...(typeof req.generationConfig?.maxOutputTokens === "number" ? { max_tokens: req.generationConfig.maxOutputTokens } : {}),
    ...(tools.length ? { tools } : {}),
    ...(tools.length && isForced(req) ? { tool_choice: "required" as const } : {}),
  };
}

/* ───────────── output side: Gemini SSE lines ───────────── */

type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };

const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const partsChunk = (parts: GeminiPart[]) => line({ candidates: [{ content: { role: "model", parts } }] });
const finalChunk = (finishReason: string, usage: Usage | null, parts: GeminiPart[] = []) =>
  line({ candidates: [{ ...(parts.length ? { content: { role: "model", parts } } : {}), finishReason }], ...(usage ? { usageMetadata: usage } : {}) });

/** Splits a byte-stream-turned-text into complete lines, keeping the unfinished tail for the next read. */
class LineBuffer {
  private tail = "";
  take(text: string): string[] {
    const all = (this.tail + text).split("\n");
    this.tail = all.pop() ?? "";
    return all;
  }
  rest(): string[] {
    const t = this.tail;
    this.tail = "";
    return t.trim() ? [t] : [];
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const FINISH: Record<string, string> = { stop: "STOP", tool_calls: "STOP", function_call: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

/** OpenAI chat-completions SSE → Gemini SSE. The finish line is held until the stream ends so usage can ride on it. */
export class ChatSseToGemini {
  private lines = new LineBuffer();
  private calls = new Map<number, { name: string; args: string }>();
  private finish: string | null = null;
  private usage: Usage | null = null;
  private done = false;

  push(text: string): string[] {
    return this.lines.take(text).flatMap((l) => this.onLine(l));
  }

  end(): string[] {
    if (this.done) return [];
    this.done = true;
    const out = this.lines.rest().flatMap((l) => this.onLine(l));
    const calls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ functionCall: { name: c.name, args: parseArgs(c.args) } }));
    out.push(finalChunk(FINISH[this.finish ?? "stop"] ?? "STOP", this.usage, calls));
    return out;
  }

  private onLine(raw: string): string[] {
    const l = raw.trim();
    if (!l.startsWith("data:")) return [];
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") return [];
    let j: {
      choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
    };
    try {
      j = JSON.parse(payload);
    } catch {
      return [];
    }
    if (j.usage) {
      const reasoning = j.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      const completion = j.usage.completion_tokens ?? 0;
      const prompt = j.usage.prompt_tokens ?? 0;
      const cached = j.usage.prompt_tokens_details?.cached_tokens;
      this.usage = {
        promptTokenCount: prompt,
        candidatesTokenCount: Math.max(0, completion - reasoning),
        thoughtsTokenCount: reasoning,
        ...(cached ? { cachedContentTokenCount: cached } : {}),
        totalTokenCount: prompt + completion,
      };
    }
    const choice = j.choices?.[0];
    if (!choice) return [];
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const d = choice.delta ?? {};
    const out: string[] = [];
    const thought = d.reasoning_content || d.reasoning;
    if (thought) out.push(partsChunk([{ text: thought, thought: true }]));
    if (d.content) out.push(partsChunk([{ text: d.content }]));
    for (const tc of d.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = this.calls.get(idx) ?? { name: "", args: "" };
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      this.calls.set(idx, cur);
    }
    return out;
  }
}

/* ───────────── CLI backends ───────────── */

export interface CliPrompt {
  system: string;
  prompt: string;
  /** Images of the last user turn only; earlier ones are already described in the conversation. */
  images: Array<{ mimeType: string; data: string }>;
}

const CLI_NOTE =
  "Catatan runtime: di sesi ini tidak ada tool yang bisa dipanggil. Jangan menulis pemanggilan tool; jawab dari percakapan dan dari blok <tool_result> bila ada.";

/** The name the Claude CLI gives a tool of the MCP server Momo declares to it as `momo`. */
export const cliMcpToolName = (tool: string) => `mcp__momo__${tool}`;

/** The runtime note for a CLI run that can call the local MCP tools itself. */
function cliMcpNote(tools: string[]): string {
  return [
    `Catatan runtime: di sesi ini kamu bisa memanggil sendiri tool berikut: ${tools.map((t) => `\`${cliMcpToolName(t)}\``).join(", ")}.`,
    "Tool itu membaca data ASLI milik pengguna di server ini (tool lokal bernama `x` di instruksi lain = `mcp__momo__x` di sini).",
    "Untuk pertanyaan tentang server atau aplikasi milik pengguna, WAJIB panggil tool yang cocok lebih dulu dan jawab dari hasilnya; jangan menebak atau mengarang angka.",
    "Tidak ada tool lain di sesi ini (termasuk web_search): jangan menulis pemanggilan tool lain; untuk hal lain jawab dari percakapan dan dari blok <tool_result> bila ada.",
  ].join(" ");
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [dipotong ${s.length - max} karakter]` : s);

/**
 * A CLI takes one prompt, so the conversation is written out as a transcript.
 * `mcpTools` are the local MCP tools this run can call by itself (bare names); none by default.
 */
export function toCliPrompt(req: GeminiRequest, mcpTools: string[] = []): CliPrompt {
  const note = mcpTools.length ? cliMcpNote(mcpTools) : CLI_NOTE;
  const blocks: string[] = [];
  for (const turn of req.contents) {
    const lines: string[] = [];
    for (const p of turn.parts) {
      if (p.thought) continue;
      if (typeof p.text === "string" && p.text) lines.push(p.text);
      else if (p.functionCall) lines.push(`<tool_call name="${p.functionCall.name}">${JSON.stringify(p.functionCall.args ?? {})}</tool_call>`);
      else if (p.functionResponse) lines.push(`<tool_result name="${p.functionResponse.name}">${clip(JSON.stringify(p.functionResponse.response ?? {}), 12000)}</tool_result>`);
    }
    if (lines.length) blocks.push(`### ${turn.role === "model" ? "Assistant" : "User"}\n${lines.join("\n")}`);
  }
  const last = req.contents[req.contents.length - 1];
  const images = last && last.role === "user" ? last.parts.filter((p) => p.inlineData).map((p) => p.inlineData!) : [];
  const single = blocks.length === 1;
  return {
    system: systemText(req),
    prompt: single
      ? `${blocks[0].replace(/^### User\n/, "")}\n\n${note}`
      : `Percakapan sejauh ini:\n\n${blocks.join("\n\n")}\n\n${note}\nLanjutkan sebagai Assistant: jawab giliran User yang terakhir.`,
    images,
  };
}

/**
 * A CLI backend cannot be made to call Momo's functions. When the route insists
 * on a tool call (it does so to ground a factual question before answering),
 * answer that step ourselves with a web search for what the user typed.
 */
export function forcedToolCallChunk(req: GeminiRequest): string | null {
  if (!isForced(req)) return null;
  const lastUser = [...req.contents].reverse().find((c) => c.role === "user" && c.parts.some((p) => typeof p.text === "string"));
  const typed = (lastUser ? visibleText(lastUser.parts) : "")
    .replace(/<internal_turn_context[\s\S]*?<\/internal_turn_context>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (!typed) return null;
  return finalChunk("STOP", null, [{ functionCall: { name: "web_search", args: { query: typed } } }]);
}

export type CliFlavor = "claude" | "gemini";

/** Headless CLI output (one JSON object per line) → Gemini SSE. */
export class CliJsonToGemini {
  /** Set when the CLI reported a failure; the route turns it into a retry or an error. */
  error: string | null = null;
  private lines = new LineBuffer();
  private done = false;
  private sawDelta = false;
  /** Claude: visible text was sent, so the next assistant turn's text starts a new paragraph. */
  private saidText = false;
  private turnBreak = false;

  constructor(private flavor: CliFlavor) {}

  push(text: string): string[] {
    return this.lines.take(text).flatMap((l) => this.onLine(l));
  }

  end(): string[] {
    const out = this.lines.rest().flatMap((l) => this.onLine(l));
    if (!this.done) {
      this.done = true;
      out.push(finalChunk("STOP", null));
    }
    return out;
  }

  private finish(reason: string, usage: Usage | null): string[] {
    if (this.done) return [];
    this.done = true;
    return [finalChunk(reason, usage)];
  }

  private onLine(raw: string): string[] {
    const l = raw.trim();
    if (!l.startsWith("{")) return [];
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(l);
    } catch {
      return [];
    }
    return this.flavor === "claude" ? this.onClaude(j) : this.onGemini(j);
  }

  /** Text of one Claude turn; a run that used tools has several turns, kept apart by a blank line. */
  private claudeText(text: string): string[] {
    const out = partsChunk([{ text: this.turnBreak ? `\n\n${text}` : text }]);
    this.turnBreak = false;
    this.saidText = true;
    return [out];
  }

  /**
   * `claude -p --output-format stream-json --include-partial-messages`
   *
   * With MCP tools the run is several assistant turns: a turn may end in `tool_use`, the CLI runs
   * the tool and feeds the `tool_result` back as a `user` line, and the next turn goes on. Only
   * text and thinking are passed on; the stream ends at the one final `result` line.
   */
  private onClaude(j: Record<string, unknown>): string[] {
    if (j.type === "stream_event") {
      const ev = j.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
      if (ev?.type === "message_start") {
        this.turnBreak = this.saidText;
        return [];
      }
      if (ev?.type !== "content_block_delta" || !ev.delta) return [];
      if (ev.delta.type === "text_delta" && ev.delta.text) {
        this.sawDelta = true;
        return this.claudeText(ev.delta.text);
      }
      if (ev.delta.type === "thinking_delta" && ev.delta.thinking) return [partsChunk([{ text: ev.delta.thinking, thought: true }])];
      return [];
    }
    if (j.type === "assistant" && !this.sawDelta) {
      // no partial messages came through: fall back to the whole message
      const content = (j.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
      const text = content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
      if (!text) return [];
      this.turnBreak = this.saidText;
      return this.claudeText(text);
    }
    if (j.type === "result") {
      if (j.is_error) {
        this.error = String(j.result || j.subtype || "Claude CLI failed").slice(0, 400);
        return this.finish("OTHER", null);
      }
      const u = (j.usage ?? {}) as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
      const cached = u.cache_read_input_tokens ?? 0;
      const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
      const outTokens = u.output_tokens ?? 0;
      // a run whose text never came through as a message still carries its answer here
      const late = !this.done && !this.saidText && typeof j.result === "string" && j.result ? this.claudeText(j.result) : [];
      return [
        ...late,
        ...this.finish("STOP", {
          promptTokenCount: prompt,
          candidatesTokenCount: outTokens,
          ...(cached ? { cachedContentTokenCount: cached } : {}),
          totalTokenCount: prompt + outTokens,
        }),
      ];
    }
    return [];
  }

  /** `gemini -p … --output-format stream-json` */
  private onGemini(j: Record<string, unknown>): string[] {
    if (j.type === "message" && j.role === "assistant" && typeof j.content === "string" && j.content) {
      return [partsChunk([{ text: j.content }])];
    }
    if (j.type === "error") {
      this.error = String(j.message || j.error || "Gemini CLI failed").slice(0, 400);
      return [];
    }
    if (j.type === "result") {
      if (j.status && j.status !== "success") {
        this.error = this.error ?? String((j.error as { message?: string } | undefined)?.message || j.status).slice(0, 400);
        return this.finish("OTHER", null);
      }
      const s = (j.stats ?? {}) as { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      const prompt = s.input_tokens ?? 0;
      const outTokens = s.output_tokens ?? 0;
      return this.finish("STOP", { promptTokenCount: prompt, candidatesTokenCount: outTokens, totalTokenCount: s.total_tokens ?? prompt + outTokens });
    }
    return [];
  }
}
