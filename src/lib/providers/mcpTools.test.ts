import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { callMcpTool, listMcpTools, resetMcpCache, toGeminiDeclaration } from "./mcpTools";

let dir: string;
let fake: string;
let callLog: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-mcp-"));
  fake = path.join(dir, "fake-mcp.js");
  callLog = path.join(dir, "calls.log");
  // a minimal MCP stdio server: newline-delimited JSON-RPC, like ubuntu-mcp
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const TOOLS = [
  { name: "whats_up", description: "What needs attention", inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 0, default: 7 } } }, annotations: { readOnlyHint: true } },
  { name: "famhub_summary", description: "Family overview", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "restart_service", description: "Restart a unit", inputSchema: { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "no_hint", description: "No annotations at all", inputSchema: { type: "object", properties: {} } },
];
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  if (m.method === "initialize") return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" } });
  if (m.method === "tools/list") return reply({ tools: TOOLS });
  if (m.method === "tools/call") {
    fs.appendFileSync(${JSON.stringify(callLog)}, m.params.name + "\\n");
    if (m.params.name === "famhub_summary") return reply({ content: [{ type: "text", text: "FamHub unreachable" }], isError: true });
    return reply({ content: [{ type: "text", text: JSON.stringify({ tool: m.params.name, args: m.params.arguments, env: process.env.FAKE_FLAG || null }) }], isError: false });
  }
});
`,
    { mode: 0o755 },
  );
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  process.env.MOMO_MCP_COMMAND = `${process.execPath} ${fake}`;
  delete process.env.MOMO_MCP_TOOLS;
  delete process.env.FAKE_FLAG;
  resetMcpCache();
  fs.rmSync(callLog, { force: true });
});

test("declaration: JSON Schema becomes Gemini's upper-case schema and keeps name and description", () => {
  const d = toGeminiDeclaration({
    name: "whats_up",
    description: "What needs attention",
    inputSchema: { type: "object", required: ["a"], properties: { a: { type: "string", enum: ["x", "y"] }, n: { type: "integer", minimum: 0, default: 7 }, l: { type: "array", items: { type: "number" } } } },
  });
  assert.equal(d.name, "whats_up");
  assert.match(d.description, /What needs attention/);
  assert.deepEqual(d.parameters, {
    type: "OBJECT",
    required: ["a"],
    properties: { a: { type: "STRING", enum: ["x", "y"] }, n: { type: "INTEGER" }, l: { type: "ARRAY", items: { type: "NUMBER" } } },
  });
});

test("list: only tools the server marks read-only are offered", async () => {
  const names = (await listMcpTools()).map((t) => t.name);
  assert.deepEqual(names, ["whats_up", "famhub_summary"]);
});

test("list: MOMO_MCP_TOOLS narrows the set, and cannot add a tool that is not read-only", async () => {
  process.env.MOMO_MCP_TOOLS = "whats_up, restart_service";
  assert.deepEqual((await listMcpTools()).map((t) => t.name), ["whats_up"]);
});

test("list: no command configured, or a command that does not start, means no tools (and no error)", async () => {
  delete process.env.MOMO_MCP_COMMAND;
  assert.deepEqual(await listMcpTools(), []);
  process.env.MOMO_MCP_COMMAND = path.join(dir, "tidak-ada");
  resetMcpCache();
  assert.deepEqual(await listMcpTools(), []);
});

test("call: arguments reach the server, the text comes back, and the server inherits the environment", async () => {
  process.env.FAKE_FLAG = "1";
  const r = await callMcpTool("whats_up", { days: 3 });
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.text), { tool: "whats_up", args: { days: 3 }, env: "1" });
});

test("call: a tool error is passed on as an error", async () => {
  const r = await callMcpTool("famhub_summary", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /unreachable/);
});

test("call: a tool that was not offered is refused without reaching the server", async () => {
  const r = await callMcpTool("restart_service", { unit: "caddy" });
  assert.equal(r.isError, true);
  assert.ok(!fs.existsSync(callLog), "the server must not have been asked to run it");
});

test("directive: names every offered tool and forbids inventing the owner's data; no tools, no directive", async () => {
  const { appToolsDirective } = await import("./mcpTools");
  assert.equal(appToolsDirective([]), "");
  const d = appToolsDirective([{ name: "whats_up", description: "What needs attention" }, { name: "ritel_market_today", description: "IDX summary" }]);
  assert.match(d, /`whats_up`: What needs attention/);
  assert.match(d, /`ritel_market_today`: IDX summary/);
  assert.match(d, /JANGAN mengarang/);
});
