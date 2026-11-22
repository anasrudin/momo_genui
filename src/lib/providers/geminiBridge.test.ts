import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatSseToGemini,
  CliJsonToGemini,
  forcedToolCallChunk,
  toChatCompletionsRequest,
  toCliPrompt,
  type GeminiRequest,
} from "./geminiBridge";
import { pickModelCatalog, MOMO_ALL_MODELS } from "../modelCatalog";

const REQUEST: GeminiRequest = {
  systemInstruction: { parts: [{ text: "Kamu Momo." }] },
  contents: [
    { role: "user", parts: [{ text: "Harga emas?" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
    {
      role: "model",
      parts: [
        { text: "diam-diam berpikir", thought: true },
        { text: "Saya cari dulu." },
        { functionCall: { name: "web_search", args: { query: "harga emas" } } },
        { functionCall: { name: "search_images", args: { query: "emas batangan" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "web_search", response: { results: [{ title: "Antam", url: "https://a.example" }] } } },
        { functionResponse: { name: "search_images", response: { images: [] } } },
      ],
    },
  ],
  generationConfig: { temperature: 0.4, maxOutputTokens: 32768, thinkingConfig: { includeThoughts: true } },
  tools: [
    { google_search: {} },
    {
      functionDeclarations: [
        {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "OBJECT",
            required: ["query"],
            properties: { query: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } }, n: { type: "NUMBER" } },
          },
        },
      ],
    },
  ],
};

test("chat request: system prompt, text and image become OpenAI messages", () => {
  const out = toChatCompletionsRequest(REQUEST, "ag/gemini-3-flash");
  assert.equal(out.model, "ag/gemini-3-flash");
  assert.equal(out.stream, true);
  assert.deepEqual(out.messages[0], { role: "system", content: "Kamu Momo." });
  assert.deepEqual(out.messages[1], {
    role: "user",
    content: [
      { type: "text", text: "Harga emas?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  });
});

test("chat request: function calls and their responses are paired by id, thoughts are dropped", () => {
  const { messages } = toChatCompletionsRequest(REQUEST, "m");
  const assistant = messages[2] as { role: string; content: string | null; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "Saya cari dulu.");
  assert.deepEqual(assistant.tool_calls.map((c) => c.function.name), ["web_search", "search_images"]);
  assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"harga emas"}');
  const tools = messages.slice(3) as Array<{ role: string; tool_call_id: string; content: string }>;
  assert.deepEqual(tools.map((t) => t.role), ["tool", "tool"]);
  assert.deepEqual(tools.map((t) => t.tool_call_id), assistant.tool_calls.map((c) => c.id));
  assert.match(tools[0].content, /Antam/);
  assert.ok(!JSON.stringify(messages).includes("diam-diam"));
});

test("chat request: Gemini tool schema becomes JSON Schema, google_search is dropped", () => {
  const out = toChatCompletionsRequest(REQUEST, "m");
  assert.equal(out.tools?.length, 1);
  assert.deepEqual(out.tools?.[0], {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, tags: { type: "array", items: { type: "string" } }, n: { type: "number" } },
      },
    },
  });
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.temperature, 0.4);
  assert.equal(out.max_tokens, 32768);
});

test("chat request: forced function calling maps to tool_choice required; no tools → none sent", () => {
  const forced = toChatCompletionsRequest(
    { ...REQUEST, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["web_search"] } } },
    "m",
  );
  assert.equal(forced.tool_choice, "required");
  const plain = toChatCompletionsRequest({ ...REQUEST, tools: undefined }, "m");
  assert.equal(plain.tools, undefined);
});

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l.replace(/^data: /, "").trim()));

test("chat stream: text and reasoning deltas become Gemini parts, even when a line is split across reads", () => {
  const b = new ChatSseToGemini();
  const wire =
    sse({ choices: [{ delta: { role: "assistant", content: "Ha" } }] }) +
    sse({ choices: [{ delta: { reasoning_content: "hmm" } }] }) +
    sse({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }) +
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } }) +
    "data: [DONE]\n\n";
  const cut = 31;
  const out = parse([...b.push(wire.slice(0, cut)), ...b.push(wire.slice(cut)), ...b.end()]);
  assert.deepEqual(out[0].candidates[0].content.parts, [{ text: "Ha" }]);
  assert.deepEqual(out[1].candidates[0].content.parts, [{ text: "hmm", thought: true }]);
  assert.deepEqual(out[2].candidates[0].content.parts, [{ text: "lo" }]);
  const last = out[out.length - 1];
  assert.equal(last.candidates[0].finishReason, "STOP");
  assert.deepEqual(last.usageMetadata, { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 13 });
});

test("chat stream: tool-call fragments are assembled into one functionCall with parsed args", () => {
  const b = new ChatSseToGemini();
  const out = parse([
    ...b.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"que' } }] } }] })),
    ...b.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"emas"}' } }, { index: 1, id: "c2", function: { name: "search_images", arguments: "{}" } }] } }] })),
    ...b.push(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
    ...b.end(),
  ]);
  const parts = out.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
  assert.deepEqual(parts, [
    { functionCall: { name: "web_search", args: { query: "emas" } } },
    { functionCall: { name: "search_images", args: {} } },
  ]);
  assert.equal(out[out.length - 1].candidates[0].finishReason, "STOP");
});

