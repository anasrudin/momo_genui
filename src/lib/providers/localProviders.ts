/**
 * Server side of the local backends: fetches from the router or runs a CLI,
 * and hands the route a `Response` whose body is Gemini SSE (see geminiBridge).
 * A backend that fails before it produced anything answers with a non-2xx
 * status, so the route's "try the next model" logic works unchanged.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerOf, type MomoModelOption } from "@/lib/modelCatalog";
import {
  ChatSseToGemini,
  CliJsonToGemini,
  forcedToolCallChunk,
  toChatCompletionsRequest,
  toCliPrompt,
  type CliFlavor,
  type GeminiRequest,
} from "./geminiBridge";

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8" };
const encoder = new TextEncoder();
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

function routerConfig() {
  return {
    base: (process.env.MOMO_ROUTER_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, ""),
    key: process.env.MOMO_ROUTER_KEY || "",
  };
}

function routerHeaders(): Record<string, string> {
  const { key } = routerConfig();
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

async function streamFromRouter(req: GeminiRequest, upstreamModel: string, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${routerConfig().base}/chat/completions`, {
      method: "POST",
      headers: routerHeaders(),
      signal,
      body: JSON.stringify(toChatCompletionsRequest(req, upstreamModel)),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    return fail(503, `router unreachable: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) return fail(res.status || 502, (await res.text().catch(() => "")).slice(0, 400));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const bridge = new ChatSseToGemini();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // keep reading until there is something to hand over: a pull that
        // enqueues nothing is not called again, and the stream would stall
        for (;;) {
          const { done, value } = await reader.read();
          const lines = done ? bridge.end() : bridge.push(decoder.decode(value, { stream: true }));
          for (const l of lines) controller.enqueue(encoder.encode(l));
          if (done) return controller.close();
          if (lines.length) return;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel: () => reader.cancel().catch(() => undefined),
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/* ───────────── CLI backends ───────────── */

const CLI_TIMEOUT_MS = 180_000;
const MAX_CLI_RUNS = 3;
let cliRuns = 0;

function cliEnv(): NodeJS.ProcessEnv {
  const extra = [path.join(os.homedir(), ".local/bin"), "/usr/local/bin"];
  return { ...process.env, PATH: [...extra, process.env.PATH || "/usr/bin:/bin"].join(":") };
}

function cliCommand(flavor: CliFlavor, model: string, workDir: string, req: GeminiRequest): { bin: string; args: string[]; stdin: string } {
  const { system, prompt, images } = toCliPrompt(req);
  if (flavor === "claude") {
    const systemFile = path.join(workDir, "system.txt");
    fs.writeFileSync(systemFile, system || "You are Momo.");
    return {
      bin: process.env.MOMO_CLAUDE_CLI || "claude",
      // A text generator and nothing else: no built-in tools, no MCP servers, no
      // user settings, hooks or skills, and no session written to disk.
      args: [
        "-p", "--model", model || "sonnet",
        "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--system-prompt-file", systemFile,
        "--tools", "", "--strict-mcp-config", "--setting-sources", "",
        "--no-session-persistence", "--disable-slash-commands",
      ],
      stdin: `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })),
          ],
        },
      })}\n`,
    };
  }
  return {
    bin: process.env.MOMO_GEMINI_CLI || "gemini",
    args: ["--output-format", "stream-json", ...(model ? ["--model", model] : []), "--prompt", ""],
    stdin: `${system}\n\n---\n\n${prompt}`,
  };
}

