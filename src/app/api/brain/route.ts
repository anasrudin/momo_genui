import fs from "node:fs";
import path from "node:path";
import {
  buildStaticMomoSystemPrompt,
  buildDynamicTurnGuidance,
  buildSessionMemoryLedger,
  extractRecentOpenUiComponents,
  GEMINI_FUNCTION_DECLARATIONS,
  NEWS_INTENT_PATTERN,
  shouldEnforceFreshWebVerification,
  shouldFetchVisualImages,
  shouldMandateAutoWebSearch,
} from "@/lib/genUiDesignSpec";
import { truncateHistorySafely } from "@/lib/genUiStreamParser";
import {
  getOpenUiUnresolvedRefs,
  hasUnclosedOpenUiStream,
  parseMixedStreamToMistlineBlocks,
} from "@/lib/openui/streamParser";
import {
  createEmptyDataProfile,
  enrichDataProfileFromTextAndTools,
  formatUiPlanPromptBlock,
  planContextAwareUi,
  toUiPlanSummaryMeta,
} from "@/lib/openui/uiPlanner";
import {
  decideRoleTurn,
  findAlternativeLook,
  inferLookByKeyword,
  inferMoodByInput,
} from "@/lib/localBrain";
import { hydrateBoardItemsMedia } from "@/lib/mediaResolver";
import {
  MOMO_MODEL_CATALOG,
  normalizeReasoningEffort,
  providerOf,
  resolveModelMeta,
  type MomoModelOption,
  type ReasoningEffort,
} from "@/lib/modelCatalog";
import { streamFromLocalProvider, titleFromRouter } from "@/lib/providers/localProviders";
import { getRoleWorkspaceConfig } from "@/lib/roleWorkspaceRegistry";
import { isUsableArticleImageUrl } from "@/lib/imageAssetContract";
import {
  extractImageAssetStem,
  normalizeImageDedupKey,
  runImageSearch,
  runWebSearch,
  type WebSearchResultItem,
} from "@/lib/webSearch";
import type {
  BrainSseEvent,
  SourceItem,
  UiInteractionPayload,
  WorkspaceBoardColumn,
  WorkspaceBoardItem,
  WorkspaceSnapshotPayload,
  WorkspaceViewId,
} from "@/types/momo";

// TODO(security): Implement distributed rate limiting, authentication, and CSRF
// protections before exposing this workspace API beyond local single-user use.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface IncomingTurnMessage {
  role: "user" | "assistant";
  text: string;
}

interface IncomingAttachment {
  name: string;
  kind: string;
  mimeType?: string;
  imageDataUrl?: string;
  extractedText?: string;
}

interface IncomingBrainRequest {
  message?: string;
  messages?: IncomingTurnMessage[];
  attachments?: IncomingAttachment[];
  activeLook?: string;
  sessionLook?: string;
  pinnedBot?: { name?: string; job?: string; look?: string } | null;
  roleGateConfirmed?: boolean;
  uiInteraction?: UiInteractionPayload | null;
  workspaceView?: WorkspaceViewId;
  workspaceSnapshot?: WorkspaceSnapshotPayload | null;
  isRetry?: boolean;
  retryPreviousText?: string;
  needsTitle?: boolean;
  modelId?: string;
  reasoningEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
}

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiSseChunk {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
}

const DEFAULT_MODEL_CANDIDATES = [
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite-preview",
];

const MODEL_COOLDOWN_MS = 90_000;
const KEY_RATE_LIMIT_COOLDOWN_MS = 65_000;
const KEY_AUTH_COOLDOWN_MS = 10 * 60_000;
const GOOGLE_SEARCH_GROUNDING_COOLDOWN_MS = 30 * 60_000;
const modelCooldownUntil = new Map<string, number>();
const geminiKeyCooldownUntil = new Map<string, number>();
let geminiKeyRoundRobinIdx = 0;
let googleSearchGroundingCooldownUntil = 0;

function resolveGeminiApiKeys(projectEnv: Record<string, string>): string[] {
  const rawPool = [
    projectEnv.GEMINI_API_KEYS,
    process.env.GEMINI_API_KEYS,
    projectEnv.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(",");

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of rawPool.split(/[\s,;]+/)) {
    const clean = part.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function getRotatedGeminiKeys(keys: string[]): string[] {
  if (keys.length <= 1) return keys;
  const start = geminiKeyRoundRobinIdx % keys.length;
  geminiKeyRoundRobinIdx = (geminiKeyRoundRobinIdx + 1) % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const now = Date.now();
  const ready = rotated.filter((k) => {
    const until = geminiKeyCooldownUntil.get(k);
    if (!until) return true;
    if (now >= until) {
      geminiKeyCooldownUntil.delete(k);
      return true;
    }
    return false;
  });
  return ready.length > 0 ? ready : rotated;
}

function markGeminiKeyCooldown(key: string, status: number): void {
  const duration =
    status === 401 || status === 403
      ? KEY_AUTH_COOLDOWN_MS
      : KEY_RATE_LIMIT_COOLDOWN_MS;
  geminiKeyCooldownUntil.set(key, Date.now() + duration);
}

function isModelInCooldown(modelId: string): boolean {
  const until = modelCooldownUntil.get(modelId);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldownUntil.delete(modelId);
    return false;
  }
  return true;
}

function markModelCooldown(modelId: string): void {
  modelCooldownUntil.set(modelId, Date.now() + MODEL_COOLDOWN_MS);
}

/**
 * Reads `.env.local` in workspace root so an old stale shell `GEMINI_API_KEY`
 * cannot override the active project key configured in `.env.local`.
 */
function readProjectEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && val) out[key] = val;
    }
  } catch {
    // `.env.local` optional
  }
  return out;
}

/**
 * Collapses whitespace and truncates long status/query labels cleanly at word boundaries.
 */
const KNOWN_TOOL_NAMES = new Set(["web_search", "search_images", "sync_workspace_board"]);

/** Models occasionally garble a tool name ("search_search", "image_search"); route it instead of wasting a step. */
function normalizeToolName(raw: string): string {
  const name = (raw || "").trim();
  if (KNOWN_TOOL_NAMES.has(name)) return name;
  const lower = name.toLowerCase();
  if (/image|photo|foto|gambar|picture/.test(lower)) return "search_images";
  if (/board|workspace|pinboard/.test(lower)) return "sync_workspace_board";
  if (/search|web|google|browse|lookup/.test(lower)) return "web_search";
  return name;
}

