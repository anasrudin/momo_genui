export type ModelBrandId = "nvidia" | "google" | "deepseek" | "openai" | "anthropic";

/**
 * Where a model is served from:
 *  - "gemini":     Google's Gemini API with GEMINI_API_KEY (the original path)
 *  - "router":     an OpenAI-compatible router on this machine (9router)
 *  - "claude-cli": Claude Code run headless, on the login of the machine's user
 *  - "gemini-cli": Gemini CLI run headless, same idea
 */
export type ModelProvider = "gemini" | "router" | "claude-cli" | "gemini-cli";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export type ModelReasoningMode = "none" | "optional_levels" | "always_levels";

export interface MomoModelOption {
  id: string;
  brand: ModelBrandId;
  label: string;
  shortLabel: string;
  description: string;
  supportsReasoning: boolean;
  reasoningMode: ModelReasoningMode;
  reasoningLevels: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  /** Absent = "gemini". */
  provider?: ModelProvider;
  /** The backend's own name for the model (a 9router id, a CLI `--model` value). Defaults to `id`. */
  upstreamId?: string;
}

const NO_REASONING = {
  supportsReasoning: false,
  reasoningMode: "none",
  reasoningLevels: [],
  defaultEffort: "off",
} as const satisfies Partial<MomoModelOption>;

const GEMINI_API_MODELS: MomoModelOption[] = [
  {
    id: "gemini-3.5-flash-lite",
    brand: "google",
    label: "Gemini 3.5 Flash Lite",
    shortLabel: "3.5 Lite",
    description: "Kencang · Responsif & pikir",
    supportsReasoning: true,
    reasoningMode: "optional_levels",
    reasoningLevels: ["off", "low", "medium", "high"],
    defaultEffort: "off",
  },
  {
    id: "gemini-3.5-flash",
    brand: "google",
    label: "Gemini 3.5 Flash",
    shortLabel: "3.5 Flash",
    description: "Utama · Multimodal & mendalam",
    supportsReasoning: true,
    reasoningMode: "optional_levels",
    reasoningLevels: ["off", "low", "medium", "high"],
    defaultEffort: "off",
  },
  {
    id: "gemini-3-flash-preview",
    brand: "google",
    label: "Gemini 3 Flash",
    shortLabel: "Gemini 3",
    description: "Analitis · Penalaran kompleks",
    supportsReasoning: true,
    reasoningMode: "optional_levels",
    reasoningLevels: ["off", "low", "medium", "high"],
    defaultEffort: "off",
  },
];

/**
 * Models served from the machine Momo runs on. Ids carry no "/" on purpose:
 * the brain route strips a leading `provider/` from model ids.
 */
const LOCAL_MODELS: MomoModelOption[] = [
  {
    id: "router-gemini-3-flash",
    brand: "google",
    label: "Gemini 3 Flash · 9router",
    shortLabel: "Gemini 3",
    description: "Lewat 9router · tool & gambar",
    provider: "router",
    upstreamId: "ag/gemini-3-flash",
    ...NO_REASONING,
  },
  {
    id: "router-hermes",
    brand: "deepseek",
    label: "Combo hermes · 9router",
    shortLabel: "hermes",
    description: "Lewat 9router · fallback otomatis",
    provider: "router",
    upstreamId: "hermes",
    ...NO_REASONING,
  },
  {
    id: "router-claude-sonnet",
    brand: "anthropic",
    label: "Claude Sonnet · 9router",
    shortLabel: "Sonnet",
    description: "Lewat 9router · akun Claude",
    provider: "router",
    upstreamId: "cc/claude-sonnet-4-6",
    ...NO_REASONING,
  },
  {
    id: "claude-cli-sonnet",
    brand: "anthropic",
    label: "Claude Sonnet · CLI",
    shortLabel: "Sonnet CLI",
    description: "Claude Code di server · teks",
    provider: "claude-cli",
    upstreamId: "sonnet",
    ...NO_REASONING,
  },
  {
    id: "claude-cli-haiku",
    brand: "anthropic",
    label: "Claude Haiku · CLI",
    shortLabel: "Haiku CLI",
    description: "Claude Code di server · cepat",
    provider: "claude-cli",
    upstreamId: "haiku",
    ...NO_REASONING,
  },
  {
    id: "gemini-cli",
    brand: "google",
    label: "Gemini · CLI",
    shortLabel: "Gemini CLI",
    description: "Gemini CLI di server · teks",
    provider: "gemini-cli",
    upstreamId: "",
    ...NO_REASONING,
  },
];

export const MOMO_ALL_MODELS: MomoModelOption[] = [...GEMINI_API_MODELS, ...LOCAL_MODELS];

/**
 * Which models the picker offers, in order: a comma-separated list of ids.
 * Unset (or nothing recognised) = the three Gemini API models, as before.
 */
export function pickModelCatalog(raw: string | undefined): MomoModelOption[] {
  const picked: MomoModelOption[] = [];
  for (const id of (raw ?? "").split(/[\s,;]+/)) {
    const m = MOMO_ALL_MODELS.find((x) => x.id === id.trim());
    if (m && !picked.includes(m)) picked.push(m);
  }
  return picked.length ? picked : GEMINI_API_MODELS;
}

// NEXT_PUBLIC_ so the browser's picker and the server agree; it is read at build time.
export const MOMO_MODEL_CATALOG: MomoModelOption[] = pickModelCatalog(process.env.NEXT_PUBLIC_MOMO_MODELS);

export const providerOf = (m: MomoModelOption): ModelProvider => m.provider ?? "gemini";

export function normalizeReasoningEffort(
  meta: MomoModelOption,
  requested?: ReasoningEffort | boolean | null
): ReasoningEffort {
  if (meta.reasoningMode === "none" || meta.reasoningLevels.length === 0) {
    return "off";
  }
  if (typeof requested === "boolean") {
    return requested
      ? meta.defaultEffort === "off"
        ? "medium"
        : meta.defaultEffort
      : meta.reasoningLevels.includes("off")
        ? "off"
        : meta.defaultEffort;
  }
  if (requested && meta.reasoningLevels.includes(requested)) {
    return requested;
  }
  return meta.defaultEffort;
}

export function resolveModelMeta(modelId?: string | null): MomoModelOption {
  const clean = (modelId || "").trim().replace(/^google\//i, "");
  const matched = MOMO_MODEL_CATALOG.find((m) => m.id === clean);
  if (matched) return matched;
  if (clean === "gemini-flash-lite-latest") {
    return {
      ...MOMO_MODEL_CATALOG[0],
      id: clean,
    };
  }
  if (/pro|gpt-5|claude/i.test(clean)) {
    return MOMO_MODEL_CATALOG[2] ?? MOMO_MODEL_CATALOG[0];
  }
  if (/flash/i.test(clean) && !/lite/i.test(clean)) {
    return MOMO_MODEL_CATALOG[1] ?? MOMO_MODEL_CATALOG[0];
  }
  return MOMO_MODEL_CATALOG[0];
}
