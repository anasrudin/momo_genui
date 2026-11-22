import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MOMO_ALL_MODELS } from "../modelCatalog";
import { streamFromLocalProvider } from "./localProviders";
import { resetMcpCache } from "./mcpTools";

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
let dumpFile: string;
let fakeMcp: string;
/** How the fake CLI was last called: its arguments, its stdin text, and the MCP config file it was pointed at. */
const dump = () => JSON.parse(fs.readFileSync(dumpFile, "utf8")) as { args: string[]; prompt: string; mcp: { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> } | null };
const after1 = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

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
  const prompt = JSON.parse(input).message.content[0].text;
  const said = prompt.split("\\n")[0];
  if (process.env.MOMO_FAKE_DUMP) {
    const mcp = args.includes("--mcp-config") ? JSON.parse(fs.readFileSync(arg("--mcp-config"), "utf8")) : null;
    fs.writeFileSync(process.env.MOMO_FAKE_DUMP, JSON.stringify({ args, prompt, mcp }));
  }
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
  dumpFile = path.join(binDir, "dump.json");
  process.env.MOMO_FAKE_DUMP = dumpFile;

  // a stand-in for the MCP server: two read-only tools, one that writes, one with no annotations
  fakeMcp = path.join(binDir, "fake-mcp.js");
  fs.writeFileSync(
    fakeMcp,
    `const ro = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
const TOOLS = [ro("whats_up"), ro("ritel_market_today"), { name: "restart_service", annotations: { readOnlyHint: false } }, { name: "no_hint" }];
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  if (m.method === "initialize") return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" } });
  if (m.method === "tools/list") return reply({ tools: TOOLS });
});
`,
  );
  delete process.env.MOMO_MCP_COMMAND;
  delete process.env.MOMO_MCP_TOOLS;
  delete process.env.UBUNTU_MCP_PRIVATE;
});

/** Runs `fn` with the fake MCP server configured, and puts the environment back afterwards. */
async function withMcp(env: Record<string, string>, fn: () => Promise<void>) {
  const keys = ["MOMO_MCP_COMMAND", "MOMO_MCP_TOOLS", "UBUNTU_MCP_PRIVATE"];
  const keep = keys.map((k) => process.env[k]);
  Object.assign(process.env, { MOMO_MCP_COMMAND: `${process.execPath} ${fakeMcp}`, ...env });
  resetMcpCache();
  try {
    await fn();
  } finally {
    keys.forEach((k, i) => (keep[i] === undefined ? delete process.env[k] : (process.env[k] = keep[i])));
    resetMcpCache();
  }
}

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

test("claude cli: with no MCP server configured the arguments are exactly the plain text-generator ones", async () => {
  const res = await streamFromLocalProvider(model("claude-cli-haiku"), REQ, new AbortController().signal);
  await res.text();
  const { args, prompt, mcp } = dump();
  assert.deepEqual(args, [
    "-p", "--model", "haiku",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--system-prompt-file", after1(args, "--system-prompt-file"),
    "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--no-session-persistence", "--disable-slash-commands",
  ]);
  assert.equal(mcp, null);
  assert.match(prompt, /tidak ada tool yang bisa dipanggil/);
});

test("claude cli: with an MCP server it gets one `momo` server, read-only, and only the tools Momo offers", async () => {
  await withMcp({}, async () => {
    const res = await streamFromLocalProvider(model("claude-cli-haiku"), REQ, new AbortController().signal);
    assert.equal(res.status, 200);
    assert.match(texts(await res.text()), /\|tools=""\|files=mcp\.json,system\.txt\] halo$/);
    const { args, prompt, mcp } = dump();
    assert.deepEqual(mcp, {
      mcpServers: { momo: { type: "stdio", command: process.execPath, args: [fakeMcp], env: { UBUNTU_MCP_READONLY: "1" } } },
    });
    assert.equal(path.basename(after1(args, "--mcp-config")), "mcp.json");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(after1(args, "--tools"), "", "built-in tools stay off");
    assert.equal(after1(args, "--allowedTools"), "mcp__momo__whats_up,mcp__momo__ritel_market_today");
    assert.equal(after1(args, "--disallowedTools"), "mcp__momo__restart_service,mcp__momo__no_hint");
    assert.equal(after1(args, "--permission-prompts"), "none");
    assert.equal(after1(args, "--setting-sources"), "");
    assert.ok(args.includes("--no-session-persistence") && args.includes("--disable-slash-commands"));
    assert.ok(!args.some((a) => /skip-permissions|bypassPermissions/.test(a)));
    assert.match(prompt, /`mcp__momo__whats_up`, `mcp__momo__ritel_market_today`/);
    assert.ok(!prompt.includes("tidak ada tool yang bisa dipanggil"));
  });
});

test("claude cli: MOMO_MCP_TOOLS narrows what is allowed, and the private flag is passed on only when Momo has it", async () => {
  await withMcp({ MOMO_MCP_TOOLS: "whats_up, restart_service", UBUNTU_MCP_PRIVATE: "1" }, async () => {
    const res = await streamFromLocalProvider(model("claude-cli-haiku"), REQ, new AbortController().signal);
    await res.text();
    const { args, mcp } = dump();
    assert.equal(after1(args, "--allowedTools"), "mcp__momo__whats_up", "a tool that is not read-only is never allowed, even when listed");
    assert.equal(after1(args, "--disallowedTools"), "mcp__momo__ritel_market_today,mcp__momo__restart_service,mcp__momo__no_hint");
    assert.deepEqual(mcp?.mcpServers.momo.env, { UBUNTU_MCP_READONLY: "1", UBUNTU_MCP_PRIVATE: "1" });
  });
});

test("claude cli: an MCP server that offers nothing leaves the run a plain text generator", async () => {
  await withMcp({ MOMO_MCP_TOOLS: "tidak_ada" }, async () => {
    const res = await streamFromLocalProvider(model("claude-cli-haiku"), REQ, new AbortController().signal);
    await res.text();
    const { args, mcp } = dump();
    assert.equal(mcp, null);
    assert.ok(!args.includes("--allowedTools") && !args.includes("--mcp-config"));
  });
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
