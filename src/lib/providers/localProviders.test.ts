import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MOMO_ALL_MODELS } from "../modelCatalog";
import { streamFromLocalProvider } from "./localProviders";

const model = (id: string) => MOMO_ALL_MODELS.find((m) => m.id === id)!;
const REQ = { contents: [{ role: "user" as const, parts: [{ text: "halo" }] }] };
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const texts = (body: string) =>
  body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .flatMap((l) => JSON.parse(l.slice(5)).candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "")
    .join("");

let server: http.Server;
let seen: { url?: string; body?: { model?: string } } = {};
let binDir: string;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen = { url: req.url, body: JSON.parse(raw) };
      if (seen.body?.model === "cc/claude-sonnet-4-6") {
        res.writeHead(401).end('{"error":{"message":"OAuth access token has expired"}}');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // the first packets carry nothing the bridge can emit; the stream must not stall on them
      res.write(": keep-alive\n\n");
      setTimeout(() => res.write(sse({ choices: [{ delta: { role: "assistant" } }] })), 20);
      setTimeout(() => res.write(sse({ choices: [{ delta: { content: "Halo " } }] })), 40);
      setTimeout(() => res.end(sse({ choices: [{ delta: { content: "juga" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n"), 60);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.MOMO_ROUTER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  // a stand-in for the Claude CLI: prints what the real one prints, and echoes how it was called
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-fakecli-"));
  const fake = path.join(binDir, "claude-ok");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const args = process.argv.slice(2);
  const arg = (name) => args[args.indexOf(name) + 1];
  const sys = fs.readFileSync(arg("--system-prompt-file"), "utf8");
  const said = JSON.parse(input).message.content[0].text.split("\\n")[0];
  const out = (o) => console.log(JSON.stringify(o));
  const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  out({ type: "system", subtype: "init" });
  delta("[" + sys + "|" + arg("--model") + "|tools=" + JSON.stringify(arg("--tools")) + "|files=" + fs.readdirSync(".").join(",") + "] ");
  delta(said);
  out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 2 } });
});
`,
    { mode: 0o755 },
  );
  process.env.MOMO_CLAUDE_CLI = fake;
});

after(() => {
  server.close();
  fs.rmSync(binDir, { recursive: true, force: true });
});

test("router: the request goes to /chat/completions with the upstream model id, and the answer streams through", async () => {
  const res = await streamFromLocalProvider(model("router-gemini-3-flash"), REQ, new AbortController().signal);
  assert.equal(res.status, 200);
  assert.equal(texts(await res.text()), "Halo juga");
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.body?.model, "ag/gemini-3-flash");
});

test("router: an upstream failure keeps its status so the route can move to the next model", async () => {
  const res = await streamFromLocalProvider(model("router-claude-sonnet"), REQ, new AbortController().signal);
  assert.equal(res.status, 401);
});

test("claude cli: runs with tools off, in a directory holding only its prompt, with system prompt and model passed on", async () => {
  const res = await streamFromLocalProvider(
    model("claude-cli-haiku"),
    { ...REQ, systemInstruction: { parts: [{ text: "SYS" }] } },
    new AbortController().signal,
  );
  assert.equal(res.status, 200);
  assert.equal(texts(await res.text()), '[SYS|haiku|tools=""|files=system.txt] halo');
});

test("cli: a binary that is not there is a failed backend, not an empty answer", async () => {
  const keep = process.env.MOMO_CLAUDE_CLI;
  process.env.MOMO_CLAUDE_CLI = path.join(binDir, "tidak-ada");
  try {
    const res = await streamFromLocalProvider(model("claude-cli-haiku"), REQ, new AbortController().signal);
    assert.equal(res.status, 503);
  } finally {
    process.env.MOMO_CLAUDE_CLI = keep;
  }
});

test("cli: a run that exits with an error and no text is a failed backend", async () => {
  const keep = process.env.MOMO_GEMINI_CLI;
  const bad = path.join(binDir, "gemini-bad");
  fs.writeFileSync(
    bad,
    '#!/usr/bin/env node\nconsole.error("When using Gemini API, you must specify the GEMINI_API_KEY environment variable.");process.exit(41);\n',
    { mode: 0o755 },
  );
  process.env.MOMO_GEMINI_CLI = bad;
  try {
    const res = await streamFromLocalProvider(model("gemini-cli"), REQ, new AbortController().signal);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /GEMINI_API_KEY/);
  } finally {
    process.env.MOMO_GEMINI_CLI = keep;
  }
});