function streamFromCli(flavor: CliFlavor, req: GeminiRequest, upstreamModel: string, signal: AbortSignal): Promise<Response> {
  const forced = forcedToolCallChunk(req);
  if (forced) return Promise.resolve(new Response(forced, { status: 200, headers: SSE_HEADERS }));
  if (cliRuns >= MAX_CLI_RUNS) return Promise.resolve(fail(429, "too many CLI runs at once"));

  // An empty directory of its own: the CLI has no project to read, and nothing of ours to touch.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cli-"));
  const { bin, args, stdin } = cliCommand(flavor, upstreamModel, workDir, req);
  const bridge = new CliJsonToGemini(flavor);
  const decoder = new TextDecoder();
  cliRuns++;

  return new Promise<Response>((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let answered = false;
    let closed = false;
    let stderr = "";
    const early: string[] = [];

    // the binary and its directory are decided at run time; nothing here is a project file to bundle
    const child = spawn(/* turbopackIgnore: true */ bin, args, {
      cwd: /* turbopackIgnore: true */ workDir,
      env: cliEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => { if (!closed) child.kill("SIGTERM"); };
    const timer = setTimeout(stop, CLI_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      cliRuns--;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      fs.rm(workDir, { recursive: true, force: true }, () => undefined);
    };

    const emit = (lines: string[]) => {
      if (!lines.length) return;
      if (!answered) {
        // first output: from here on it is a normal stream
        answered = true;
        early.push(...lines);
        resolve(new Response(new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            for (const l of early) c.enqueue(encoder.encode(l));
            if (closed) c.close();
          },
          cancel: stop,
        }), { status: 200, headers: SSE_HEADERS }));
        return;
      }
      if (controller) for (const l of lines) controller.enqueue(encoder.encode(l));
      else early.push(...lines);
    };

    child.stdout.on("data", (d: Buffer) => { if (!bridge.error) emit(bridge.push(decoder.decode(d, { stream: true }))); });
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-600); });
    child.on("error", (e) => {
      cleanup();
      if (!answered) { answered = true; resolve(fail(503, `${bin}: ${e.message}`)); }
    });
    child.on("close", (code) => {
      const tail = bridge.end();
      cleanup();
      if (!answered) {
        // nothing useful came out: report it as a failed backend instead of an empty answer
        answered = true;
        const said = tail.length > 0 && !bridge.error && code === 0;
        resolve(said ? new Response(tail.join(""), { status: 200, headers: SSE_HEADERS }) : fail(502, bridge.error || stderr.trim() || `${bin} exited with code ${code}`));
        return;
      }
      if (controller) {
        for (const l of tail) controller.enqueue(encoder.encode(l));
        controller.close();
      } else early.push(...tail);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/** Runs one Gemini-shaped request on a non-Gemini-API model. */
export function streamFromLocalProvider(model: MomoModelOption, req: GeminiRequest, signal: AbortSignal): Promise<Response> {
  const upstream = model.upstreamId ?? model.id;
  switch (providerOf(model)) {
    case "router":
      return streamFromRouter(req, upstream, signal);
    case "claude-cli":
      return streamFromCli("claude", req, upstream, signal);
    case "gemini-cli":
      return streamFromCli("gemini", req, upstream, signal);
    default:
      return Promise.resolve(fail(400, `${model.id} is not a local model`));
  }
}

/** A short session title from the router, for setups without a Gemini API key. */
export async function titleFromRouter(query: string, upstreamModel: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${routerConfig().base}/chat/completions`, {
      method: "POST",
      headers: routerHeaders(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      body: JSON.stringify({
        model: upstreamModel,
        stream: true, // the router's non-stream replies can carry an SSE trailer; streaming is the well-formed path
        temperature: 0.2,
        max_tokens: 64,
        messages: [{
          role: "user",
          content: `Buat judul singkat (2-5 kata, tanpa tanda kutip, tanpa titik di akhir) untuk percakapan yang dibuka dengan pesan di bawah. Pakai bahasa yang sama dengan pesannya. Balas judulnya saja.\n\nPesan: ${query.slice(0, 600)}`,
        }],
      }),
    });
    if (!res.ok) return null;
    let raw = "";
    for (const l of (await res.text()).split("\n")) {
      if (!l.startsWith("data:") || l.includes("[DONE]")) continue;
      try { raw += JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? ""; } catch { /* skip a malformed line */ }
    }
    return raw.trim().split("\n")[0].replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, "").slice(0, 60) || null;
  } catch {
    return null;
  }
}