test("chat stream: length and content_filter keep their meaning; a stream that just ends still finishes", () => {
  const a = new ChatSseToGemini();
  const cut = parse([...a.push(sse({ choices: [{ delta: { content: "x" }, finish_reason: "length" }] })), ...a.end()]);
  assert.equal(cut[cut.length - 1].candidates[0].finishReason, "MAX_TOKENS");
  const f = new ChatSseToGemini();
  const filtered = parse([...f.push(sse({ choices: [{ delta: {}, finish_reason: "content_filter" }] })), ...f.end()]);
  assert.equal(filtered[filtered.length - 1].candidates[0].finishReason, "SAFETY");
  const s = new ChatSseToGemini();
  const silent = parse([...s.push(sse({ choices: [{ delta: { content: "x" } }] })), ...s.end()]);
  assert.equal(silent[silent.length - 1].candidates[0].finishReason, "STOP");
});

test("cli prompt: history, tool results and the last user turn are flattened; images come out separately", () => {
  const p = toCliPrompt(REQUEST);
  assert.equal(p.system, "Kamu Momo.");
  assert.match(p.prompt, /Harga emas\?/);
  assert.match(p.prompt, /Saya cari dulu\./);
  assert.match(p.prompt, /<tool_result name="web_search">[\s\S]*Antam/);
  assert.ok(!p.prompt.includes("diam-diam"));
  assert.ok(!p.prompt.includes("AAAA"), "image bytes must not be pasted into the prompt text");
  assert.deepEqual(p.images, []); // the image belongs to an earlier turn, only the last turn's images are sent
  const withImage = toCliPrompt({ ...REQUEST, contents: [REQUEST.contents[0]] });
  assert.deepEqual(withImage.images, [{ mimeType: "image/png", data: "AAAA" }]);
});

test("cli: a forced tool step is answered with a web_search call built from the user's own words", () => {
  const forced: GeminiRequest = {
    ...REQUEST,
    contents: [{ role: "user", parts: [{ text: '<internal_turn_context do_not_echo="true">\naturan\n</internal_turn_context>\n\nHarga emas hari ini berapa?' }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["web_search", "search_images"] } },
  };
  const chunk = JSON.parse(forcedToolCallChunk(forced)!.replace(/^data: /, ""));
  assert.deepEqual(chunk.candidates[0].content.parts, [{ functionCall: { name: "web_search", args: { query: "Harga emas hari ini berapa?" } } }]);
  assert.equal(chunk.candidates[0].finishReason, "STOP");
  assert.equal(forcedToolCallChunk(REQUEST), null);
});

test("claude cli stream: text deltas, thinking deltas, then usage and STOP from the result line", () => {
  const c = new CliJsonToGemini("claude");
  const out = parse([
    ...c.push(JSON.stringify({ type: "system", subtype: "init", tools: [] }) + "\n"),
    ...c.push(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Apel" } } }) + "\n"),
    ...c.push(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }) + "\n"),
    ...c.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Apel" }] } }) + "\n"),
    ...c.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 50, output_tokens: 15 } }) + "\n"),
    ...c.end(),
  ]);
  assert.deepEqual(out[0].candidates[0].content.parts, [{ text: "Apel" }]);
  assert.deepEqual(out[1].candidates[0].content.parts, [{ text: "hmm", thought: true }]);
  assert.equal(out.length, 3, "the full assistant message must not repeat the streamed text");
  assert.equal(out[2].candidates[0].finishReason, "STOP");
  assert.deepEqual(out[2].usageMetadata, { promptTokenCount: 652, candidatesTokenCount: 15, cachedContentTokenCount: 50, totalTokenCount: 667 });
  assert.equal(c.error, null);
});

test("claude cli stream: an error result is reported, not turned into an answer", () => {
  const c = new CliJsonToGemini("claude");
  const out = parse([...c.push(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" }) + "\n"), ...c.end()]);
  assert.equal(out[out.length - 1].candidates[0].finishReason, "OTHER");
  assert.match(c.error ?? "", /Not logged in/);
});

test("gemini cli stream: assistant message deltas and result stats", () => {
  const c = new CliJsonToGemini("gemini");
  const out = parse([
    ...c.push(JSON.stringify({ type: "init", model: "gemini-3-flash" }) + "\n"),
    ...c.push(JSON.stringify({ type: "message", role: "user", content: "halo" }) + "\n"),
    ...c.push(JSON.stringify({ type: "message", role: "assistant", content: "Ha", delta: true }) + "\n"),
    ...c.push("bukan json\n"),
    ...c.push(JSON.stringify({ type: "message", role: "assistant", content: "lo", delta: true }) + "\n"),
    ...c.push(JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } }) + "\n"),
    ...c.end(),
  ]);
  assert.deepEqual(out.slice(0, 2).map((x) => x.candidates[0].content.parts[0].text), ["Ha", "lo"]);
  assert.equal(out[2].candidates[0].finishReason, "STOP");
  assert.equal(out[2].usageMetadata.promptTokenCount, 9);
});

test("model catalog: unset keeps the three Gemini API models; a list picks and orders, unknown ids are ignored", () => {
  assert.deepEqual(pickModelCatalog(undefined).map((m) => m.id), ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3-flash-preview"]);
  assert.deepEqual(pickModelCatalog(" claude-cli-sonnet, tidak-ada ,router-gemini-3-flash").map((m) => m.id), ["claude-cli-sonnet", "router-gemini-3-flash"]);
  assert.deepEqual(pickModelCatalog("tidak-ada").map((m) => m.id), pickModelCatalog(undefined).map((m) => m.id));
  const router = MOMO_ALL_MODELS.find((m) => m.id === "router-gemini-3-flash")!;
  assert.equal(router.provider, "router");
  assert.equal(router.upstreamId, "ag/gemini-3-flash");
  assert.ok(MOMO_ALL_MODELS.every((m) => !m.id.includes("/")), "ids must survive the route's provider-prefix stripping");
});