/** Short topic title for a session, from its opening message. Null when no key answers in time. */
async function generateSessionTitle(
  query: string,
  keys: string[],
  signal: AbortSignal,
): Promise<string | null> {
  for (const key of keys.slice(0, 2)) {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Buat judul singkat (2-5 kata, tanpa tanda kutip, tanpa titik di akhir) untuk percakapan yang dibuka dengan pesan di bawah. Pakai bahasa yang sama dengan pesannya. Balas judulnya saja.\n\nPesan: ${query.slice(0, 600)}`,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 32,
              thinkingConfig: { includeThoughts: false, thinkingLevel: "MINIMAL" },
            },
          }),
        },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      const title = raw
        .trim()
        .split("\n")[0]
        .replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, "")
        .slice(0, 60);
      if (title) return title;
    } catch {
      // try the next key
    }
  }
  return null;
}

function formatActivityQuery(raw: string, maxLen = 110): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const bounded = lastSpace > Math.floor(maxLen * 0.55) ? cut.slice(0, lastSpace) : cut;
  return `${bounded.trim()}…`;
}

function encodeSseEvent(event: BrainSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function extractHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

function extractGroundingDomain(rawUrl: string, rawTitle?: string): string {
  const host = extractHostname(rawUrl);
  if (
    rawTitle &&
    (/vertexaisearch\.cloud\.google\.com/i.test(host) || /^google\./i.test(host))
  ) {
    const cleanTitle = rawTitle.trim().replace(/^https?:\/\/(?:www\.)?/i, "");
    const domainMatch = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(cleanTitle);
    if (domainMatch && domainMatch[1].includes(".")) {
      return domainMatch[1].toLowerCase().replace(/^www\./, "");
    }
  }
  return host;
}

function buildThinkingConfig(
  modelId: string,
  useReasoning: boolean,
  effort: ReasoningEffort
): Record<string, unknown> {
  const isGemini25 = /^gemini-2\.5/i.test(modelId);
  if (!useReasoning) {
    return isGemini25
      ? { includeThoughts: false, thinkingBudget: 0 }
      : { includeThoughts: false, thinkingLevel: "MINIMAL" };
  }
  if (isGemini25) {
    const budget = effort === "high" ? 8192 : effort === "medium" ? 4096 : 1024;
    return { includeThoughts: true, thinkingBudget: budget };
  }
  return {
    includeThoughts: true,
    thinkingLevel: effort.toUpperCase(),
  };
}

function buildBaseGeminiContents(opts: {
  rawMessages: IncomingTurnMessage[];
  latestUserText: string;
  dynamicGuidance: string;
  textAttachmentContext: string;
  imageAttachments: IncomingAttachment[];
}): GeminiContent[] {
  const list: GeminiContent[] = [];
  for (const m of opts.rawMessages.slice(-24)) {
    const raw = String(m.text || "").trim();
    if (!raw) continue;
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const safeText =
      role === "model" ? truncateHistorySafely(raw, 3600) : raw.slice(0, 4500);
    if (!safeText) continue;

    const prev = list[list.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push({ text: safeText });
    } else {
      list.push({ role, parts: [{ text: safeText }] });
    }
  }

  // Gemini native API requires contents to start with "user" and end with "user"
  while (list.length > 0 && list[0].role !== "user") {
    list.shift();
  }
  if (list.length === 0 || list[list.length - 1].role !== "user") {
    list.push({ role: "user", parts: [{ text: opts.latestUserText }] });
  }

  // Attach compact per-turn guidance + attachments ONLY on the active final user turn
  // so `systemInstruction` stays 100% static for implicit KV prefix caching.
  const lastTurn = list[list.length - 1];
  const baseText = lastTurn.parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const augmented = `<internal_turn_context do_not_echo="true">\n${opts.dynamicGuidance}\n</internal_turn_context>\n\n${baseText || opts.latestUserText}${opts.textAttachmentContext}`;
  const parts: GeminiPart[] = [{ text: augmented }];

  for (const img of opts.imageAttachments.slice(0, 4)) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(
      img.imageDataUrl || ""
    );
    if (match) {
      parts.push({
        inlineData: {
          mimeType: match[1].toLowerCase(),
          data: match[2],
        },
      });
    }
  }
  lastTurn.parts = parts;
  return list;
}

/** An enabled model that is not served by the Gemini API (router or CLI on this machine). */
function localModel(modelId: string): MomoModelOption | undefined {
  return MOMO_MODEL_CATALOG.find((m) => m.id === modelId && providerOf(m) !== "gemini");
}

function getOrderedCandidateModels(
  preferred: string,
  hasExplicitModelId = false,
  hasGeminiKey = true
): string[] {
  const cleanPreferred = preferred.replace(/^[a-z]+\//i, "").trim();
  const ordered = [
    ...(cleanPreferred ? [cleanPreferred] : []),
    MOMO_MODEL_CATALOG[0].id,
    // the other local models are fallbacks too; Gemini API ones only count with a key
    ...MOMO_MODEL_CATALOG.filter((m) => providerOf(m) !== "gemini").map((m) => m.id),
    ...DEFAULT_MODEL_CANDIDATES,
  ]
    .map((m) => m.replace(/^[a-z]+\//i, "").trim())
    .filter((m) => hasGeminiKey || Boolean(localModel(m)));

  const unique: string[] = [];
  for (const m of ordered) {
    if (m && !unique.includes(m)) unique.push(m);
  }
  const healthy = unique.filter((m) => !isModelInCooldown(m));
  const pool = healthy.length > 0 ? healthy : unique;
  if (hasExplicitModelId && cleanPreferred) {
    // Always try the user's explicitly chosen model first even if it was recently throttled
    return [...new Set([cleanPreferred, ...pool])].filter((m) => hasGeminiKey || Boolean(localModel(m)));
  }
  return pool;
}

export async function POST(request: Request) {
  let body: IncomingBrainRequest;
  try {
    body = (await request.json()) as IncomingBrainRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: "Payload request tidak valid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const rawMessages = (Array.isArray(body.messages) ? body.messages : []).filter(
    (m): m is IncomingTurnMessage => Boolean(m && typeof m.text === "string" &&
      (m.role === "user" || m.role === "assistant"))
  );
  const latestUserText =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : [...rawMessages]
          .reverse()
          .find((m) => m.role === "user" && typeof m.text === "string")
          ?.text?.trim() || "";

  if (!latestUserText) {
    return new Response(JSON.stringify({ error: "Pesan kosong." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const pinnedLook = body.pinnedBot?.look;
  const sessionLook =
    typeof body.sessionLook === "string" ? body.sessionLook.trim() : "";
  // Sessions holding a specialist look gate the same way a pinned bot does;
  // only rest sessions route freely per turn.
  const gateLook = pinnedLook || (sessionLook && sessionLook !== "rest" ? sessionLook : "");
  if (gateLook && (body.workspaceView ?? "chat") === "chat" && body.roleGateConfirmed !== true) {
    const last = rawMessages.at(-1);
    const includesCurrent = last?.role === "user" &&
      (last.text.trim() === latestUserText || last.text.startsWith(`${latestUserText}\n\n[Lampiran:`) ||
        (body.attachments?.length && last.text.startsWith("[Lampiran:")));
    const history = includesCurrent ? rawMessages.slice(0, -1) : rawMessages;
    const previous = history.filter((m) => m.role === "user").at(-1);
    const decision = decideRoleTurn(latestUserText, gateLook, previous?.text);
    if (decision.kind !== "answer") {
      return Response.json({ roleGate: decision }, { status: 409 });
    }
  }
  const resolvedLook = pinnedLook
    ? pinnedLook
    : body.roleGateConfirmed === true && sessionLook && sessionLook !== "rest"
      ? sessionLook
      : inferLookByKeyword(latestUserText, {
          fallbackLook:
            body.activeLook && body.activeLook !== "rest"
              ? body.activeLook
              : undefined,
        }) || "rest";
  const resolvedMood = inferMoodByInput(latestUserText, resolvedLook);
  const switchedFrom =
    !pinnedLook && sessionLook && sessionLook !== resolvedLook
      ? sessionLook
      : undefined;
  const suggestedLook = pinnedLook && body.workspaceView === "explore"
    ? (findAlternativeLook(latestUserText, pinnedLook) ?? undefined)
    : undefined;

  const projectEnv = readProjectEnvLocal();
  const apiKeys = resolveGeminiApiKeys(projectEnv);
  const apiKey = apiKeys[0] || "";
  const rawPreferred = (
    body.modelId ||
    projectEnv.MOMO_MODEL ||
    process.env.MOMO_MODEL ||
    MOMO_MODEL_CATALOG[0].id
  ).trim();
  const preferredModel = rawPreferred.replace(/^google\//i, "");
  const selectedModelMeta = resolveModelMeta(preferredModel);
  const resolvedEffort = normalizeReasoningEffort(
    selectedModelMeta,
    body.reasoningEffort ??
      (typeof body.reasoningEnabled === "boolean"
        ? body.reasoningEnabled
        : undefined)
  );
  const wantReasoning =
    selectedModelMeta.supportsReasoning && resolvedEffort !== "off";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: BrainSseEvent) => {
        try {
          controller.enqueue(encodeSseEvent(ev));
        } catch {
          // Stream closed by client
        }
      };

      const closeStream = () => {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      const turnImagePoolSet = new Set<string>();

      send({
        type: "turn_meta",
        look: resolvedLook,
        mood: resolvedMood,
        botLabel: body.pinnedBot?.name || undefined,
        ...(switchedFrom ? { previousLook: switchedFrom } : {}),
        ...(suggestedLook ? { suggestedLook } : {}),
        hasNativeReasoning: false,
        modelHasReasoning: wantReasoning,
        modelId: selectedModelMeta.id,
        reasoningEffort: resolvedEffort,
      });

      const firstRouterModel = MOMO_MODEL_CATALOG.find((m) => providerOf(m) === "router");
      if (!apiKey && !MOMO_MODEL_CATALOG.some((m) => providerOf(m) !== "gemini")) {
        send({
          type: "turn_error",
          message:
            "Konfigurasi layanan AI belum lengkap di server. Pastikan kunci layanan aktif telah terpasang.",
        });
        closeStream();
        return;
      }

      const titlePromise = body.needsTitle
        ? (apiKey
            ? generateSessionTitle(latestUserText, getRotatedGeminiKeys(apiKeys), request.signal)
            : firstRouterModel
              ? titleFromRouter(latestUserText, firstRouterModel.upstreamId ?? firstRouterModel.id, request.signal)
              : Promise.resolve(null)
          ).then(
            (title) => {
              if (title) send({ type: "session_title", title });
            },
          )
        : null;

      const previousAssistantTexts = rawMessages
        .filter(
          (m) =>
            m.role === "assistant" &&
            typeof m.text === "string" &&
            m.text.trim().length > 0
        )
        .slice(-8)
        .map((m) => m.text!.trim());

      const previousUserTexts = rawMessages
        .slice(0, -1)
        .filter(
          (m) =>
            m.role === "user" &&
            typeof m.text === "string" &&
            m.text.trim().length > 0
        )
        .slice(-12)
        .map((m) => m.text!.trim());

      const incomingAttachments = Array.isArray(body.attachments)
        ? body.attachments
        : [];
      const textAttachmentContext = incomingAttachments
        .filter(
          (a) =>
            typeof a.extractedText === "string" &&
            a.extractedText.trim().length > 0
        )
        .map(
          (a) =>
            `\n[Isi Lampiran "${a.name}" (${a.kind})]:\n${a.extractedText!.slice(0, 6000)}`
        )
        .join("\n");
      const imageAttachments = incomingAttachments.filter(
        (a) =>
          typeof a.imageDataUrl === "string" &&
          /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(a.imageDataUrl)
      );

      const activeWorkspaceView: WorkspaceViewId = body.workspaceView || "chat";
      const recentComponents = extractRecentOpenUiComponents([
        ...previousAssistantTexts,
        ...(body.isRetry &&
        typeof body.retryPreviousText === "string" &&
        body.retryPreviousText.trim()
          ? [body.retryPreviousText.trim()]
          : []),
      ]).last;
      let availableDataProfile = enrichDataProfileFromTextAndTools(
        createEmptyDataProfile(body.workspaceSnapshot),
        {
          userText: latestUserText,
          attachmentText: textAttachmentContext,
        },
      );

      const buildPlanningContext = () => ({
        latestUserText,
        lookId: resolvedLook,
        workspaceView: activeWorkspaceView,
        previousUserTexts,
        previousAssistantTexts,
        recentComponents,
        availableData: availableDataProfile,
        workspaceSnapshot: body.workspaceSnapshot ?? null,
        uiInteraction: body.uiInteraction ?? null,
        isRetry: Boolean(body.isRetry),
      });

      let activeUiPlan = planContextAwareUi(buildPlanningContext());
      let activeUiPlanMeta = toUiPlanSummaryMeta(activeUiPlan);

      const sessionLedger = buildSessionMemoryLedger({
        latestUserText,
        previousUserTexts,
        previousAssistantTexts,
        taskTransition: activeUiPlan.taskTransition,
      });

      const mustVerifyOnWeb = shouldEnforceFreshWebVerification({
        latestUserText,
        previousUserTexts,
        hasInteraction: Boolean(body.uiInteraction),
      });

      const mustFetchVisuals = shouldFetchVisualImages({
        latestUserText,
        hasInteraction: Boolean(body.uiInteraction),
      });

      const needsExternalSearchHint =
        mustVerifyOnWeb ||
        shouldMandateAutoWebSearch({
          latestUserText,
          previousUserTexts,
          hasInteraction: Boolean(body.uiInteraction),
          reasoningEnabled: wantReasoning,
        });

      let activeStaticSystemPrompt = buildStaticMomoSystemPrompt(
        resolvedLook,
        activeWorkspaceView,
        { allowedComponents: activeUiPlan.allowedComponents },
      );
      const dynamicGuidance = buildDynamicTurnGuidance({
        lookId: resolvedLook,
        latestUserText,
        previousUserTexts,
        taskTransition: activeUiPlan.taskTransition,
        pinnedBot: body.pinnedBot,
        uiInteraction: body.uiInteraction,
        workspaceView: activeWorkspaceView,
        previousAssistantTexts,
        isRetry: Boolean(body.isRetry),
        retryPreviousText:
          typeof body.retryPreviousText === "string"
            ? body.retryPreviousText
            : undefined,
        uiPlanBlock: formatUiPlanPromptBlock(
          activeUiPlan,
          buildPlanningContext(),
        ),
        needsExternalSearchHint,
        workspaceSnapshot: body.workspaceSnapshot ?? null,
        reasoningEnabled: wantReasoning,
      });
      const turnTemperature = body.isRetry ? 0.72 : 0.45;

      const baseContents = buildBaseGeminiContents({
        rawMessages,
        latestUserText,
        dynamicGuidance,
        textAttachmentContext,
        imageAttachments,
      });
      let currentContents: GeminiContent[] = baseContents.map((c) => ({
        role: c.role,
        parts: [...c.parts],
      }));

      const hasExplicitModel = Boolean(body.modelId && body.modelId.trim());
      const modelList = getOrderedCandidateModels(preferredModel, hasExplicitModel, Boolean(apiKey));
      const turnSuffix = crypto.randomUUID().slice(0, 8);
      const turnStartMs = Date.now();
      let partCounter = 0;
      const nextPartId = (prefix: string) =>
        `${prefix}_${turnSuffix}_${++partCounter}`;

      let estTokens = 0;
      let accPromptTokens = 0;
      let accCompletionTokens = 0;
      let accReasoningTokens = 0;
      let accCachedTokens = 0;
      let hasRealUsage = false;
      let lastTelemetrySentMs = 0;

      const turnSources: SourceItem[] = [];
      const turnToolDigests: string[] = [];
      const cfg = getRoleWorkspaceConfig(resolvedLook);
      let activeTextPartId: string | null = null;
      let totalAssistantChars = 0;
      let turnTruncated = false;
      let lengthContinuations = 0;
      let continousUiTextAccum = "";
      let lockedModel: string | null = null;
      let abnormalFinishRetries = 0;
      let emittedNativeReasoningMeta = false;

      const closeActiveTextPart = () => {
        if (!activeTextPartId) return;
        send({ type: "part_end", partId: activeTextPartId });
        activeTextPartId = null;
      };

      const sendTelemetry = (
        stepCompletion = 0,
        stepReasoning = 0,
        stepPrompt = 0,
        stepCached = 0,
        force = false
      ) => {
        const now = Date.now();
        if (!force && now - lastTelemetrySentMs < 85) return;
        lastTelemetrySentMs = now;
        const totalOutTokens = hasRealUsage
          ? accCompletionTokens + accReasoningTokens + stepCompletion + stepReasoning
          : estTokens;
        send({
          type: "telemetry_update",
          tokenCount: totalOutTokens,
          elapsedSec: +((now - turnStartMs) / 1000).toFixed(1),
          ...(hasRealUsage
            ? {
                promptTokens: accPromptTokens + stepPrompt,
                completionTokens: accCompletionTokens + stepCompletion,
                reasoningTokens: accReasoningTokens + stepReasoning,
                cachedTokens: accCachedTokens + stepCached,
              }
            : {}),
        });
      };

      sendTelemetry(0, 0, 0, 0, true);

      const fetchNativeStream = async (
        modelId: string,
        contentsToSend: GeminiContent[],
        allowTools: boolean,
        includeNativeGoogleSearch = true,
        activeApiKey = apiKey,
        forceFunctionCall = false,
        disableThinkingForToolDispatch = false,
      ): Promise<{
        res: Response;
        usedModel: string;
        useReasoning: boolean;
      }> => {
        const meta = resolveModelMeta(modelId);
        const useReasoning =
          disableThinkingForToolDispatch
            ? false
            : meta.supportsReasoning
              ? wantReasoning
              : false;
        const maxOut = /^gemini-2\.5/i.test(modelId) && !useReasoning ? 16384 : 32768;
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

        const cleanGeminiContents = contentsToSend.map((c) => ({
          role: c.role,
          parts: c.parts.map((p) => {
            if (p.functionCall) {
              const { id: _ignored, ...restFc } = p.functionCall;
              return { ...p, functionCall: restFc };
            }
            if (p.functionResponse) {
              const { id: _ignored, ...restFr } = p.functionResponse;
              return { ...p, functionResponse: restFr };
            }
            return p;
          }),
        }));

        const effectiveNativeGoogle =
          allowTools && includeNativeGoogleSearch && !forceFunctionCall;
        const toolsSpec = allowTools
          ? effectiveNativeGoogle
            ? [
                { google_search: {} },
                { functionDeclarations: GEMINI_FUNCTION_DECLARATIONS },
              ]
            : [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }]
          : undefined;

        const payload: Record<string, unknown> = {
          systemInstruction: { parts: [{ text: activeStaticSystemPrompt }] },
          contents: cleanGeminiContents,
          generationConfig: {
            temperature: turnTemperature,
            maxOutputTokens: maxOut,
            thinkingConfig: buildThinkingConfig(
              modelId,
              useReasoning,
              resolvedEffort
            ),
          },
          ...(toolsSpec ? { tools: toolsSpec } : {}),
          ...(allowTools && forceFunctionCall
            ? {
                toolConfig: {
                  functionCallingConfig: {
                    mode: "ANY",
                    allowedFunctionNames: ["web_search", "search_images"],
                  },
                },
              }
            : {}),
        };

        const local = localModel(modelId);
        if (local) {
          // Same request, answered by the router or a CLI on this machine; the
          // reply comes back as Gemini SSE, so everything below stays as it is.
          const res = await streamFromLocalProvider(
            local,
            {
              systemInstruction: { parts: [{ text: activeStaticSystemPrompt }] },
              contents: contentsToSend,
              generationConfig: { temperature: turnTemperature, maxOutputTokens: maxOut },
              tools: toolsSpec,
              ...(allowTools && forceFunctionCall
                ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["web_search", "search_images"] } } }
                : {}),
            },
            request.signal,
          );
          return { res, usedModel: modelId, useReasoning: false };
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": activeApiKey,
          },
          signal: request.signal,
          body: JSON.stringify(payload),
        });
        return { res, usedModel: modelId, useReasoning };
      };

      try {
        const seenTurnImageKeys = new Set<string>();
        send({
          type: "turn_meta",
          look: resolvedLook,
          mood: resolvedMood,
          botLabel: body.pinnedBot?.name || undefined,
          hasNativeReasoning: false,
          modelHasReasoning: wantReasoning,
          modelId: selectedModelMeta.id,
          reasoningEffort: resolvedEffort,
          uiPlanMeta: activeUiPlanMeta,
        });

        const publicModelId = selectedModelMeta.id;
        const maxSteps = 5;
        for (let step = 0; step < maxSteps; step++) {
          if (request.signal.aborted) break;

          const allowToolsThisStep = step < maxSteps - 1;
          const forceStepZeroWebTool =
            step === 0 &&
            (mustVerifyOnWeb || mustFetchVisuals) &&
            allowToolsThisStep &&
            turnSources.length === 0 &&
            availableDataProfile.verifiedImages.length === 0;
          let activeModelId: string = lockedModel || modelList[0];
          let activeUseReasoning = wantReasoning;
          let lastHttpStatus = 0;

          let finishReason: string | null = null;
          let stepModelParts: GeminiPart[] = [];
          const stepToolCalls: PendingToolCall[] = [];
          let stepAnswerText = "";
          let stepPromptTokens = 0;
          let stepCompletionTokens = 0;
          let stepReasoningTokens = 0;
          let stepCachedTokens = 0;

          // Isolated XML <thought> parser (only activates on literal XML tags inside
          // non-thought text; NEVER shares state with native thought streams).
          let inXmlThoughtTag = false;
          let xmlThoughtBuf = "";

          const isContinuation = lengthContinuations > 0 && continousUiTextAccum.length > 0;
          const priorFenceAppearsClosed =
            isContinuation && /`{3,}\s*$/.test(continousUiTextAccum.trim());
          let contLeadChecked = !isContinuation || priorFenceAppearsClosed;
          let contLeadBuf = "";

          const emitThought = (t: string) => {
            if (!t) return;
            if (!emittedNativeReasoningMeta) {
              emittedNativeReasoningMeta = true;
              send({
                type: "turn_meta",
                look: resolvedLook,
                mood: resolvedMood,
                botLabel: body.pinnedBot?.name || undefined,
                hasNativeReasoning: true,
                modelHasReasoning: activeUseReasoning,
                modelId: publicModelId,
                reasoningEffort: activeUseReasoning ? resolvedEffort : "off",
                uiPlanMeta: activeUiPlanMeta,
              });
            }
            estTokens += Math.max(1, Math.round(t.length / 3.6));
            send({
              type: "reasoning_delta",
              delta: t,
              tokenCount: hasRealUsage
                ? accCompletionTokens +
                  accReasoningTokens +
                  stepCompletionTokens +
                  stepReasoningTokens
                : estTokens,
            });
            sendTelemetry(
              stepCompletionTokens,
              stepReasoningTokens,
              stepPromptTokens,
              stepCachedTokens
            );
          };

          const emitAnswerRaw = (delta: string) => {
            if (!delta) return;
            let textOut = delta;
            if (!contLeadChecked) {
              contLeadBuf += textOut;
              if (
                contLeadBuf.length < 48 &&
                !contLeadBuf.includes("\n")
              ) {
                return;
              }
              contLeadChecked = true;
              const trimmedLead = contLeadBuf.trimStart();
              const startsWithRestartedRoot =
                /^(?:`{3,}\s*(?:openui-lang|openui|ui|genui|json)?\s*)?root\s*=/i.test(
                  trimmedLead,
                );
              if (startsWithRestartedRoot) {
                const cleanRootLead = trimmedLead
                  .replace(
                    /^`{3,}\s*(?:openui-lang|openui|ui|genui|json)?[ \t]*(?:\r?\n)?/i,
                    "",
                  )
                  .trimStart();
                textOut = `\n\`\`\`\n\`\`\`openui-lang\n${cleanRootLead}`;
              } else {
                textOut = contLeadBuf.replace(
                  /^\s*`{3,}\s*(?:openui-lang|openui|ui|genui|json)?[ \t]*(?:\r?\n|$)/i,
                  "",
                );
                textOut = textOut.replace(/^\s*`{3,}\s*(?=root\s*=)/i, "");
                if (
                  /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Z][A-Za-z0-9_]*\s*\(/.test(
                    textOut.trimStart(),
                  ) &&
                  continousUiTextAccum.length > 0 &&
                  !continousUiTextAccum.endsWith("\n")
                ) {
                  textOut = `\n${textOut.trimStart()}`;
                }
              }
              contLeadBuf = "";
              if (!textOut) return;
            }

            estTokens += Math.max(1, Math.round(textOut.length / 3.6));
            if (!activeTextPartId && !textOut.trim()) return;
            if (!activeTextPartId) {
              activeTextPartId = nextPartId("txt");
              send({
                type: "part_start",
                partId: activeTextPartId,
                kind: "text",
              });
            }
            stepAnswerText += textOut;
            continousUiTextAccum += textOut;
            totalAssistantChars += textOut.length;
            send({
              type: "text_delta",
              partId: activeTextPartId,
              delta: textOut,
            });
            sendTelemetry(
              stepCompletionTokens,
              stepReasoningTokens,
              stepPromptTokens,
              stepCachedTokens
            );
          };

          const routeNonThoughtText = (raw: string) => {
            xmlThoughtBuf += raw;
            while (xmlThoughtBuf.length > 0) {
              if (!inXmlThoughtTag) {
                const openIdx = xmlThoughtBuf.indexOf("<thought>");
                if (openIdx === -1) {
                  const partial = xmlThoughtBuf.lastIndexOf("<");
                  if (
                    partial !== -1 &&
                    "<thought>".startsWith(xmlThoughtBuf.slice(partial))
                  ) {
                    emitAnswerRaw(xmlThoughtBuf.slice(0, partial));
                    xmlThoughtBuf = xmlThoughtBuf.slice(partial);
                    break;
                  }
                  emitAnswerRaw(xmlThoughtBuf);
                  xmlThoughtBuf = "";
                  break;
                }
                if (openIdx > 0) emitAnswerRaw(xmlThoughtBuf.slice(0, openIdx));
                xmlThoughtBuf = xmlThoughtBuf.slice(
                  openIdx + "<thought>".length
                );
                inXmlThoughtTag = true;
              } else {
                const closeIdx = xmlThoughtBuf.indexOf("</thought>");
                if (closeIdx === -1) {
                  const partial = xmlThoughtBuf.lastIndexOf("<");
                  if (
                    partial !== -1 &&
                    "</thought>".startsWith(xmlThoughtBuf.slice(partial))
                  ) {
                    emitThought(xmlThoughtBuf.slice(0, partial));
                    xmlThoughtBuf = xmlThoughtBuf.slice(partial);
                    break;
                  }
                  emitThought(xmlThoughtBuf);
                  xmlThoughtBuf = "";
                  break;
                }
                if (closeIdx > 0) emitThought(xmlThoughtBuf.slice(0, closeIdx));
                xmlThoughtBuf = xmlThoughtBuf.slice(
                  closeIdx + "</thought>".length
                );
                inXmlThoughtTag = false;
              }
            }
          };

          const pushModelPart = (rawPart: GeminiPart) => {
            if (
              rawPart.functionCall ||
              rawPart.inlineData ||
              typeof rawPart.text !== "string"
            ) {
              stepModelParts.push(rawPart);
              return;
            }
            const last = stepModelParts[stepModelParts.length - 1];
            if (
              last &&
              typeof last.text === "string" &&
              Boolean(last.thought) === Boolean(rawPart.thought) &&
              !last.functionCall &&
              !last.thoughtSignature
            ) {
              last.text += rawPart.text;
              if (rawPart.thoughtSignature) {
                last.thoughtSignature = rawPart.thoughtSignature;
              }
            } else {
              stepModelParts.push({ ...rawPart });
            }
          };

          let upstreamRes: Response | null = null;
          activeModelId = lockedModel ?? modelList[0];

          const attemptOrder: string[] = lockedModel
            ? [lockedModel, ...modelList.filter((m) => m !== lockedModel)]
            : modelList;

          for (let mIdx = 0; mIdx < attemptOrder.length; mIdx++) {
            const candidate = attemptOrder[mIdx];
            let contentsForAttempt = currentContents;
            if (lockedModel && candidate !== lockedModel) {
              const digestBlock =
                turnToolDigests.length > 0
                  ? `\n\n[Hasil Tool Terverifikasi Giliran Ini]\n${turnToolDigests.join("\n")}`
                  : "";
              contentsForAttempt = baseContents.map((c, idx) =>
                idx === baseContents.length - 1
                  ? {
                      role: c.role,
                      parts: [
                        ...c.parts.map((p) =>
                          typeof p.text === "string" && digestBlock
                            ? { ...p, text: `${p.text}${digestBlock}` }
                            : p
                        ),
                      ],
                    }
                  : c
              );
              currentContents = contentsForAttempt;
            }

            if (mIdx > 0) {
              send({
                type: "activity_update",
                label: "Menyelaraskan penalaran konteks...",
              });
            }

            try {
              // a local model needs no Gemini key: one attempt, with an empty placeholder
              const orderedKeys = localModel(candidate) ? [""] : getRotatedGeminiKeys(apiKeys);
              let modelSucceeded = false;
              let hadNonAuthModelFailure = false;

              for (let kIdx = 0; kIdx < orderedKeys.length; kIdx++) {
                const candKey = orderedKeys[kIdx];
                const tryGrounding =
                  allowToolsThisStep &&
                  !forceStepZeroWebTool &&
                  Date.now() >= googleSearchGroundingCooldownUntil;
                let attempt = await fetchNativeStream(
                  candidate,
                  contentsForAttempt,
                  allowToolsThisStep,
                  tryGrounding,
                  candKey,
                  forceStepZeroWebTool,
                  false,
                );
                if (forceStepZeroWebTool && attempt.res.status === 400) {
                  // Retry Step-0 mandatory web tool call with thinking disabled if model rejects thinkingConfig + ANY
                  const retryForceNoThink = await fetchNativeStream(
                    candidate,
                    contentsForAttempt,
                    true,
                    false,
                    candKey,
                    true,
                    true,
                  );
                  attempt = retryForceNoThink.res.ok
                    ? retryForceNoThink
                    : await fetchNativeStream(
                        candidate,
                        contentsForAttempt,
                        true,
                        false,
                        candKey,
                        false,
                        false,
                      );
                } else if (
                  tryGrounding &&
                  (attempt.res.status === 400 || attempt.res.status === 429)
                ) {
                  const retryNoGrounding = await fetchNativeStream(
                    candidate,
                    contentsForAttempt,
                    true,
                    false,
                    candKey,
                    false,
                    false,
                  );
                  if (retryNoGrounding.res.ok) {
                    googleSearchGroundingCooldownUntil =
                      Date.now() + GOOGLE_SEARCH_GROUNDING_COOLDOWN_MS;
                  }
                  attempt = retryNoGrounding;
                }
                lastHttpStatus = attempt.res.status;
                if (attempt.res.ok && attempt.res.body) {
                  modelCooldownUntil.delete(candidate);
                  geminiKeyCooldownUntil.delete(candKey);
                  upstreamRes = attempt.res;
                  activeModelId = attempt.usedModel;
                  activeUseReasoning = attempt.useReasoning;
                  lockedModel = activeModelId;
                  modelSucceeded = true;
                  break;
                }
                if (
                  attempt.res.status === 429 ||
                  attempt.res.status === 401 ||
                  attempt.res.status === 403 ||
                  attempt.res.status === 500 ||
                  attempt.res.status === 503
                ) {
                  if (candKey) markGeminiKeyCooldown(candKey, attempt.res.status);
                }
                if (
                  attempt.res.status === 429 ||
                  attempt.res.status === 503 ||
                  attempt.res.status === 500 ||
                  attempt.res.status === 404
                ) {
                  hadNonAuthModelFailure = true;
                }
              }

              if (modelSucceeded) break;
              if (hadNonAuthModelFailure) {
                markModelCooldown(candidate);
              }
            } catch (fetchErr) {
              if (request.signal.aborted) throw fetchErr;
            }
          }

          if (!upstreamRes || !upstreamRes.body) {
            closeActiveTextPart();
            send({
              type: "turn_error",
              message:
                "Layanan penalaran sedang mengalami batas permintaan sementara. Coba kirim ulang sebentar lagi.",
            });
            closeStream();
            return;
          }

          if (step === 0 || activeModelId !== selectedModelMeta.id) {
            send({
              type: "turn_meta",
              look: resolvedLook,
              mood: resolvedMood,
              botLabel: body.pinnedBot?.name || undefined,
              hasNativeReasoning: emittedNativeReasoningMeta,
              modelHasReasoning: activeUseReasoning,
              modelId: publicModelId,
              reasoningEffort: activeUseReasoning ? resolvedEffort : "off",
              uiPlanMeta: activeUiPlanMeta,
            });
          }

          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let sseLineBuf = "";
          let stepGoogleCallId: string | null = null;
          let stepGoogleStartedAt = 0;
          const stepGoogleQueries: string[] = [];
          const stepGoogleSources: Array<{
            title: string;
            url: string;
            domain: string;
          }> = [];

          const processSseLine = (rawLine: string) => {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") return;

            let chunk: GeminiSseChunk;
            try {
              chunk = JSON.parse(payload) as GeminiSseChunk;
            } catch {
              return;
            }

            if (chunk.usageMetadata) {
              hasRealUsage = true;
              const u = chunk.usageMetadata;
              if (typeof u.promptTokenCount === "number") {
                stepPromptTokens = u.promptTokenCount;
              }
              if (typeof u.candidatesTokenCount === "number") {
                stepCompletionTokens = u.candidatesTokenCount;
              }
              if (typeof u.thoughtsTokenCount === "number") {
                stepReasoningTokens = u.thoughtsTokenCount;
              }
              if (typeof u.cachedContentTokenCount === "number") {
                stepCachedTokens = u.cachedContentTokenCount;
              }
              sendTelemetry(
                stepCompletionTokens,
                stepReasoningTokens,
                stepPromptTokens,
                stepCachedTokens
              );
            }

            const cand = chunk.candidates?.[0];
            if (!cand) return;
            if (cand.finishReason) {
              finishReason = cand.finishReason;
            }

            if (cand.groundingMetadata) {
              const gm = cand.groundingMetadata;
              if (Array.isArray(gm.webSearchQueries)) {
                for (const q of gm.webSearchQueries) {
                  const cleanQ = typeof q === "string" ? q.trim() : "";
                  if (cleanQ && !stepGoogleQueries.includes(cleanQ)) {
                    stepGoogleQueries.push(cleanQ);
                  }
                }
              }
              if (Array.isArray(gm.groundingChunks)) {
                for (const gc of gm.groundingChunks) {
                  const rawUri = typeof gc?.web?.uri === "string" ? gc.web.uri.trim() : "";
                  if (!/^https?:\/\//i.test(rawUri)) continue;
                  if (stepGoogleSources.some((s) => s.url === rawUri)) continue;
                  const rawTitle =
                    typeof gc?.web?.title === "string" && gc.web.title.trim()
                      ? gc.web.title.trim()
                      : extractHostname(rawUri);
                  const domain = extractGroundingDomain(rawUri, rawTitle);
                  stepGoogleSources.push({
                    title: rawTitle,
                    url: rawUri,
                    domain,
                  });
                }
              }
              if (
                !stepGoogleCallId &&
                (stepGoogleQueries.length > 0 || stepGoogleSources.length > 0)
              ) {
                stepGoogleCallId = `gsearch_${step}_${turnSuffix}`;
                stepGoogleStartedAt = Date.now();
                const previewQ = stepGoogleQueries[0]
                  ? formatActivityQuery(stepGoogleQueries[0], 100)
                  : "";
                send({
                  type: "tool_start",
                  toolCallId: stepGoogleCallId,
                  name: "google_search",
                  label: previewQ
                    ? `Menelusuri web: ${previewQ}`
                    : "Menelusuri sumber web",
                  argsPreview: previewQ || "Verifikasi fakta web",
                  ...(previewQ ? { query: previewQ } : {}),
                });
              }
            }

            const parts = cand.content?.parts;
            if (!Array.isArray(parts)) return;

            for (const part of parts) {
              if (part.functionCall && typeof part.functionCall.name === "string") {
                part.functionCall.name = normalizeToolName(part.functionCall.name);
              }
              pushModelPart(part);

              if (part.thought === true) {
                if (typeof part.text === "string" && part.text.length > 0) {
                  emitThought(part.text);
                }
                continue;
              }

              if (typeof part.text === "string" && part.text.length > 0) {
                routeNonThoughtText(part.text);
              }

              if (part.functionCall && typeof part.functionCall.name === "string") {
                closeActiveTextPart();
                const fnName = part.functionCall.name;
                const fnArgs =
                  part.functionCall.args &&
                  typeof part.functionCall.args === "object" &&
                  !Array.isArray(part.functionCall.args)
                    ? part.functionCall.args
                    : {};
                const callId = `call_${step}_${stepToolCalls.length}_${turnSuffix}`;
                const query =
                  typeof fnArgs.query === "string" ? fnArgs.query.trim() : "";
                const statusNote =
                  typeof fnArgs.statusNote === "string"
                    ? fnArgs.statusNote.trim()
                    : "";

                stepToolCalls.push({
                  id: callId,
                  name: fnName,
                  args: fnArgs,
                  startedAt: Date.now(),
                });

                const defaultLabel =
                  fnName === "web_search"
                    ? "Menelusuri sumber web"
                    : fnName === "search_images"
                      ? "Mencari foto kontekstual"
                      : fnName === "sync_workspace_board"
                        ? `Menyelaraskan ${cfg.boardLabel}`
                        : "Memverifikasi konteks";

                const cleanNote = statusNote ? formatActivityQuery(statusNote, 110) : "";
                const cleanQuery = query ? formatActivityQuery(query, 110) : "";

                send({
                  type: "tool_start",
                  toolCallId: callId,
                  name: fnName,
                  label: cleanNote || defaultLabel,
                  argsPreview: cleanQuery || cleanNote || cfg.label,
                  ...(cleanQuery ? { query: cleanQuery } : {}),
                });

                if (cleanNote || cleanQuery) {
                  send({
                    type: "activity_update",
                    label:
                      cleanNote ||
                      (fnName === "search_images"
                        ? `Mencari foto: ${cleanQuery}`
                        : `Mencari: ${cleanQuery}`),
                  });
                }
              }
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              sseLineBuf += decoder.decode();
              break;
            }
            if (request.signal.aborted) break;

            sseLineBuf += decoder.decode(value, { stream: true });
            const lines = sseLineBuf.split("\n");
            sseLineBuf = lines.pop() ?? "";
            for (const rawLine of lines) {
              processSseLine(rawLine);
            }
          }

          if (sseLineBuf.trim() && !request.signal.aborted) {
            for (const rawLine of sseLineBuf.split("\n")) {
              processSseLine(rawLine);
            }
            sseLineBuf = "";
          }

          try {
            if (request.signal.aborted) await reader.cancel().catch(() => {});
            else reader.releaseLock();
          } catch {
            // Reader already released
          }

          if (stepGoogleCallId) {
            for (const gs of stepGoogleSources) {
              if (!turnSources.some((existing) => existing.url === gs.url)) {
                turnSources.push({
                  title: gs.title,
                  url: gs.url,
                  domain: gs.domain,
                  description: stepGoogleQueries.join(" · ") || "Google Search Grounding",
                });
              }
            }
            if (turnSources.length > 0) {
              send({
                type: "sources_update",
                sources: [...turnSources],
              });
            }
            const gDomains = Array.from(
              new Set(stepGoogleSources.map((s) => s.domain).filter(Boolean)),
            ).slice(0, 5);
            const gPreview = stepGoogleSources.slice(0, 4).map((s) => ({
              title: s.title,
              url: s.url,
              domain: s.domain,
            }));
            const gQueryJoined = stepGoogleQueries.slice(0, 2).join(" | ");
            send({
              type: "tool_result",
              toolCallId: stepGoogleCallId,
              name: "google_search",
              summary:
                stepGoogleSources.length > 0
                  ? `${stepGoogleSources.length} sumber relevan`
                  : `${Math.max(1, stepGoogleQueries.length)} penelusuran web`,
              elapsedMs: Math.max(120, Date.now() - stepGoogleStartedAt),
              ...(gQueryJoined ? { query: formatActivityQuery(gQueryJoined, 120) } : {}),
              domains: gDomains,
              resultsPreview: gPreview,
            });
            availableDataProfile = enrichDataProfileFromTextAndTools(
              {
                ...availableDataProfile,
                webResultCount:
                  availableDataProfile.webResultCount + stepGoogleSources.length,
                verifiedDomains: Array.from(
                  new Set([...availableDataProfile.verifiedDomains, ...gDomains]),
                ),
              },
              {
                userText: latestUserText,
                toolSnippets: stepGoogleQueries,
              },
            );
          }

          if (!contLeadChecked && contLeadBuf) {
            contLeadChecked = true;
            const cleanedLead = contLeadBuf.replace(
              /^\s*`{3,}\s*(?:openui-lang|openui|ui|genui|json)?[^\n]*\r?\n?/i,
              ""
            );
            contLeadBuf = "";
            if (cleanedLead) emitAnswerRaw(cleanedLead);
          }

          if (xmlThoughtBuf) {
            if (inXmlThoughtTag) emitThought(xmlThoughtBuf);
            else emitAnswerRaw(xmlThoughtBuf);
            xmlThoughtBuf = "";
          }

          accPromptTokens += stepPromptTokens;
          accCompletionTokens += stepCompletionTokens;
          accReasoningTokens += stepReasoningTokens;
          accCachedTokens += stepCachedTokens;
          sendTelemetry(0, 0, 0, 0, true);

          if (request.signal.aborted) {
            for (const tc of stepToolCalls) {
              send({
                type: "tool_result",
                toolCallId: tc.id,
                name: tc.name,
                summary: "Dihentikan",
                elapsedMs: Math.max(80, Date.now() - tc.startedAt),
              });
            }
            closeStream();
            return;
          }

          if (stepToolCalls.length > 0) {
            closeActiveTextPart();
            continousUiTextAccum = "";
            lengthContinuations = 0;
            const functionResponseParts = await Promise.all(
              stepToolCalls.map(async (tc): Promise<GeminiPart> => {
                const effectiveName = tc.name;

                if (effectiveName === "web_search") {
                  const rawQuery =
                    typeof tc.args.query === "string" && tc.args.query.trim()
                      ? tc.args.query.trim()
                      : latestUserText;
                  const numResults =
                    typeof tc.args.numResults === "number"
                      ? tc.args.numResults
                      : 5;
                  const provider =
                    tc.args.provider === "tinyfish" ||
                    tc.args.provider === "exa" ||
                    tc.args.provider === "firecrawl" ||
                    tc.args.provider === "auto"
                      ? tc.args.provider
                      : "auto";

                  const searchOut = await runWebSearch({
                    query: rawQuery,
                    numResults: body.isRetry ? Math.max(numResults, 7) : numResults,
                    provider,
                    expand: true,
                    news:
                      NEWS_INTENT_PATTERN.test(latestUserText) ||
                      NEWS_INTENT_PATTERN.test(rawQuery),
                    isRetry: Boolean(body.isRetry),
                    sessionAnchor: sessionLedger.sessionSearchAnchor || undefined,
                    signal: request.signal,
                  });

                  for (const s of searchOut.sources) {
                    if (!turnSources.some((existing) => existing.url === s.url)) {
                      // A page's og:image is often a logo or banner. Keep it out of the
                      // turn's image candidates; only `search_images` results are photo-checked.
                      // It may still illustrate its own story in a NewsFeed row.
                      const { imageUrl: pageImage, ...textSource } = s;
                      turnSources.push(
                        pageImage && isUsableArticleImageUrl(pageImage)
                          ? { ...textSource, articleImageUrl: pageImage }
                          : textSource,
                      );
                    }
                  }
                  if (turnSources.length > 0) {
                    send({
                      type: "sources_update",
                      sources: [...turnSources],
                    });
                  }

                  const domains = Array.from(
                    new Set(
                      searchOut.results
                        .map((r) => extractHostname(r.url))
                        .filter(Boolean)
                    )
                  ).slice(0, 5);
                  const resultsPreview = searchOut.results
                    .slice(0, 4)
                    .map((r) => ({
                      title: r.title,
                      url: r.url,
                      domain: extractHostname(r.url),
                      ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
                    }));

                  const summaryStr = searchOut.error
                    ? "Penelusuran web selesai"
                    : searchOut.results.length > 0
                      ? `${searchOut.results.length} sumber relevan`
                      : "Tidak ada sumber relevan ditemukan";

                  send({
                    type: "tool_result",
                    toolCallId: tc.id,
                    name: effectiveName,
                    summary: summaryStr,
                    elapsedMs: Math.max(120, Date.now() - tc.startedAt),
                    query: searchOut.query,
                    domains,
                    resultsPreview,
                  });

                  const compactResults = searchOut.results.map(
                    (r: WebSearchResultItem, idx: number) => ({
                      ref: idx + 1,
                      title: r.title,
                      url: r.url,
                      snippet: r.snippet.slice(0, idx < 4 ? 2600 : 1200),
                      ...(r.publishedDate
                        ? { publishedDate: r.publishedDate }
                        : {}),
                    })
                  );
                  const digestEntry = `web_search("${searchOut.query}"): ${compactResults
                    .slice(0, 4)
                    .map((r) => `${r.title} [${r.url}]: ${r.snippet.slice(0, 900)}`)
                    .join(" | ")}`;
                  turnToolDigests.push(digestEntry);
                  availableDataProfile = enrichDataProfileFromTextAndTools(
                    {
                      ...availableDataProfile,
                      webResultCount:
                        availableDataProfile.webResultCount +
                        searchOut.results.length,
                      verifiedDomains: Array.from(
                        new Set([
                          ...availableDataProfile.verifiedDomains,
                          ...domains,
                        ]),
                      ),
                    },
                    {
                      userText: latestUserText,
                      toolSnippets: [digestEntry],
                    },
                  );

                  return {
                    functionResponse: {
                      id: tc.id,
                      name: effectiveName,
                      response: {
                        query: searchOut.query,
                        providersUsed: searchOut.providersUsed,
                        results: compactResults,
                        note: "Cite verified `url` links with inline (1), (2). These are text sources, not photos: for images call `search_images` (or set `imageQuery`); never pass a webpage `url` as an image. For a news digest, put each story's exact `url` and `publishedDate` into `NewsFeed` articles; the app adds the article photo.",
                      },
                    },
                  };
                }

                if (effectiveName === "search_images") {
                  const imgQuery =
                    typeof tc.args.query === "string" && tc.args.query.trim()
                      ? tc.args.query.trim()
                      : latestUserText;
                  const limit =
                    typeof tc.args.limit === "number" ? tc.args.limit : 4;

                  const imgOut = await runImageSearch({
                    query: imgQuery,
                    contextAnchor: sessionLedger.sessionSearchAnchor
                      ? `${sessionLedger.sessionSearchAnchor} ${latestUserText}`
                      : latestUserText,
                    limit: Math.max(limit, 6),
                    isRetry: Boolean(body.isRetry),
                    signal: request.signal,
                  });

                  const dedupedAssets = imgOut.assets.filter((a) => {
                    const candidateUrl = a.thumbnailUrl || a.imageUrl;
                    const kUrl = normalizeImageDedupKey(candidateUrl);
                    const kFull = normalizeImageDedupKey(a.imageUrl);
                    const kStem = extractImageAssetStem(candidateUrl);
                    const kFullStem = extractImageAssetStem(a.imageUrl);
                    if (
                      seenTurnImageKeys.has(kUrl) ||
                      seenTurnImageKeys.has(kFull) ||
                      seenTurnImageKeys.has(kStem) ||
                      seenTurnImageKeys.has(kFullStem)
                    ) {
                      return false;
                    }
                    seenTurnImageKeys.add(kUrl);
                    seenTurnImageKeys.add(kFull);
                    seenTurnImageKeys.add(kStem);
                    seenTurnImageKeys.add(kFullStem);
                    return true;
                  });

                  const dedupedUrlSet = new Set(
                    dedupedAssets.flatMap((a) => [a.imageUrl, a.thumbnailUrl, a.sourceUrl].filter(Boolean)),
                  );
                  for (const s of imgOut.sources) {
                    if (
                      (s.imageUrl && dedupedUrlSet.has(s.imageUrl)) ||
                      dedupedUrlSet.has(s.url)
                    ) {
                      if (!turnSources.some((existing) => existing.url === s.url)) {
                        turnSources.push(s);
                      }
                    }
                  }
                  if (turnSources.length > 0) {
                    send({
                      type: "sources_update",
                      sources: [...turnSources],
                    });
                  }

                  const domains = Array.from(
                    new Set(
                      dedupedAssets
                        .map((a) => extractHostname(a.sourceUrl))
                        .filter(Boolean)
                    )
                  ).slice(0, 5);
                  const imagePreviews = dedupedAssets.slice(0, 4).map((a) => ({
                    imageUrl: a.thumbnailUrl || a.imageUrl,
                    caption: a.caption,
                    sourceUrl: a.sourceUrl,
                  }));

                  const summaryStr =
                    dedupedAssets.length > 0
                      ? `${dedupedAssets.length} foto kontekstual`
                      : "Tidak ada foto kontekstual ditemukan";

                  send({
                    type: "tool_result",
                    toolCallId: tc.id,
                    name: effectiveName,
                    summary: summaryStr,
                    elapsedMs: Math.max(120, Date.now() - tc.startedAt),
                    query: imgOut.query,
                    domains,
                    imagePreviews,
                  });

                  if (dedupedAssets.length > 0) {
                    for (const a of dedupedAssets) {
                      if (a.imageUrl) turnImagePoolSet.add(a.imageUrl);
                      if (a.thumbnailUrl) turnImagePoolSet.add(a.thumbnailUrl);
                    }
                    send({ type: "image_pool", urls: [...turnImagePoolSet] });
                  }

                  if (dedupedAssets.length > 0) {
                    availableDataProfile = {
                      ...availableDataProfile,
                      verifiedImages: [
                        ...availableDataProfile.verifiedImages,
                        ...dedupedAssets.map((a) => ({
                          query: imgOut.query,
                          imageUrl: a.thumbnailUrl || a.imageUrl,
                          sourceUrl: a.sourceUrl,
                          caption: a.caption,
                        })),
                      ],
                    };
                  }

                  turnToolDigests.push(
                    `search_images("${imgOut.query}"): ${dedupedAssets
                      .slice(0, 4)
                      .map((a) => `${a.caption || imgOut.query} -> ${a.imageUrl}`)
                      .join(" | ")}`
                  );

                  return {
                    functionResponse: {
                      id: tc.id,
                      name: effectiveName,
                      response: {
                        query: imgOut.query,
                        providersUsed: imgOut.providersUsed,
                        assets: dedupedAssets.map((a) => ({
                          id: a.id,
                          imageUrl: a.thumbnailUrl || a.imageUrl,
                          fullImageUrl: a.imageUrl,
                          sourceUrl: a.sourceUrl,
                          caption: a.caption,
                          provider: a.provider,
                        })),
                        note: "Bind these verified `imageUrl` and `sourceUrl` values into visual blocks, or pass `null` when no photo applies.",
                      },
                    },
                  };
                }

                if (effectiveName === "sync_workspace_board") {
                  const cols = Array.isArray(tc.args.columns)
                    ? (tc.args.columns as WorkspaceBoardColumn[])
                    : [];
                  const items = Array.isArray(tc.args.items)
                    ? (tc.args.items as WorkspaceBoardItem[])
                    : [];

                  if (cols.length > 0) {
                    const hydratedItems = await hydrateBoardItemsMedia(items, latestUserText);
                    send({
                      type: "board_update",
                      columns: cols,
                      items: hydratedItems,
                    });
                    availableDataProfile = {
                      ...availableDataProfile,
                      boardSynced: true,
                      boardItemsCount: hydratedItems.length,
                    };
                  }

                  send({
                    type: "tool_result",
                    toolCallId: tc.id,
                    name: effectiveName,
                    summary:
                      cols.length > 0
                        ? `${items.length} item disinkron ke ${cfg.boardLabel}`
                        : "Struktur board tidak valid",
                    elapsedMs: Math.max(120, Date.now() - tc.startedAt),
                  });

                  return {
                    functionResponse: {
                      id: tc.id,
                      name: effectiveName,
                      response: {
                        synced: cols.length > 0,
                        columnsCount: cols.length,
                        itemsCount: items.length,
                      },
                    },
                  };
                }

                send({
                  type: "tool_result",
                  toolCallId: tc.id,
                  name: effectiveName,
                  summary: `Tool ${effectiveName} tidak tersedia`,
                  elapsedMs: Math.max(80, Date.now() - tc.startedAt),
                });
                return {
                  functionResponse: {
                    id: tc.id,
                    name: effectiveName,
                    response: { error: `Unknown tool ${effectiveName}` },
                  },
                };
              })
            );

            // Recompute Context-Aware UIPlan & dynamic capability subset from verified tool outputs
            activeUiPlan = planContextAwareUi(buildPlanningContext());
            activeUiPlanMeta = toUiPlanSummaryMeta(activeUiPlan);
            activeStaticSystemPrompt = buildStaticMomoSystemPrompt(
              resolvedLook,
              activeWorkspaceView,
              { allowedComponents: activeUiPlan.allowedComponents },
            );
            const postToolPlanBlock = formatUiPlanPromptBlock(
              activeUiPlan,
              buildPlanningContext(),
            );
            turnToolDigests.push(postToolPlanBlock);
            send({
              type: "turn_meta",
              look: resolvedLook,
              mood: resolvedMood,
              botLabel: body.pinnedBot?.name || undefined,
              hasNativeReasoning: emittedNativeReasoningMeta,
              modelHasReasoning: activeUseReasoning,
              modelId: publicModelId,
              reasoningEffort: activeUseReasoning ? resolvedEffort : "off",
              uiPlanMeta: activeUiPlanMeta,
            });

            currentContents = [
              ...currentContents,
              { role: "model", parts: stepModelParts },
              {
                role: "user",
                parts: [
                  ...functionResponseParts,
                  { text: `\n\n${postToolPlanBlock}` },
                ],
              },
            ];
            continue;
          }

          // A stream that ends without a normal finish reason (dropped connection, RECITATION,
          // OTHER, …) leaves an answer cut off mid-sentence. Discard that partial and redo the step
          // rather than presenting it as a finished reply.
          const finishedNormally = /^(?:STOP|MAX_TOKENS|LENGTH|TOOL_CALLS|FUNCTION_CALL|END_TURN)$/i.test(
            finishReason ?? "",
          );
          // A policy block will not change on retry; a continuation is finished as-is.
          const blockedByPolicy = /SAFETY|PROHIBITED|BLOCKLIST|SPII|content_filter/i.test(finishReason ?? "");
          const retryAbnormalFinish =
            !finishedNormally && !blockedByPolicy && lengthContinuations === 0 && abnormalFinishRetries < 2;
          if (!finishedNormally && !retryAbnormalFinish) turnTruncated = true;
          if (retryAbnormalFinish) {
            abnormalFinishRetries++;
            console.warn(
              `[brain] step ${step} ended abnormally (finishReason=${finishReason ?? "none"}, chars=${stepAnswerText.length}); retrying`,
            );
            if (stepAnswerText.length > 0) {
              continousUiTextAccum = continousUiTextAccum.slice(
                0,
                Math.max(0, continousUiTextAccum.length - stepAnswerText.length),
              );
              totalAssistantChars = Math.max(0, totalAssistantChars - stepAnswerText.length);
            }
            if (activeTextPartId) {
              send({ type: "part_discard", partId: activeTextPartId });
              activeTextPartId = null;
            }
            step--;
            continue;
          }

          const hitTokenLimit = /MAX_TOKENS|LENGTH/i.test(finishReason ?? "");
          const probeText = /`{3,}\s*$/.test(continousUiTextAccum)
            ? `${continousUiTextAccum}\n`
            : continousUiTextAccum;
          const unclosedUi = hasUnclosedOpenUiStream(probeText);
          const missingRefs = unclosedUi ? getOpenUiUnresolvedRefs(probeText) : [];
          const restartedRootOnCont =
            isContinuation && /^\s*(?:`{3,}\s*)?root\s*=/m.test(stepAnswerText);
          const maxAllowedContinuations = hitTokenLimit || unclosedUi ? 3 : 1;
          const needsContinuation =
            (hitTokenLimit || unclosedUi) &&
            !restartedRootOnCont &&
            stepAnswerText.trim().length > 0;

          if (needsContinuation && lengthContinuations < maxAllowedContinuations) {
            lengthContinuations++;
            const cleanModelParts =
              stepModelParts.length > 0
                ? stepModelParts
                : [{ text: stepAnswerText }];
            const refHint =
              missingRefs.length > 0
                ? ` Pastikan seluruh definisi variabel yang masih belum lengkap (${missingRefs.slice(0, 24).join(", ")}) ditulis tuntas.`
                : "";
            const fenceAlreadyClosed = /`{3,}\s*$/.test(continousUiTextAccum.trim());
            const contInstruction =
              fenceAlreadyClosed && missingRefs.length > 0
                ? `Blok OpenUI sebelumnya masih memiliki referensi yang belum didefinisikan (${missingRefs.slice(0, 24).join(", ")}). Keluarkan blok \`\`\`openui-lang singkat yang HANYA mendefinisikan variabel-variabel tersebut hingga tuntas.`
                : `Lanjutkan tepat dari statement/karakter terakhir tanpa mengulang teks atau pembuka \`\`\`openui-lang yang sudah tertulis, lalu tuntaskan statement yang tersisa${refHint} dan tutup pagar \`\`\`.`;
            currentContents = [
              ...currentContents,
              { role: "model", parts: cleanModelParts },
              {
                role: "user",
                parts: [
                  {
                    text: contInstruction,
                  },
                ],
              },
            ];
            step--;
            continue;
          }

          if (hitTokenLimit) {
            turnTruncated = true;
          } else if (unclosedUi) {
            const finalResolvedBlocks = parseMixedStreamToMistlineBlocks(
              continousUiTextAccum,
              { final: true },
            );
            const hasUsableContent =
              finalResolvedBlocks.some((b) => b.kind === "ui") ||
              finalResolvedBlocks.some(
                (b) => b.kind === "text" && b.text.trim().length > 80,
              );
            if (!hasUsableContent) {
              turnTruncated = true;
            }
          }
          break;
        }

        closeActiveTextPart();

        if (totalAssistantChars === 0 && !request.signal.aborted) {
          send({
            type: "turn_error",
            message:
              "Model menyelesaikan eksekusi tanpa mengembalikan teks jawaban. Coba kirim ulang pertanyaanmu.",
          });
          closeStream();
          return;
        }

        const totalSec = Math.max(
          0.2,
          +((Date.now() - turnStartMs) / 1000).toFixed(1)
        );
        const finalTokenCount = hasRealUsage
          ? accCompletionTokens + accReasoningTokens
          : estTokens;
        if (titlePromise) {
          await Promise.race([titlePromise, new Promise((r) => setTimeout(r, 2500))]);
        }
        sendTelemetry(0, 0, 0, 0, true);
        send({
          type: "turn_done",
          mood: "happy",
          tokenCount: finalTokenCount,
          elapsedSec: totalSec,
          ...(hasRealUsage
            ? {
                promptTokens: accPromptTokens,
                completionTokens: accCompletionTokens,
                reasoningTokens: accReasoningTokens,
                cachedTokens: accCachedTokens,
              }
            : {}),
          modelId: publicModelId,
          ...(turnSources.length > 0 ? { sources: turnSources } : {}),
          ...(turnTruncated ? { truncated: true } : {}),
        });
      } catch (err) {
        if (!request.signal.aborted) {
          send({
            type: "turn_error",
            message:
              err instanceof Error
                ? err.message
                : "Terjadi kendala saat menghubungkan ke model.",
          });
        }
      } finally {
        closeStream();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
