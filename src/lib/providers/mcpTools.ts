/**
 * Lets Momo call the tools of one MCP server on the machine it runs on
 * (MOMO_MCP_COMMAND, a stdio server such as `/usr/local/bin/ubuntu-mcp`), so a
 * chat can read the owner's own apps instead of the web.
 *
 * Only tools the server itself marks read-only are ever offered or run; a
 * server that hides sensitive tools behind its own environment flags keeps
 * that say, because it inherits this process's environment and nothing more.
 */
import { spawn } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

const SCHEMA_KEYS = new Set(["type", "description", "properties", "required", "items", "enum"]);

/** JSON Schema → the subset Gemini accepts (upper-case types; validation keywords dropped). */
function toGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "type") out.type = typeof v === "string" ? v.toUpperCase() : v;
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, s]) => [name, toGeminiSchema(s)]));
    } else if (k === "items") out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

export function toGeminiDeclaration(tool: McpTool): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    // the route's prompt leans hard on web search; say plainly that this is not the web
    description: `[Data lokal milik pengguna di server ini, bukan web] ${tool.description ?? tool.name}`,
    parameters: toGeminiSchema(tool.inputSchema ?? { type: "object", properties: {} }),
  };
}

const TIMEOUT_MS = 45_000;
const CACHE_MS = 60_000;
let cache: { at: number; command: string; allow: string; tools: McpTool[]; unoffered: string[] } | null = null;

export function resetMcpCache(): void {
  cache = null;
}

const commandLine = () => (process.env.MOMO_MCP_COMMAND || "").trim();

/** The configured server as binary + arguments, for a client that starts it itself (the Claude CLI). Null when unset. */
export function mcpServerCommand(): { command: string; args: string[] } | null {
  const [command, ...args] = commandLine().split(/\s+/);
  return command ? { command, args } : null;
}

/** One request to the server: start it, initialize, ask, read the answer, let it exit. */
function mcpRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const [bin, ...args] = commandLine().split(/\s+/);
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error("MOMO_MCP_COMMAND is not set"));
    const child = spawn(/* turbopackIgnore: true */ bin, args, { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      child.kill("SIGTERM");
      fn();
    };
    const stop = () => finish(() => reject(new Error("MCP request stopped")));
    const timer = setTimeout(() => finish(() => reject(new Error("MCP server did not answer in time"))), TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });

    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", () => finish(() => reject(new Error("MCP server exited without answering"))));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const l of lines) {
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          msg = JSON.parse(l);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        if (msg.error) finish(() => reject(new Error(msg.error?.message || "MCP error")));
        else finish(() => resolve(msg.result ?? {}));
      }
    });
    child.stdin.on("error", () => undefined);
    const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "momo", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}

/** The read-only tools of the configured server, optionally narrowed by MOMO_MCP_TOOLS. Empty when there is no server. */
export async function listMcpTools(): Promise<McpTool[]> {
  const command = commandLine();
  if (!command) return [];
  const allow = (process.env.MOMO_MCP_TOOLS || "").trim();
  if (cache && cache.command === command && cache.allow === allow && Date.now() - cache.at < CACHE_MS) return cache.tools;
  let tools: McpTool[] = [];
  let unoffered: string[] = [];
  try {
    const result = await mcpRequest("tools/list", {});
    const all = Array.isArray(result.tools) ? (result.tools as McpTool[]) : [];
    const wanted = allow ? new Set(allow.split(/[\s,;]+/).filter(Boolean)) : null;
    tools = all.filter((t) => t && typeof t.name === "string" && t.annotations?.readOnlyHint === true && (!wanted || wanted.has(t.name)));
    const offered = new Set(tools.map((t) => t.name));
    unoffered = all.filter((t) => t && typeof t.name === "string" && !offered.has(t.name)).map((t) => t.name);
  } catch {
    // no server, no tools: the chat goes on without them
  }
  cache = { at: Date.now(), command, allow, tools, unoffered };
  return tools;
}

/**
 * Names the server has but `listMcpTools()` does not offer (not read-only, or outside MOMO_MCP_TOOLS).
 * A client that talks to the server directly needs them to switch those tools off by name.
 */
export async function listUnofferedMcpToolNames(): Promise<string[]> {
  await listMcpTools();
  return commandLine() && cache ? cache.unoffered : [];
}

const MAX_TEXT = 14_000;

export async function callMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  if (!(await listMcpTools()).some((t) => t.name === name)) return { text: `Tool ${name} is not available`, isError: true };
  try {
    const result = await mcpRequest("tools/call", { name, arguments: args }, signal);
    const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
    const text = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
    return {
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [dipotong ${text.length - MAX_TEXT} karakter]` : text,
      isError: result.isError === true,
    };
  } catch (e) {
    return { text: `MCP: ${(e as Error).message}`, isError: true };
  }
}

/**
 * Appended to the system prompt when app tools exist. Without it the model
 * answers questions about the owner's own server and apps from imagination,
 * complete with made-up figures.
 */
export function appToolsDirective(tools: McpTool[]): string {
  if (!tools.length) return "";
  const list = tools.map((t) => `- \`${t.name}\`: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
  return [
    "",
    "## Data lokal milik pengguna (tool, bukan web)",
    "Server ini menjalankan aplikasi milik pengguna sendiri. Tool berikut membaca data ASLI-nya:",
    list,
    "Aturan:",
    "- Kalau pengguna bertanya tentang server, aplikasi, pasar/portofolio, keuangan, jadwal, tagihan, atau \"apa yang perlu aku urus\", PANGGIL tool lokal yang cocok lebih dulu, sebelum menjawab dan sebelum `web_search`.",
    "- Jawab dari hasil tool. Sebutkan tanggal data (`as_of`) kalau bukan hari ini.",
    "- JANGAN mengarang data pribadi pengguna: saldo, transaksi, tagihan, jadwal, portofolio, status server. Tidak ada angka contoh, tidak ada komponen UI berisi angka rekaan.",
    "- Kalau tidak ada tool yang mencakup data yang diminta, atau tool gagal, katakan terus terang bahwa data itu tidak bisa dibaca dari sini dan arahkan ke aplikasinya. Berhenti di situ.",
  ].join("\n");
}
