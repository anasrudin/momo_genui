"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AnimatePresence,
  motion,
  useAnimate,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  Check,
  History,
  House,
  MessageSquare,
  PanelLeft,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { MomoHeroCanvas } from "@/avatar/MomoStage";
import { MomoMiniCanvas } from "@/avatar/MomoMiniCanvas";
import { setMiniAvatarStreamBusy } from "@/avatar/rendererSingleton";
import { useMomoStage } from "@/avatar/useMomoStage";
import { MomoComposer } from "@/components/composer/MomoComposer";
import { HeroAskLockup } from "@/components/hero/HeroAskLockup";
import { MomoIcon } from "@/components/icons/MomoIcon";
import {
  EASE_EXIT,
  EASE_MOMO,
  SPRING_THUMB,
} from "@/components/motion/MotionPrimitives";
import {
  DEFAULT_MOOD_BY_LOOK,
  LOOK_JOBS,
  LOOK_NAMES,
  ROLE_PALETTES,
} from "@/data/looks";
import {
  MOMO_MODEL_CATALOG,
  normalizeReasoningEffort,
  resolveModelMeta,
  type ReasoningEffort,
} from "@/lib/modelCatalog";
import {
  contrastInkOn,
  decideRoleTurn,
  type RoleDecision,
  hexToRgba,
  inferLookByKeyword,
  inferMoodByInput,
  mixHex,
  resolvePaletteTuple,
  stripMarkdownAndCites,
} from "@/lib/localBrain";
import {
  dedupeConsecutiveParagraphs,
  serializeMessageForHistory,
} from "@/lib/genUiStreamParser";
import {
  extractSessionBoardState,
  getRoleLens,
  getRoleWorkspaceConfig,
} from "@/lib/roleWorkspaceRegistry";
import { extractMistlineBoardDrafts } from "@/lib/mistlineCatalog";
import { recordVerifiedImageUrls, repairImageUrlsInText } from "@/lib/verifiedImagePool";
import type { WriteProposalCard } from "@/lib/famhub/proposalCard";
import { planMistlineSpreads } from "@/components/genui/MistlineSpreads";
import { BlinkingSquares } from "@/components/ambient/BlinkingSquares";
import {
  BoardItemStateContext,
  boardStickerStateOf,
  boardTitleKey,
  type BoardItemStickerState,
} from "@/components/genui/BoardSticker";
import { parseMixedStreamToMistlineBlocks } from "@/lib/openui/streamParser";
import type { ComposerSnapshot } from "@/runtime/composerBridge";
import type {
  BotIdentity,
  BrainSseEvent,
  ChatMessage,
  ChatSession,
  ComposerAttachment,
  GenUiPart,
  LookId,
  MessagePart,
  MoodId,
  UiInteractionPayload,
  WorkspaceBoardItem,
  WorkspaceViewId,
} from "@/types/momo";
import {
  BotFormPopover,
  BotMenuPopover,
  ProfileMenuPopover,
} from "./BotPopovers";
import { ExploreWorkspaceView } from "./ExploreWorkspaceView";
import { MainChevronBackdrop } from "./MainChevronBackdrop";
import { MessageThread } from "./MessageThread";
import { RoleBoardWorkspaceView } from "./RoleBoardWorkspaceView";

const DEFAULT_BOT: BotIdentity = {
  id: "momo",
  look: "rest",
  name: "Momo",
  job: LOOK_JOBS.rest || "Berganti kostum sesuai tugas",
};

const STORAGE_BOTS_KEY = "momo.bots";
const STORAGE_THEME_KEY = "momo.theme";
const STORAGE_SESSIONS_KEY = "momo.sessions.v1";
const STORAGE_ACTIVE_SESSION_KEY = "momo.activeSession.v1";
const EMPTY_BOTS: BotIdentity[] = [];

type SidePhase = "open" | "closing" | "closed" | "railOut";

// Reduced motion keeps every target value (so server and client markup match) and drops the timing.
const instant = (variants: Variants): Variants =>
  Object.fromEntries(
    Object.entries(variants).map(([label, target]) => [
      label,
      { ...(target as object), transition: { duration: 0 } },
    ]),
  );

// The drawer and the rail hand over in sequence: one finishes leaving before the other enters.
const SIDE_SLIDE = { duration: 0.28, ease: EASE_MOMO };
const SIDE_PANEL_VARIANTS = {
  open: { x: "0%", transition: { ...SIDE_SLIDE, delayChildren: 0.1, staggerChildren: 0.045 } },
  collapsed: { x: "-100%", transition: { ...SIDE_SLIDE, delay: 0.08, staggerChildren: 0.025 } },
};
const SIDE_PART_VARIANTS = {
  open: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.2, ease: EASE_MOMO } },
  collapsed: { opacity: 0, x: -8, filter: "blur(3px)", transition: { duration: 0.1, ease: EASE_EXIT } },
};
// The scrolling list skips the blur so it never keeps a filter layer while idle.
const SIDE_LIST_VARIANTS = {
  open: { opacity: 1, x: 0, transition: { duration: 0.2, ease: EASE_MOMO } },
  collapsed: { opacity: 0, x: -8, transition: { duration: 0.1, ease: EASE_EXIT } },
};
const RAIL_VARIANTS = {
  out: { opacity: 0, x: -28, transition: { duration: 0.11, ease: EASE_EXIT } },
  in: {
    opacity: 1,
    x: 0,
    transition: { type: "spring" as const, stiffness: 420, damping: 26, delayChildren: 0.04, staggerChildren: 0.04 },
  },
};
const RAIL_BTN_VARIANTS = {
  out: { opacity: 0, scale: 0.8, transition: { duration: 0.08 } },
  in: { opacity: 1, scale: 1, transition: { duration: 0.18, ease: EASE_MOMO } },
};

const SIDE_PANEL_REDUCED = instant(SIDE_PANEL_VARIANTS);
const SIDE_PART_REDUCED = instant(SIDE_PART_VARIANTS);
const SIDE_LIST_REDUCED = instant(SIDE_LIST_VARIANTS);
const RAIL_REDUCED = instant(RAIL_VARIANTS);
const RAIL_BTN_REDUCED = instant(RAIL_BTN_VARIANTS);

const SESSION_ACTIONS_GROUP_VARIANTS = {
  visible: { transition: { staggerChildren: 0.035 } },
  hidden: { transition: { staggerChildren: 0.022, staggerDirection: -1 } },
};

const SESSION_ACTION_BTN_VARIANTS = {
  visible: {
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
    transition: { duration: 0.22, ease: EASE_MOMO },
  },
  hidden: {
    opacity: 0,
    x: 4,
    filter: "blur(2px)",
    transition: { duration: 0.13, ease: EASE_EXIT },
  },
};

const SESSION_ACTION_REDUCED = instant(SESSION_ACTION_BTN_VARIANTS);

interface SessionRowActionsProps {
  visible: boolean;
  isEditing: boolean;
  compact?: boolean;
  session: ChatSession;
  editingTitleDraft: string;
  onStartRename: (session: ChatSession) => void;
  onCommitRename: (sessionId: string, rawTitle: string) => void;
  onCancelRename: () => void;
  onDelete: (sessionId: string) => void;
}

/**
 * Shared overlay slide-in actions tray (Rename / Delete or Save / Cancel) anchored on the right edge
 * so flex title layout width stays constant during hover enter & exit.
 */
const SessionRowActions: React.FC<SessionRowActionsProps> = ({
  visible,
  isEditing,
  compact = false,
  session,
  editingTitleDraft,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}) => {
  const iconSize = 12;
  const reduced = useReducedMotion();
  const variants = reduced ? SESSION_ACTION_REDUCED : SESSION_ACTION_BTN_VARIANTS;
  return (
    <motion.div
      className={`momo-session-actions${compact ? " is-compact" : ""}`}
      inert={!visible}
      style={{ pointerEvents: visible ? "auto" : "none" }}
      variants={reduced ? undefined : SESSION_ACTIONS_GROUP_VARIANTS}
      initial={false}
      animate={visible ? "visible" : "hidden"}
      onClick={(e) => e.stopPropagation()}
    >
      {isEditing ? (
        <>
          <motion.button
            type="button"
            data-session-action="save-rename"
            aria-label="Simpan nama"
            title="Simpan"
            className="momo-session-act-btn is-save"
            variants={variants}
            whileTap={reduced ? undefined : { scale: 0.94 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommitRename(session.id, editingTitleDraft)}
          >
            <Check size={iconSize} strokeWidth={2} />
          </motion.button>
          <motion.button
            type="button"
            data-session-action="cancel-rename"
            aria-label="Batal ubah nama"
            title="Batal"
            className="momo-session-act-btn"
            variants={variants}
            whileTap={reduced ? undefined : { scale: 0.94 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancelRename}
          >
            <X size={iconSize} strokeWidth={2} />
          </motion.button>
        </>
      ) : (
        <>
          <motion.button
            type="button"
            data-session-action="rename"
            aria-label={`Ubah nama ${session.title}`}
            title="Ubah nama"
            className="momo-session-act-btn"
            variants={variants}
            whileTap={reduced ? undefined : { scale: 0.94 }}
            onClick={(e) => {
              e.stopPropagation();
              onStartRename(session);
            }}
          >
            <Pencil size={iconSize} strokeWidth={2} />
          </motion.button>
          <motion.button
            type="button"
            data-session-action="delete"
            aria-label={`Hapus ${session.title}`}
            title="Hapus"
            className="momo-session-act-btn is-danger"
            variants={variants}
            whileTap={reduced ? undefined : { scale: 0.94 }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session.id);
            }}
          >
            <Trash2 size={iconSize} strokeWidth={2} />
          </motion.button>
        </>
      )}
    </motion.div>
  );
};

const themeListeners = new Set<() => void>();
function emitThemeChange() {
  themeListeners.forEach((fn) => fn());
}

function getDarkSnapshot(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.theme === "dark";
}

function getDarkServerSnapshot(): boolean {
  return false;
}

function subscribeTheme(onStoreChange: () => void): () => void {
  themeListeners.add(onStoreChange);
  if (typeof window === "undefined") {
    return () => {
      themeListeners.delete(onStoreChange);
    };
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handleOsThemeChange = () => {
    try {
      const stored = localStorage.getItem(STORAGE_THEME_KEY);
      if (stored === "dark" || stored === "light") return;
    } catch {
      // ignore
    }
    const resolved = mq.matches ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.setAttribute("content", resolved === "dark" ? "#111113" : "#f8f8f9");
    });
    emitThemeChange();
  };
  const handleStorageChange = (ev: StorageEvent) => {
    if (ev.key !== STORAGE_THEME_KEY) return;
    if (ev.newValue === "dark" || ev.newValue === "light") {
      document.documentElement.dataset.theme = ev.newValue;
      document.documentElement.style.colorScheme = ev.newValue;
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
        m.setAttribute(
          "content",
          ev.newValue === "dark" ? "#111113" : "#f8f8f9",
        );
      });
      emitThemeChange();
    }
  };
  mq.addEventListener("change", handleOsThemeChange);
  window.addEventListener("storage", handleStorageChange);
  return () => {
    themeListeners.delete(onStoreChange);
    mq.removeEventListener("change", handleOsThemeChange);
    window.removeEventListener("storage", handleStorageChange);
  };
}

const GREETING_BY_DAY_TIME: Record<number, [string, string, string, string]> = {
  0: [
    "Minggu pagi, slow morning?",
    "Minggu siang, makan siang dulu yuk",
    "Minggu sore, besok Senin lagi...",
    "Minggu malam, fresh week ahead",
  ],
  1: [
    "Senin pagi, fresh start atau begadang merembet?",
    "Senin siang, separuhnya udah beres",
    "Senin sore, tinggal besok aja",
    "Senin malam, besok mulai lagi dari nol",
  ],
  2: [
    "Selasa pagi, momentum masih panas",
    "Selasa siang, keep the streak",
    "Selasa sore, jangan begadang ya",
    "Selasa malam, persiapan Rabu yuk",
  ],
  3: [
    "Rabu pagi, hump day confirmed",
    "Rabu siang, literally the middle",
    "Rabu sore, tinggal 2 hari",
    "Rabu malam, finish week mode?",
  ],
  4: [
    "Kamis pagi, besok jumat!",
    "Kamis siang, push dikit lagi",
    "Kamis sore, weekend approaching",
    "Kamis malam, almost there",
  ],
  5: [
    "Jumat pagi, besok libur!",
    "Jumat siang, kerja setengah hati boleh",
    "Jumat sore, kabur duluan yuk",
    "Jumat malam, weekend officially",
  ],
  6: [
    "Sabtu pagi, sleep in was worth it",
    "Sabtu siang, santai atau produktif?",
    "Sabtu sore, weekend masih panjang",
    "Sabtu malam, recharge buat Senin",
  ],
};

function heroGreeting(): string {
  const now = new Date();
  const h = now.getHours();
  const slot = h < 11 ? 0 : h < 15 ? 1 : h < 19 ? 2 : 3;
  return GREETING_BY_DAY_TIME[now.getDay()][slot];
}

const noopSubscribe = () => () => {};
function getSpeechServerSnapshot(): boolean {
  return false;
}

const customBotsListeners = new Set<() => void>();
let cachedBotsRaw: string | null | undefined;
let cachedBotsValue: BotIdentity[] = EMPTY_BOTS;

function emitCustomBotsChange() {
  customBotsListeners.forEach((fn) => fn());
}

function getCustomBotsSnapshot(): BotIdentity[] {
  if (typeof window === "undefined") return EMPTY_BOTS;
  try {
    const raw = localStorage.getItem(STORAGE_BOTS_KEY);
    if (raw === cachedBotsRaw) return cachedBotsValue;
    cachedBotsRaw = raw;
    if (!raw) {
      cachedBotsValue = EMPTY_BOTS;
      return cachedBotsValue;
    }
    const parsed = JSON.parse(raw);
    cachedBotsValue = Array.isArray(parsed)
      ? (parsed as BotIdentity[])
      : EMPTY_BOTS;
    return cachedBotsValue;
  } catch {
    cachedBotsValue = EMPTY_BOTS;
    return cachedBotsValue;
  }
}

function getCustomBotsServerSnapshot(): BotIdentity[] {
  return EMPTY_BOTS;
}

function subscribeCustomBots(onStoreChange: () => void): () => void {
  customBotsListeners.add(onStoreChange);
  if (typeof window === "undefined") {
    return () => {
      customBotsListeners.delete(onStoreChange);
    };
  }
  const handleStorage = (ev: StorageEvent) => {
    if (ev.key === STORAGE_BOTS_KEY) {
      cachedBotsRaw = undefined;
      emitCustomBotsChange();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    customBotsListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeCustomBots(next: BotIdentity[]) {
  const serialized = JSON.stringify(next);
  cachedBotsRaw = serialized;
  cachedBotsValue = next;
  try {
    localStorage.setItem(STORAGE_BOTS_KEY, serialized);
  } catch {
    // ignore
  }
  emitCustomBotsChange();
}

interface SpeechRecResultLike {
  isFinal?: boolean;
  length: number;
  [idx: number]: { transcript: string } | undefined;
}

interface SpeechRecLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  processLocally?: boolean;
  maxAlternatives?: number;
  onresult: ((ev: { results: ArrayLike<SpeechRecResultLike> }) => void) | null;
  onerror: ((ev?: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecLike;
    webkitSpeechRecognition?: new () => SpeechRecLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function getSpeechSnapshot(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

function joinTextParts(parts: MessagePart[]): string {
  const joined = parts
    .filter(
      (p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text",
    )
    .map((p) => p.text)
    .join("\n\n");
  return dedupeConsecutiveParagraphs(joined);
}

const MODEL_PREF_KEY = "momo.model.v1";
const EFFORT_PREF_KEY = "momo.reasoningEffort.v1";

function persistModelPrefs(modelId: string, effort: ReasoningEffort) {
  try {
    localStorage.setItem(MODEL_PREF_KEY, modelId);
    localStorage.setItem(EFFORT_PREF_KEY, effort);
  } catch {}
}

function reduceBotMessageWithSse(
  msg: ChatMessage,
  ev: BrainSseEvent,
): ChatMessage {
  const curParts: MessagePart[] = msg.parts ? [...msg.parts] : [];

  switch (ev.type) {
    case "turn_meta":
      return {
        ...msg,
        look: ev.look,
        ...(ev.previousLook && ev.look && ev.look !== ev.previousLook
          ? { previousLook: ev.previousLook }
          : {}),
        botLabel: ev.botLabel || msg.botLabel,
        ...(typeof ev.hasNativeReasoning === "boolean"
          ? { hasNativeReasoning: ev.hasNativeReasoning }
          : {}),
        ...(typeof ev.modelHasReasoning === "boolean"
          ? { modelHasReasoning: ev.modelHasReasoning }
          : {}),
        ...(ev.modelId ? { activeModelId: ev.modelId } : {}),
        ...(ev.reasoningEffort
          ? { reasoningEffortUsed: ev.reasoningEffort }
          : {}),
        ...(ev.uiPlanMeta ? { uiPlanMeta: ev.uiPlanMeta } : {}),
      };

    case "activity_update":
      return {
        ...msg,
        activityLabel: ev.label,
      };

    case "reasoning_delta":
      return {
        ...msg,
        reasoningText: `${msg.reasoningText || ""}${ev.delta}`,
        reasoningStreaming: true,
        hasNativeReasoning: true,
        tokenCount: ev.tokenCount ?? msg.tokenCount,
      };

    case "telemetry_update":
      return {
        ...msg,
        tokenCount: ev.tokenCount,
        elapsedSec: ev.elapsedSec,
        ...(typeof ev.promptTokens === "number"
          ? { promptTokens: ev.promptTokens }
          : {}),
        ...(typeof ev.completionTokens === "number"
          ? { completionTokens: ev.completionTokens }
          : {}),
        ...(typeof ev.reasoningTokens === "number"
          ? { reasoningTokens: ev.reasoningTokens }
          : {}),
        ...(typeof ev.cachedTokens === "number"
          ? { cachedTokens: ev.cachedTokens }
          : {}),
      };

    case "part_start": {
      curParts.push({
        id: ev.partId,
        kind: "text",
        text: "",
        streaming: true,
      });
      return { ...msg, parts: curParts };
    }

    case "text_delta": {
      const nextParts = curParts.map((p) =>
        p.id === ev.partId && p.kind === "text"
          ? { ...p, text: p.text + ev.delta }
          : p,
      );
      return {
        ...msg,
        parts: nextParts,
        text: joinTextParts(nextParts),
      };
    }

    case "part_discard": {
      const nextParts = curParts.filter((p) => p.id !== ev.partId);
      return {
        ...msg,
        parts: nextParts,
        text: joinTextParts(nextParts),
      };
    }

    case "sources_update": {
      return {
        ...msg,
        sources: ev.sources,
      };
    }

    case "write_proposal": {
      const existing = msg.writeProposals ?? [];
      if (existing.some((c) => c.id === ev.id)) return msg;
      return {
        ...msg,
        writeProposals: [
          ...existing,
          { id: ev.id, title: ev.title, rows: ev.rows, expiresAt: ev.expiresAt, status: "pending" },
        ],
      };
    }

    case "tool_start": {
      curParts.push({
        id: ev.toolCallId,
        kind: "tool",
        toolCallId: ev.toolCallId,
        name: ev.name,
        label: ev.label || ev.name,
        argsPreview: ev.argsPreview,
        ...(ev.query ? { query: ev.query } : {}),
        ...(ev.provider ? { provider: ev.provider } : {}),
        startedAt: Date.now(),
        status: "running",
      });
      return { ...msg, parts: curParts };
    }

    case "tool_result": {
      const now = Date.now();
      const nextParts = curParts.map(
        (p): MessagePart =>
          p.kind === "tool" && p.toolCallId === ev.toolCallId
            ? {
                ...p,
                status: "done",
                summary: ev.summary || p.label || p.name,
                ...(ev.query ? { query: ev.query } : {}),
                ...(ev.providers && ev.providers.length > 0
                  ? { provider: ev.providers.join(" + ") }
                  : {}),
                ...(ev.domains ? { domains: ev.domains } : {}),
                ...(ev.resultsPreview
                  ? { resultsPreview: ev.resultsPreview }
                  : {}),
                ...(ev.imagePreviews
                  ? { imagePreviews: ev.imagePreviews }
                  : {}),
                elapsedMs:
                  ev.elapsedMs ??
                  (p.startedAt ? Math.max(120, now - p.startedAt) : 400),
              }
            : p,
      );
      return { ...msg, parts: nextParts };
    }

    case "part_end": {
      const nextParts = curParts.map(
        (p): MessagePart =>
          p.id === ev.partId && p.kind === "text"
            ? {
                ...p,
                text: dedupeConsecutiveParagraphs(p.text),
                streaming: false,
              }
            : p,
      );
      return { ...msg, parts: nextParts, text: joinTextParts(nextParts) };
    }

    case "turn_done": {
      const finalizedParts = curParts.map((p): MessagePart => {
        if (p.kind === "text") {
          return {
            ...p,
            text: repairImageUrlsInText(dedupeConsecutiveParagraphs(p.text)),
            streaming: false,
          };
        }
        if (p.kind === "tool") {
          return { ...p, status: "done" };
        }
        return p.status === "shell" || p.status === "building"
          ? { ...p, status: "ready" }
          : p;
      });
      return {
        ...msg,
        parts: finalizedParts,
        text: joinTextParts(finalizedParts),
        streaming: false,
        reasoningStreaming: false,
        tokenCount: ev.tokenCount ?? msg.tokenCount,
        ...(typeof ev.promptTokens === "number"
          ? { promptTokens: ev.promptTokens }
          : {}),
        ...(typeof ev.completionTokens === "number"
          ? { completionTokens: ev.completionTokens }
          : {}),
        ...(typeof ev.reasoningTokens === "number"
          ? { reasoningTokens: ev.reasoningTokens }
          : {}),
        ...(typeof ev.cachedTokens === "number"
          ? { cachedTokens: ev.cachedTokens }
          : {}),
        ...(ev.modelId ? { activeModelId: ev.modelId } : {}),
        elapsedSec:
          ev.elapsedSec ??
          msg.elapsedSec ??
          (msg.startedAt
            ? +Math.max(0.2, (Date.now() - msg.startedAt) / 1000).toFixed(1)
            : undefined),
        sources: ev.sources ?? msg.sources,
        truncated: ev.truncated || undefined,
        showActions: true,
      };
    }

    case "turn_error": {
      const errParts = curParts.map((p): MessagePart => {
        if (p.kind === "text") return { ...p, streaming: false };
        if (p.kind === "tool") return { ...p, status: "done" };
        return p.status === "shell" || p.status === "building"
          ? { ...p, status: "error", error: ev.message }
          : p;
      });
      const hasAnyText = joinTextParts(errParts).trim().length > 0;
      if (!hasAnyText) {
        errParts.push({
          id: `${msg.id}-err`,
          kind: "text",
          text: ev.message,
          streaming: false,
        });
      }
      return {
        ...msg,
        parts: errParts,
        text: joinTextParts(errParts),
        streaming: false,
        reasoningStreaming: false,
        showActions: true,
      };
    }

    default:
      return msg;
  }
}

function finalizeAbortedMessage(
  msg: ChatMessage,
  markStoppedText: boolean,
): ChatMessage {
  const nextParts: MessagePart[] = (msg.parts || []).map((p): MessagePart => {
    if (p.kind === "text") return { ...p, streaming: false };
    if (p.kind === "tool") return { ...p, status: "done" };
    if (p.status === "shell" || p.status === "building") {
      return { ...p, status: "aborted" } satisfies GenUiPart;
    }
    return p;
  });
  const baseText = joinTextParts(nextParts) || msg.text;
  const finalText = markStoppedText
    ? baseText
      ? `${baseText}...`
      : "Dihentikan."
    : baseText;
  const hasTextPart = nextParts.some((p) => p.kind === "text");
  if (markStoppedText && !hasTextPart) {
    nextParts.push({
      id: `${msg.id}-stopped`,
      kind: "text",
      text: finalText,
      streaming: false,
    });
  }
  return {
    ...msg,
    parts: nextParts,
    text: finalText,
    streaming: false,
    reasoningStreaming: false,
    showActions: msg.role === "momo" ? true : markStoppedText ? true : msg.showActions,
  };
}

function sanitizeStoredMessage(m: ChatMessage): ChatMessage {
  const settled = m.streaming ? finalizeAbortedMessage(m, false) : m;
  const withActions =
    settled.role === "momo" && !settled.streaming
      ? { ...settled, showActions: true }
      : settled;
  if (!withActions.attachments?.length) return withActions;
  return {
    ...withActions,
    attachments: withActions.attachments.map((a) => ({
      ...a,
      imageDataUrl: undefined,
      previewUrl: undefined,
    })),
  };
}

function sanitizeSessionForStorage(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: (session.messages ?? []).map(sanitizeStoredMessage),
    ...(session.exploreMessages
      ? { exploreMessages: session.exploreMessages.map(sanitizeStoredMessage) }
      : {}),
  };
}

function archiveAndRestoreSessionBoard(
  s: ChatSession,
  nextLook: string,
  prevLook?: string | null,
): ChatSession {
  const from = (prevLook ?? s.look ?? "").trim();
  if (!from || from === nextLook) {
    return { ...s, look: nextLook };
  }
  const boards = { ...(s.boardsByLook || {}) };
  if (s.boardColumns && s.boardColumns.length > 0) {
    boards[from] = { columns: s.boardColumns, items: s.boardItems ?? [] };
  }
  const restored = boards[nextLook];
  const next: ChatSession = { ...s, look: nextLook, boardsByLook: boards };
  if (restored) {
    next.boardColumns = restored.columns;
    next.boardItems = restored.items;
  } else {
    delete next.boardColumns;
    delete next.boardItems;
  }
  return next;
}

const SESSION_IMAGE_URL_RE = /https?:\/\/[^\s"'<>\\)]+/g;
const SESSION_IMAGEISH_RE =
  /\.(jpe?g|png|webp|gif|avif)(\?|#|$)|\/(image|img|media|upload|cover|photo|asset)/i;

function backfillVerifiedImageUrls(sessions: ChatSession[]): void {
  const urls: string[] = [];
  const scan = (blob: unknown) => {
    if (typeof blob !== "string" || !blob) return;
    for (const m of blob.matchAll(SESSION_IMAGE_URL_RE)) {
      const u = m[0];
      if (SESSION_IMAGEISH_RE.test(u)) urls.push(u);
    }
  };
  for (const s of sessions) {
    for (const msg of [...(s.messages ?? []), ...(s.exploreMessages ?? [])]) {
      if (msg.imagePool) {
        urls.push(...msg.imagePool);
        continue;
      }
      // Turns saved before `imagePool` existed carry no record of what was verified.
      scan(msg.text);
      if (msg.parts?.length) scan(JSON.stringify(msg.parts));
    }
    const boardItems = [
      ...(s.boardItems ?? []),
      ...(s.pinnedItems ?? []),
      ...Object.values(s.boardsByLook ?? {}).flatMap((b) => b.items ?? []),
    ];
    for (const it of boardItems) {
      if (it.imageUrl) urls.push(it.imageUrl);
    }
  }
  if (urls.length > 0) recordVerifiedImageUrls(urls);
}

function sessionKindOf(s: ChatSession): "chat" | "explore" {
  if ((s.messages?.length ?? 0) > 0) return "chat";
  if ((s.exploreMessages?.length ?? 0) > 0) return "explore";
  return "chat";
}

function extractMaxNumericSeq(list: ChatSession[]): number {
  let maxId = 0;
  const check = (val?: string) => {
    if (!val) return;
    const match = /-(\d+)$/.exec(val);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
  };
  for (const s of list) {
    check(s.id);
    for (const m of s.messages ?? []) {
      check(m.id);
      for (const p of m.parts ?? []) check(p.id);
    }
    for (const m of s.exploreMessages ?? []) {
      check(m.id);
      for (const p of m.parts ?? []) check(p.id);
    }
    for (const b of s.boardItems ?? []) check(b.id);
    for (const p of s.pinnedItems ?? []) check(p.id);
  }
  return maxId;
}

export const MomoAppShell: React.FC = () => {
  const dark = useSyncExternalStore(
    subscribeTheme,
    getDarkSnapshot,
    getDarkServerSnapshot,
  );
  const speechSupported = useSyncExternalStore(
    noopSubscribe,
    getSpeechSnapshot,
    getSpeechServerSnapshot,
  );
  const customBots = useSyncExternalStore(
    subscribeCustomBots,
    getCustomBotsSnapshot,
    getCustomBotsServerSnapshot,
  );
  const [activeBotId, setActiveBotId] = useState<string>("momo");
  const [activeLook, setActiveLook] = useState<string>("rest");
  const [mood, setMood] = useState<MoodId>("neutral");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [paletteOverrides] = useState<Record<string, string>>({});

  const [inputValue, setInputValue] = useState("");
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const [dictateError, setDictateError] = useState<string | null>(null);
  const [sentSeq, setSentSeq] = useState(0);
  const [forcedEditRequest, setForcedEditRequest] = useState<{
    msgId: string;
    seq: number;
  } | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceViewId>("chat");
  const [viewDir, setViewDir] = useState<1 | -1>(1);
  const hydrationSafeGreeting = useSyncExternalStore(
    noopSubscribe,
    heroGreeting,
    () => "Hai, mau kerjain apa?",
  );
  const [concaveDockSize, setConcaveDockSize] = useState({ w: 288, h: 36 });
  const [dockScope, animateDock] = useAnimate();
  const [, animateSide] = useAnimate();
  const [crestHovered, setCrestHovered] = useState(false);
  const crestCloseTimerRef = useRef<number | null>(null);
  const workspaceViewRef = useRef<WorkspaceViewId>(workspaceView);
  workspaceViewRef.current = workspaceView;
  const workspaceTabsCallbackRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const syncSize = () => {
      const r = el.getBoundingClientRect();
      const w = Math.ceil(r.width);
      const h = Math.ceil(r.height);
      if (w > 0 && h > 0) {
        setConcaveDockSize((prev) =>
          prev.w === w && prev.h === h ? prev : { w, h },
        );
      }
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef<ChatSession[]>([]);
  sessionsRef.current = sessions;
  const speechSeqRef = useRef(0);

  const [sideOpen, setSideOpen] = useState(false);
  const [sidePhase, setSidePhase] = useState<SidePhase>("open");
  const sideHidden = sidePhase !== "open";
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 720,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Mobile drawer is governed by sideOpen alone — never by the desktop rail phase.
  const sideFocusRef = useRef(false);
  const [railHistoryOpen, setRailHistoryOpen] = useState(false);
  const [railSearch, setRailSearch] = useState("");
  const [exploreFocus, setExploreFocus] = useState<{ idx: number; seq: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  const sidePartVariants = reduceMotion ? SIDE_PART_REDUCED : SIDE_PART_VARIANTS;
  const railBtnVariants = reduceMotion ? RAIL_BTN_REDUCED : RAIL_BTN_VARIANTS;
  const [hoveredSessionKey, setHoveredSessionKey] = useState<string | null>(
    null,
  );
  const [editingSessionKey, setEditingSessionKey] = useState<{
    surface: "side" | "rail";
    id: string;
  } | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState("");
  const renameCancelGuardRef = useRef(false);
  const [skeuoCtxMenu, setSkeuoCtxMenu] = useState<{
    x: number;
    y: number;
    kind: "dock" | "session";
    sessionId?: string;
    surface?: "side" | "rail";
  } | null>(null);

  useEffect(() => {
    if (!railHistoryOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest("[data-skeuo-ctx-menu='true']")) return;
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setRailHistoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailHistoryOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [railHistoryOpen]);

  useEffect(() => {
    if (!skeuoCtxMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest("[data-skeuo-ctx-menu='true']")) return;
      setSkeuoCtxMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSkeuoCtxMenu(null);
    };
    const onDismiss = () => setSkeuoCtxMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onDismiss);
    };
  }, [skeuoCtxMenu]);
  const [selectedModelId, setSelectedModelId] = useState<string>(
    MOMO_MODEL_CATALOG[0].id,
  );
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("off");
  const selectedModelRef = useRef(selectedModelId);
  selectedModelRef.current = selectedModelId;
  const reasoningEffortRef = useRef<ReasoningEffort>(reasoningEffort);
  reasoningEffortRef.current = reasoningEffort;

  useEffect(() => {
    try {
      const storedModel = localStorage.getItem(MODEL_PREF_KEY);
      const storedEffort = localStorage.getItem(EFFORT_PREF_KEY) as ReasoningEffort | null;
      const modelId =
        storedModel && MOMO_MODEL_CATALOG.some((m) => m.id === storedModel)
          ? storedModel
          : selectedModelRef.current;
      const effort = normalizeReasoningEffort(
        resolveModelMeta(modelId),
        storedEffort ?? reasoningEffortRef.current,
      );
      selectedModelRef.current = modelId;
      reasoningEffortRef.current = effort;
      setSelectedModelId(modelId);
      setReasoningEffort(effort);
    } catch {}
  }, []);
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [botFormOpen, setBotFormOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  useEffect(() => {
    if (!sideOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSideOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sideOpen]);

  // Mobile drawer slide is motion-owned; the CSS transform only hides the
  // panel pre-hydration, so the spring takes over without a flash.
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    if (!isMobile) {
      el.style.removeProperty("transform");
      return;
    }
    const controls = animateSide(
      el,
      { x: sideOpen ? "0%" : "-105%" },
      reduceMotion
        ? { duration: 0 }
        : { type: "spring", stiffness: 400, damping: 38 },
    );
    return () => controls.stop();
  }, [animateSide, isMobile, sideOpen, reduceMotion]);

  const heroCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const slotBigRef = useRef<HTMLDivElement | null>(null);
  const slotPerchRef = useRef<HTMLDivElement | null>(null);
  const slotExploreRef = useRef<HTMLDivElement | null>(null);
  const slotInputLeftRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const botPickBtnRef = useRef<HTMLButtonElement | null>(null);
  const profileBtnRef = useRef<HTMLButtonElement | null>(null);

  const runAbortRef = useRef<AbortController | null>(null);
  const speechRecRef = useRef<SpeechRecLike | null>(null);
  const dictatingRef = useRef(false);
  dictatingRef.current = dictating;
  const dictateBaseTextRef = useRef("");
  const dictateMediaStreamRef = useRef<MediaStream | null>(null);
  const dictateAudioCtxRef = useRef<AudioContext | null>(null);
  const dictateVoiceRafRef = useRef<number>(0);
  const dictateSessionIdRef = useRef<number>(0);
  const dictateErrTimerRef = useRef<number | null>(null);
  const boardPrevLookRef = useRef<string | null>(null);
  const nextMsgSeq = useRef(1);
  const sessionsHydratedRef = useRef(false);
  const persistedSessionsRef = useRef<ChatSession[] | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SESSIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed
            .filter(
              (s): s is ChatSession =>
                Boolean(s) && typeof s === "object" && typeof s.id === "string",
            )
            .map(sanitizeSessionForStorage);
          if (valid.length > 0 && sessionsRef.current.length === 0) {
            const maxSeq = extractMaxNumericSeq(valid);
            if (maxSeq >= nextMsgSeq.current) {
              nextMsgSeq.current = maxSeq + 1;
            }
            setSessions(valid);
            backfillVerifiedImageUrls(valid);
            const savedActiveId = localStorage.getItem(
              STORAGE_ACTIVE_SESSION_KEY,
            );
            if (savedActiveId && valid.some((s) => s.id === savedActiveId)) {
              setActiveSessionId(savedActiveId);
              const matched = valid.find((s) => s.id === savedActiveId);
              if (matched?.pinnedBotId) {
                setActiveBotId(matched.pinnedBotId);
              }
              if (matched?.look) {
                setActiveLook(matched.look);
              }
              if (matched && sessionKindOf(matched) === "explore") {
                setWorkspaceView("explore");
              }
            }
          }
        }
      }
    } catch {
      // ignore corrupted storage
    } finally {
      sessionsHydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!sessionsHydratedRef.current) return;
    const persist = () => {
      try {
        if (persistedSessionsRef.current !== sessions) {
          const payload = sessions.slice(0, 20).map(sanitizeSessionForStorage);
          localStorage.setItem(STORAGE_SESSIONS_KEY, JSON.stringify(payload));
          persistedSessionsRef.current = sessions;
        }
        if (activeSessionId) {
          localStorage.setItem(STORAGE_ACTIVE_SESSION_KEY, activeSessionId);
        } else {
          localStorage.removeItem(STORAGE_ACTIVE_SESSION_KEY);
        }
      } catch {
        try {
          const compact = sessions.slice(0, 6).map(sanitizeSessionForStorage);
          localStorage.setItem(STORAGE_SESSIONS_KEY, JSON.stringify(compact));
        } catch {
          // ignore storage quota overflow
        }
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    const timer = busy ? undefined : window.setTimeout(persist, 150);
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sessions, activeSessionId, busy]);

  const stopDictationCleanup = useCallback((opts?: { abort?: boolean }) => {
    dictateSessionIdRef.current += 1;
    const rec = speechRecRef.current;
    speechRecRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (opts?.abort && rec.abort) {
          rec.abort();
        } else {
          rec.stop();
        }
      } catch {
        try {
          rec.abort?.();
        } catch {
          // ignore
        }
      }
    }
    if (dictateVoiceRafRef.current) {
      cancelAnimationFrame(dictateVoiceRafRef.current);
      dictateVoiceRafRef.current = 0;
    }
    const stream = dictateMediaStreamRef.current;
    dictateMediaStreamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
    }
    const ctx = dictateAudioCtxRef.current;
    dictateAudioCtxRef.current = null;
    if (ctx) {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // ignore
      }
    }
    if (composerRef.current) {
      composerRef.current.style.removeProperty("--crest-voice-level");
    }
    dictatingRef.current = false;
    setDictating(false);
  }, []);

  useEffect(() => {
    return () => {
      stopDictationCleanup({ abort: true });
      if (dictateErrTimerRef.current !== null) {
        window.clearTimeout(dictateErrTimerRef.current);
        dictateErrTimerRef.current = null;
      }
    };
  }, [stopDictationCleanup]);

  useEffect(() => {
    if (!dictating) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopDictationCleanup();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [dictating, stopDictationCleanup]);

  const makeId = (prefix: string) => `${prefix}-${nextMsgSeq.current++}`;

  const appMountRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    let raf2 = 0;
    let raf1 = 0;
    const armThemeReady = () => {
      if (document.documentElement.classList.contains("theme-ready")) return;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          document.documentElement.classList.add("theme-ready");
        });
      });
    };
    armThemeReady();
    const onVis = () => {
      if (document.visibilityState === "visible") armThemeReady();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, []);

  const allBots = useMemo(() => {
    const presetList: BotIdentity[] = Object.keys(LOOK_NAMES).map((look) => ({
      id: `preset:${look}`,
      look,
      name: LOOK_NAMES[look],
      job: LOOK_JOBS[look] || "",
    }));
    return [DEFAULT_BOT, ...customBots, ...presetList];
  }, [customBots]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const selectedBotId = activeSession ? activeSession.pinnedBotId ?? "momo" : activeBotId;
  const activeBot = allBots.find((b) => b.id === selectedBotId) ?? DEFAULT_BOT;

  const displayedMessages = activeSession ? activeSession.messages : [];
  const displayedExploreMessages = activeSession?.exploreMessages ?? [];
  const visibleSessions = useMemo(
    () =>
      sessions.filter((s) =>
        workspaceView === "explore"
          ? (s.exploreMessages?.length ?? 0) > 0
          : (s.messages?.length ?? 0) > 0 ||
            (s.exploreMessages?.length ?? 0) === 0,
      ),
    [sessions, workspaceView],
  );

  const started = displayedMessages.length > 0;
  const exploreStarted = displayedExploreMessages.length > 0;

  // Smart Chat Auto-Scroll: follow new AI tokens & GenUI blocks down when near bottom
  const lastChatMsg = displayedMessages[displayedMessages.length - 1];
  const lastChatSignature = `${displayedMessages.length}:${lastChatMsg?.text?.length ?? 0}:${lastChatMsg?.parts?.length ?? 0}:${lastChatMsg?.streaming ? 1 : 0}`;
  const scrollSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (workspaceView !== "chat") return;
    const switched = scrollSessionRef.current !== activeSessionId;
    scrollSessionRef.current = activeSessionId;
    if (switched && !lastChatMsg?.streaming) return;
    const el = threadRef.current;
    if (!el || displayedMessages.length === 0) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 260 || Boolean(lastChatMsg?.streaming)) {
      const raf = window.requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [
    activeSessionId,
    workspaceView,
    lastChatSignature,
    displayedMessages.length,
    lastChatMsg?.streaming,
  ]);
  // Each view decides for itself where the avatar sits: an empty Explore page keeps it in the
  // hero slot (top right) even when the session's Chat already has messages.
  const heroPerchStarted =
    workspaceView === "explore"
      ? exploreStarted
      : workspaceView === "board" || started;
  const backdropStarted = started || exploreStarted || workspaceView !== "chat";
  const crestAutoHide = started || exploreStarted;
  const crestCollapsed = crestAutoHide && !crestHovered;

  const openCrest = useCallback(() => {
    if (crestCloseTimerRef.current !== null) {
      window.clearTimeout(crestCloseTimerRef.current);
      crestCloseTimerRef.current = null;
    }
    setCrestHovered(true);
  }, []);

  const scheduleCloseCrest = useCallback(() => {
    if (crestCloseTimerRef.current !== null) {
      window.clearTimeout(crestCloseTimerRef.current);
    }
    crestCloseTimerRef.current = window.setTimeout(() => {
      crestCloseTimerRef.current = null;
      setCrestHovered(false);
    }, 220);
  }, []);

  useEffect(() => {
    return () => {
      if (crestCloseTimerRef.current !== null) {
        window.clearTimeout(crestCloseTimerRef.current);
      }
    };
  }, []);
  const roleConfig = useMemo(
    () => getRoleWorkspaceConfig(activeLook),
    [activeLook],
  );

  const exploreLatestContext = useMemo(() => {
    if (started || displayedExploreMessages.length === 0) return null;
    const lastUser = [...displayedExploreMessages]
      .reverse()
      .find((m) => m.role === "user" && m.text.trim().length > 0);
    if (!lastUser) return null;
    const fullQuery = lastUser.text.trim();
    const shortTopic =
      fullQuery.length > 38 ? `${fullQuery.slice(0, 38).trimEnd()}...` : fullQuery;
    const lastBot = [...displayedExploreMessages]
      .reverse()
      .find((m) => m.role === "momo" && m.text.trim().length > 0);
    let followups: string[] = [];
    if (lastBot) {
      const parsed = parseMixedStreamToMistlineBlocks(lastBot.text, {
        final: !lastBot.streaming,
      });
      followups = planMistlineSpreads(parsed)
        .followups.map((f) => f.trim())
        .filter((f) => f.length > 0);
    }
    return { fullQuery, shortTopic, followups };
  }, [started, displayedExploreMessages]);

  const exploreBridgeTopic = exploreLatestContext?.shortTopic ?? null;

  const contextualChatSuggestions = useMemo(() => {
    if (!exploreLatestContext) return roleConfig.chatHeroSuggestions;
    const { fullQuery, shortTopic, followups } = exploreLatestContext;
    const aiDerived = followups.slice(0, 2).map((f, idx) => ({
      tag: idx === 0 ? "Lanjut" : "Cabang",
      label: f.length > 44 ? `${f.slice(0, 44).trimEnd()}...` : f,
      prompt: f,
    }));
    const fallbacks = [
      {
        tag: "Bedah",
        label: `Bedah detail “${shortTopic}”`,
        prompt: `Bedah secara mendalam dan praktis soal "${fullQuery}": jelaskan mekanisme inti, risiko utama di lapangan, dan rekomendasi keputusan konkret.`,
      },
      {
        tag: "Banding",
        label: `Bandingkan opsi utama (${shortTopic})`,
        prompt: `Bandingkan pendekatan paling kuat untuk "${fullQuery}" lengkap dengan konsekuensi biaya, performa, dan batasannya.`,
      },
      {
        tag: "Pin",
        label: `Susun rencana ke ${roleConfig.boardLabel}`,
        prompt: `Rangkum keputusan utama soal "${fullQuery}" dan susun daftar aksi prioritas ke ${roleConfig.boardLabel}.`,
      },
    ];
    return [...aiDerived, ...fallbacks].slice(0, 3);
  }, [exploreLatestContext, roleConfig]);

  const pinnedTitles = useMemo(() => {
    const set = new Set<string>();
    for (const it of activeSession?.pinnedItems ?? []) {
      const k = it.title.trim().toLowerCase();
      if (k) set.add(k);
    }
    for (const it of activeSession?.boardItems ?? []) {
      if (it.pin === "heart" || it.sticker === "heart") {
        const k = it.title.trim().toLowerCase();
        if (k) set.add(k);
      }
    }
    return set;
  }, [activeSession?.pinnedItems, activeSession?.boardItems]);
  // Sticker/star/done state per board item title — session-scoped, feeds the
  // tilted sticker overlays on GenUI cards across chat and explore.
  const boardStickerStates = useMemo(() => {
    const map = new Map<string, BoardItemStickerState>();
    const merge = (items?: WorkspaceBoardItem[]) => {
      for (const it of items ?? []) {
        const st = boardStickerStateOf(it);
        if (!st) continue;
        const key = boardTitleKey(it.title);
        if (!key) continue;
        const prev = map.get(key);
        if (!prev) {
          map.set(key, st);
          continue;
        }
        map.set(key, {
          sticker:
            prev.sticker && prev.sticker !== "heart"
              ? prev.sticker
              : (st.sticker ?? prev.sticker),
          done: Boolean(prev.done || st.done),
        });
      }
    };
    merge(activeSession?.boardItems);
    merge(activeSession?.pinnedItems);
    return map;
  }, [activeSession?.pinnedItems, activeSession?.boardItems]);
  // A Pinboard belongs to its chat session. A new or empty session shows an empty board,
  // never another session's items.
  const sessionBoardState = useMemo(
    () => extractSessionBoardState(activeSession, activeLook),
    [activeSession, activeLook],
  );

  const accentTuple = useMemo(
    () =>
      offline
        ? ROLE_PALETTES.ash
        : resolvePaletteTuple(activeLook, paletteOverrides),
    [activeLook, paletteOverrides, offline],
  );

  const accentStyle = useMemo(() => {
    const [light, accent, shade, deep] = accentTuple;

    return {
      "--accent": accent,
      "--role-soft-l": mixHex("#f7f7f7", light, 0.45),
      "--role-ink-l": contrastInkOn(deep, "#efefef"),
      "--role-sel-l": mixHex("#f7f7f7", light, 0.52),
      "--role-soft-d": mixHex("#181a20", light, 0.2),
      "--role-ink-d": contrastInkOn(deep, "#0c0d10"),
      "--role-sel-d": mixHex("#181a20", light, 0.24),
      "--accent-light": light,
      "--accent-shade": shade,
      "--accent-line": hexToRgba(shade, 0.58),
    } as React.CSSProperties;
  }, [activeLook, paletteOverrides, offline]);

  const stage = useMomoStage(
    {
      heroCanvasRef,
      slotBigRef,
      slotPerchRef,
      slotExploreRef,
      slotInputLeftRef,
      composerRef,
    },
    {
      look: activeLook,
      mood,
      busy,
      offline,
      speaking: speakingMsgId !== null,
      started: heroPerchStarted,
      workspaceView,
      dark,
      paletteOverrides,
    },
  );
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const speakingMsgIdRef = useRef(speakingMsgId);
  speakingMsgIdRef.current = speakingMsgId;

  const threadCallbackRef = useCallback((el: HTMLDivElement | null) => {
    threadRef.current = el;
    return () => {
      if (threadRef.current === el) {
        threadRef.current = null;
      }
    };
  }, []);

  const dockCallbackRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const syncDockHeight = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0 && mainRef.current) {
        mainRef.current.style.setProperty("--dock-h", `${h}px`);
      }
    };
    syncDockHeight();
    const ro = new ResizeObserver(syncDockHeight);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const messagesScrollRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    let rafId = 0;
    const clampShortThread = () => {
      rafId = 0;
      const thread = threadRef.current;
      if (!thread) return;
      if (
        thread.scrollHeight <= thread.clientHeight + 4 &&
        thread.scrollTop !== 0
      ) {
        thread.scrollTop = 0;
      }
    };
    const scheduleSync = () => {
      if (!rafId) {
        rafId = requestAnimationFrame(clampShortThread);
      }
    };
    if (threadRef.current) {
      threadRef.current.scrollTop = 0;
    }
    scheduleSync();
    const ro = new ResizeObserver(scheduleSync);
    ro.observe(el);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const switchWorkspaceView = useCallback((nextView: WorkspaceViewId) => {
    const prevView = workspaceViewRef.current;
    if (prevView === nextView) return;
    const order: Record<WorkspaceViewId, number> = {
      explore: 0,
      chat: 1,
      board: 2,
    };
    setViewDir(order[nextView] >= order[prevView] ? 1 : -1);
    setWorkspaceView(nextView);
  }, []);

  const wipeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wipeRafRef = useRef(0);
  // Dot-matrix diagonal wipe: a traveling band of accent squares sweeps from
  // the theme-toggle corner (bottom-left) to top-right; the theme flips the
  // instant the wavefront covers the viewport center, so the reveal is the
  // wave itself — no per-element color tweens, no patchwork.
  const runThemeWipe = useCallback(
    (onMidpoint: () => void) => {
      const root = document.documentElement;
      if (root.classList.contains("theme-wiping")) {
        onMidpoint();
        return;
      }
      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => {
          ready: Promise<void>;
          finished: Promise<void>;
          skipTransition: () => void;
        };
      };
      const W = window.innerWidth;
      const H = window.innerHeight;
      const diag = W + H;
      // Progressive reveal: the new theme is literally wiped in through a
      // dot-matrix mask on ::view-transition-new, whose front follows the same
      // diagonal timing as the fallback canvas sweep.
      if (!reduceMotion && doc.startViewTransition) {
        try {
          const cell = 18;
          // Image slides straight up: mask-position 0 -wf. Screen w_s = x - y + H;
          // a pixel covers iff its u = ix - iy + MH <= over, i.e. w_s <= wf.
          const over = Math.ceil(diag * 1.3);
          const MW = W + cell * 4;
          const MH = H + over;
          const u0 = over;
          const uB0 = u0 - cell * 6;
          const uB1 = u0 + cell * 12;
          const mc = document.createElement("canvas");
          mc.width = MW;
          mc.height = MH;
          const mctx = mc.getContext("2d");
          if (!mctx) throw new Error("no 2d ctx");
          mctx.fillStyle = "#000";
          const jit = (x: number, y: number) => {
            const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
            return (h - Math.floor(h) - 0.5) * 0.14 * diag;
          };
          // No solid polygon at all — the diagonal is pure dot matrix: density
          // ramps 0→1 and dense-end dots overlap into solid. Deep cells get a
          // second guaranteed pass so coverage truly seals.
          const cols = Math.ceil(MW / cell);
          const rows = Math.ceil(MH / cell);
          for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
              const px0 = cx * cell + cell / 2;
              const py0 = cy * cell + cell / 2;
              const u = px0 - py0 + MH + jit(cx, cy);
              if (u > uB1) continue;
              const p = Math.min(1, Math.max(0, (uB1 - u) / (uB1 - uB0)));
              const h = Math.sin(cx * 269.5 + cy * 183.3) * 43758.5453;
              const rnd = h - Math.floor(h);
              const s2 = cell * (0.3 + Math.pow(p, 1.3) * 0.9);
              mctx.globalAlpha = Math.max(0, Math.min(1, 0.5 + p * 0.5));
              if (rnd <= p) {
                mctx.fillRect(px0 - s2 / 2, py0 - s2 / 2, s2, s2);
              }
              if (u < uB0) {
                mctx.globalAlpha = 1;
                mctx.fillRect(px0 - cell / 2, py0 - cell / 2, cell, cell);
              }
            }
          }
          mctx.globalAlpha = 1;
          const url = mc.toDataURL();
          const styleEl = document.createElement("style");
          styleEl.textContent = [
            "::view-transition-old(root),::view-transition-new(root){animation:none!important;mix-blend-mode:normal}",
            "::view-transition-group(root){animation:none!important}",
            "::view-transition-old(root){z-index:1}",
            "::view-transition-new(root){z-index:2}",
            `::view-transition-new(root){mask-image:url("${url}")!important;mask-repeat:no-repeat!important;mask-size:${MW}px ${MH}px!important;-webkit-mask-image:url("${url}")!important;-webkit-mask-repeat:no-repeat!important;-webkit-mask-size:${MW}px ${MH}px!important}`,
          ].join("\n");
          document.head.appendChild(styleEl);
          root.classList.add("theme-wiping");
          const vt = doc.startViewTransition(() => {
            onMidpoint();
          });
          const N = 28;
          vt.ready
            .then(() => {
              const frames = [];
              for (let i = 0; i <= N; i++) {
                const wf = (Math.min(1, i / N) * 1.55 - 0.45) * diag;
                frames.push({ maskPosition: `0px ${(-wf).toFixed(1)}px` });
              }
              root.animate(frames, {
                duration: 980,
                easing: "linear",
                fill: "forwards",
                pseudoElement: "::view-transition-new(root)",
              } as KeyframeAnimationOptions);
            })
            .catch(() => {});
          vt.finished
            .catch(() => {})
            .finally(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  root.classList.remove("theme-wiping");
                  styleEl.remove();
                });
              });
            });
          return;
        } catch {
          root.classList.remove("theme-wiping");
        }
      }
      const cv = wipeCanvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx || reduceMotion) {
        onMidpoint();
        return;
      }
      document.documentElement.classList.add("theme-wiping");
      const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
      cv.width = Math.round(W * ratio);
      cv.height = Math.round(H * ratio);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const cell = 18;
      const sq = cell * 0.52;
      const cols = Math.ceil(W / cell);
      const rows = Math.ceil(H / cell);
      const jit = (x: number, y: number) => {
        const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return (h - Math.floor(h) - 0.5) * 0.12;
      };
      const sqVar = (x: number, y: number) => {
        const h = Math.sin(x * 41.7 + y * 97.3) * 43758.5453;
        return sq * (0.66 + (h - Math.floor(h)) * 0.62);
      };
      const INK = "#141416";
      const PAPER = "#f6f6f8";
      const bw = (x: number, y: number) => {
        const h = Math.sin(x * 269.5 + y * 183.3) * 43758.5453;
        return h - Math.floor(h) < 0.5 ? INK : PAPER;
      };
      const DUR = 980;
      const t0 = performance.now();
      let flipped = false;
      cancelAnimationFrame(wipeRafRef.current);
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / DUR);
        const s = p * 1.55;
        ctx.clearRect(0, 0, W, H);
        for (let cy = 0; cy < rows; cy++) {
          for (let cx = 0; cx < cols; cx++) {
            const px = cx * cell + cell / 2;
            const py = cy * cell + cell / 2;
            const w = (px + (H - py)) / diag + jit(cx, cy);
            const ignite = Math.min(1, Math.max(0, (s - w) / 0.1));
            const out = Math.min(1, Math.max(0, (s - 0.5 - w) / 0.1));
            const a = ignite - out;
            if (a <= 0.02) continue;
            const s2 = sqVar(cx, cy) * Math.min(1, a * 1.4);
            ctx.fillStyle = bw(cx, cy);
            ctx.globalAlpha = a * 0.97;
            ctx.fillRect(px - s2 / 2, py - s2 / 2, s2, s2);
          }
        }
        ctx.globalAlpha = 1;
        if (!flipped && s > 0.62) {
          flipped = true;
          onMidpoint();
        }
        if (p < 1) {
          wipeRafRef.current = requestAnimationFrame(step);
        } else {
          ctx.clearRect(0, 0, W, H);
          document.documentElement.classList.remove("theme-wiping");
        }
      };
      wipeRafRef.current = requestAnimationFrame(step);
    },
    [reduceMotion],
  );
  useEffect(() => () => cancelAnimationFrame(wipeRafRef.current), []);

  const setThemeMode = useCallback(
    (nextDark: boolean) => {
      const root = document.documentElement;
      const wasDark = root.dataset.theme === "dark";
      const resolved = nextDark ? "dark" : "light";
      root.classList.add("theme-ready");
      const applyTheme = () => {
        root.dataset.theme = resolved;
        root.style.colorScheme = resolved;
        document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
          m.setAttribute("content", nextDark ? "#111113" : "#f8f8f9");
        });
        try {
          localStorage.setItem(STORAGE_THEME_KEY, resolved);
        } catch {
          // ignore storage errors
        }
        emitThemeChange();
      };
      if (wasDark !== nextDark) {
        stageRef.current.wakeFromIdle();
        stageRef.current.bumpSquash(-1.35);
        stageRef.current.triggerExpression("sparkle", 900);
        if (dockScope.current) {
          void animateDock(
            dockScope.current,
            { y: [0, 2.5, 0], scale: [1, 1.02, 1] },
            { duration: 0.34, ease: EASE_MOMO },
          );
        }
        runThemeWipe(applyTheme);
      } else {
        applyTheme();
      }
    },
    [animateDock, dockScope, runThemeWipe],
  );

  const stopSpeechSynthesis = useCallback(() => {
    speechSeqRef.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeakingMsgId(null);
  }, []);

  const speakText = useCallback((msgId: string, rawText: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const seq = ++speechSeqRef.current;
    window.speechSynthesis.cancel();
    const plain = stripMarkdownAndCites(rawText).trim();
    if (!plain) {
      setSpeakingMsgId(null);
      return;
    }
    const utter = new SpeechSynthesisUtterance(plain);
    utter.lang = "id-ID";
    utter.rate = 1.03;
    utter.onstart = () => {
      if (speechSeqRef.current !== seq) return;
      setSpeakingMsgId(msgId);
      stageRef.current.triggerExpression("speaking", 2400);
    };
    utter.onend = () => {
      if (speechSeqRef.current !== seq) return;
      setSpeakingMsgId(null);
    };
    utter.onerror = () => {
      if (speechSeqRef.current !== seq) return;
      setSpeakingMsgId(null);
    };
    setSpeakingMsgId(msgId);
    window.speechSynthesis.speak(utter);
  }, []);

  useEffect(() => {
    return () => {
      speechSeqRef.current += 1;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      speechRecRef.current?.stop();
    };
  }, []);

  const handleSpeakToggle = useCallback(
    (msg: ChatMessage) => {
      if (speakingMsgIdRef.current === msg.id) {
        stopSpeechSynthesis();
        return;
      }
      speakText(msg.id, msg.text);
    },
    [speakText, stopSpeechSynthesis],
  );

  const updateSessionMessages = useCallback(
    (
      sessionId: string,
      updater: (prev: ChatMessage[]) => ChatMessage[],
      nextLook?: string,
      targetChannel: "chat" | "explore" = "chat",
    ) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          if (targetChannel === "explore") {
            return {
              ...s,
              look: nextLook ?? s.look,
              exploreMessages: updater(s.exploreMessages ?? []),
            };
          }
          return {
            ...s,
            look: nextLook ?? s.look,
            messages: updater(s.messages),
          };
        }),
      );
    },
    [],
  );

  // The outcome of a FamHub proposal card (saved, cancelled, expired, failed) is kept on its turn,
  // so a reload shows the record instead of a card that could be pressed again.
  const handleWriteProposalChange = useCallback(
    (msgId: string, proposalId: string, patch: Pick<WriteProposalCard, "status" | "error">) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      updateSessionMessages(sid, (prev) =>
        prev.map((m) =>
          m.id === msgId && m.writeProposals
            ? {
                ...m,
                writeProposals: m.writeProposals.map((c) =>
                  c.id === proposalId ? { ...c, status: patch.status, error: patch.error } : c,
                ),
              }
            : m,
        ),
      );
    },
    [updateSessionMessages],
  );

  const handleTogglePinItem = useCallback(
    (rawItem: Omit<WorkspaceBoardItem, "id" | "columnId">) => {
      const cleanTitle = rawItem.title.trim();
      if (!cleanTitle) return;
      const key = cleanTitle.toLowerCase();
      const firstColId = roleConfig.boardDefaultColumns[0]?.id || "col-1";
      const existingSid = activeSessionIdRef.current;
      const newSid = existingSid ? null : makeId("ses");
      const newPinId = makeId("pin");

      if (newSid) {
        activeSessionIdRef.current = newSid;
        setActiveSessionId(newSid);
      }

      setSessions((prev) => {
        if (newSid) {
          return [
            {
              id: newSid,
              title: cleanTitle.slice(0, 42),
              look: activeLook,
              pinnedBotId: activeBot.id === "momo" ? undefined : activeBot.id,
              createdAt: Date.now(),
              messages: [],
              pinnedItems: [
                {
                  ...rawItem,
                  id: newPinId,
                  columnId: firstColId,
                  pin: "heart",
                  sticker: "heart",
                },
              ],
            },
            ...prev,
          ];
        }
        return prev.map((s) => {
          if (s.id !== existingSid) return s;
          const existingPinned = s.pinnedItems ?? [];
          const hasAlready = existingPinned.some(
            (p) => p.title.trim().toLowerCase() === key,
          );
          const nextPinned = hasAlready
            ? existingPinned.filter((p) => p.title.trim().toLowerCase() !== key)
            : [
                {
                  ...rawItem,
                  id: newPinId,
                  columnId: s.boardColumns?.[0]?.id || firstColId,
                  pin: "heart" as const,
                  sticker: "heart" as const,
                },
                ...existingPinned,
              ];
          return {
            ...s,
            pinnedItems: nextPinned,
          };
        });
      });
      stageRef.current.triggerExpression("happy", 650);
    },
    [activeBot.id, activeLook, roleConfig.boardDefaultColumns],
  );

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
    };
  }, []);

  const cancelOngoingTurn = useCallback(() => {
    stopDictationCleanup();
    if (!runAbortRef.current) return;
    runAbortRef.current.abort();
    runAbortRef.current = null;
    setSessions((prev) =>
      prev.map((s) =>
        s.messages.some((m) => m.streaming) ||
        (s.exploreMessages ?? []).some((m) => m.streaming)
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.streaming ? finalizeAbortedMessage(m, false) : m,
              ),
              ...(s.exploreMessages
                ? {
                    exploreMessages: s.exploreMessages.map((m) =>
                      m.streaming ? finalizeAbortedMessage(m, false) : m,
                    ),
                  }
                : {}),
            }
          : s,
      ),
    );
    setMiniAvatarStreamBusy(false);
    setBusy(false);
    stageRef.current.setFocusTarget(null);
  }, [stopDictationCleanup]);

  const handleStop = useCallback(() => {
    stopDictationCleanup();
    if (runAbortRef.current) {
      runAbortRef.current.abort();
      runAbortRef.current = null;
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.messages.some((m) => m.streaming) ||
        (s.exploreMessages ?? []).some((m) => m.streaming)
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.streaming ? finalizeAbortedMessage(m, true) : m,
              ),
              ...(s.exploreMessages
                ? {
                    exploreMessages: s.exploreMessages.map((m) =>
                      m.streaming ? finalizeAbortedMessage(m, true) : m,
                    ),
                  }
                : {}),
            }
          : s,
      ),
    );
    setMiniAvatarStreamBusy(false);
    setBusy(false);
    stageRef.current.setFocusTarget(null);
  }, [stopDictationCleanup]);

  const submitPrompt = useCallback(
    async (
      rawText: string,
      options?: {
        retryMsgId?: string;
        editUserMsgId?: string;
        attachments?: ComposerAttachment[];
        uiInteraction?: UiInteractionPayload;
        targetChannel?: "chat" | "explore";
        bypassRoleGate?: boolean;
        overrideBotId?: string;
        handoffFromRole?: string;
      },
    ) => {
      const effectiveWorkspaceView: WorkspaceViewId =
        options?.targetChannel ?? workspaceViewRef.current;
      const targetChannel: "chat" | "explore" =
        effectiveWorkspaceView === "explore" ? "explore" : "chat";
      const trimmedText = rawText.trim();
      const preTargetSessionId = activeSessionIdRef.current;
      const preExistingSession =
        (preTargetSessionId
          ? (sessionsRef.current.find((s) => s.id === preTargetSessionId) ?? null)
          : null) ??
        (options?.retryMsgId || options?.editUserMsgId
          ? (sessionsRef.current.find(
              (s) =>
                s.messages.some(
                  (m) =>
                    m.id === options?.retryMsgId || m.id === options?.editUserMsgId,
                ) ||
                (s.exploreMessages ?? []).some(
                  (m) =>
                    m.id === options?.retryMsgId || m.id === options?.editUserMsgId,
                ),
            ) ?? null)
          : null);
      const isRetry = Boolean(options?.retryMsgId);
      const isEditUser = Boolean(options?.editUserMsgId);
      const preChannelMessages = preExistingSession
        ? targetChannel === "explore"
          ? (preExistingSession.exploreMessages ?? [])
          : preExistingSession.messages
        : [];
      const preRetryIndex =
        isRetry && preExistingSession
          ? preChannelMessages.findIndex((m) => m.id === options?.retryMsgId)
          : -1;
      const preEditUserIndex =
        isEditUser && preExistingSession
          ? preChannelMessages.findIndex((m) => m.id === options?.editUserMsgId)
          : -1;
      let prePrecedingUserIdx = -1;
      if (isRetry && preRetryIndex !== -1) {
        for (let i = preRetryIndex - 1; i >= 0; i--) {
          if (preChannelMessages[i].role === "user") {
            prePrecedingUserIdx = i;
            break;
          }
        }
      }
      const precedingUserMsg =
        isRetry &&
        prePrecedingUserIdx !== -1 &&
        prePrecedingUserIdx < preRetryIndex
          ? preChannelMessages[prePrecedingUserIdx]
          : isEditUser && preEditUserIndex !== -1
            ? preChannelMessages[preEditUserIndex]
            : undefined;
      const effectiveText =
        trimmedText ||
        ((isRetry || isEditUser) ? (precedingUserMsg?.text || "").trim() : "");
      const attached =
        options?.attachments && options.attachments.length > 0
          ? options.attachments
          : (isRetry || isEditUser) && precedingUserMsg?.attachments?.length
            ? precedingUserMsg.attachments
            : [];
      if (!effectiveText && attached.length === 0) return;

      const text =
        effectiveText ||
        (attached.length === 1
          ? `Tolong cek lampiran: ${attached[0].name}`
          : `Tolong cek ${attached.length} file lampiran ini.`);
      const promptForBrain =
        attached.length > 0
          ? `${effectiveText ? `${effectiveText}\n\n` : ""}[Lampiran: ${attached
              .map((a) => `${a.name} (${a.kind})`)
              .join(", ")}]`
          : text;

      const currentModelId = selectedModelRef.current;
      const currentModelMeta = resolveModelMeta(currentModelId);
      const currentEffectiveEffort = normalizeReasoningEffort(
        currentModelMeta,
        reasoningEffortRef.current,
      );
      const currentWantReasoning =
        currentModelMeta.supportsReasoning && currentEffectiveEffort !== "off";

      stage.wakeFromIdle();

      if (offline) {
        stage.bumpSquash(-2.1);
        stage.wakeFromIdle();
        return;
      }

      cancelOngoingTurn();
      stopSpeechSynthesis();

      const ac = new AbortController();
      runAbortRef.current = ac;

      setInputValue("");
      setSentSeq((s) => s + 1);
      setBusy(true);
      setMiniAvatarStreamBusy(true);
      stage.setFocusTarget("think");
      stage.bumpSquash(-1.8);

      let targetSessionId = preTargetSessionId;
      const existingSession = preExistingSession;
      boardPrevLookRef.current = existingSession?.look ?? null;

      const turnBotId = options?.overrideBotId ??
        (existingSession ? existingSession.pinnedBotId ?? "momo" : activeBot.id);
      const currentBot = allBots.find((b) => b.id === turnBotId) ?? DEFAULT_BOT;
      const isPinnedRole = currentBot.id !== "momo";

      // Pre-flight Strict Session-Role Gate:
      // Locked specialist sessions stay within their role; if a query clearly belongs
      // to another domain, intercept in-character on the Momo avatar bubble BEFORE calling the LLM.
      const userMsgId = precedingUserMsg?.id ?? makeId("u");
      const botMsgId = makeId("m");
      // A session holding a specialist look — pinned or auto-routed — is protected the
      // same way; only "rest" sessions route freely.
      const sessionGateLook =
        !isPinnedRole && existingSession?.look && existingSession.look !== "rest"
          ? existingSession.look
          : undefined;
      const gateLook =
        effectiveWorkspaceView === "chat" && !options?.bypassRoleGate
          ? (isPinnedRole ? currentBot.look : sessionGateLook)
          : undefined;
      const makeGateMessage = (decision: Exclude<RoleDecision, { kind: "answer" }>): ChatMessage => {
        const suggestedRoleName = LOOK_NAMES[decision.suggestedLook] || decision.suggestedLook;
        const gateRoleName = isPinnedRole ? currentBot.name : LOOK_NAMES[gateLook || ""] || gateLook || "Momo";
        return {
          id: botMsgId,
          role: "momo",
          text: decision.kind === "clarify"
            ? `Mau lanjut dari sisi ${gateRoleName}, atau pindah ke ${suggestedRoleName} untuk bagian itu?`
            : "",
          look: gateLook || currentBot.look,
          botLabel: isPinnedRole ? currentBot.name : `Momo · ${gateRoleName}`,
          showActions: false,
          roleGate: {
            activeLook: gateLook || currentBot.look,
            activeRoleName: gateRoleName,
            suggestedLook: decision.suggestedLook,
            suggestedRoleName,
            originalQuery: text,
            userMsgId,
          },
        };
      };
      const historyEnd = isEditUser ? preEditUserIndex : isRetry ? prePrecedingUserIdx : preChannelMessages.length;
      const previousUser = preChannelMessages.slice(0, Math.max(0, historyEnd)).filter((m) => m.role === "user").at(-1);
      const decision = decideRoleTurn(text, gateLook, previousUser?.text);
      if (decision.kind !== "answer") {
        const gateMsg = makeGateMessage(decision);
        const userMsgObj: ChatMessage = {
          id: userMsgId,
          role: "user",
          text,
          attachments: attached.length > 0 ? attached : undefined,
        };

        if (!existingSession) {
          const sid = makeId("ses");
          const shortTitle =
            text.length > 42 ? `${text.slice(0, 42)}...` : text;
          const newSession: ChatSession = {
            id: sid,
            title: shortTitle,
            look: currentBot.look,
            pinnedBotId: currentBot.id,
            createdAt: Date.now(),
            messages: [userMsgObj, gateMsg],
          };
          activeSessionIdRef.current = sid;
          sessionsRef.current = [newSession, ...sessionsRef.current];
          setSessions((prev) => [newSession, ...prev]);
          setActiveSessionId(sid);
        } else {
          updateSessionMessages(
            existingSession.id,
            (prev) => {
              if (precedingUserMsg) {
                const liveIdx = prev.findIndex(
                  (m) => m.id === userMsgId,
                );
                if (liveIdx !== -1) {
                  return prev
                    .slice(0, liveIdx)
                    .concat(
                      { ...prev[liveIdx], text, attachments: attached.length > 0 ? attached : undefined },
                      gateMsg,
                    );
                }
              }
              return [...prev, userMsgObj, gateMsg];
            },
            currentBot.look,
            "chat",
          );
        }

        if (runAbortRef.current === ac) {
          runAbortRef.current = null;
        }
        setMiniAvatarStreamBusy(false);
        setBusy(false);
        setActiveLook(currentBot.look as LookId);
        setMood("curious");
        stage.setFocusTarget(null);
        stageRef.current.triggerExpression("surprised", 1400);
        return;
      }

      const lastChannelBotLook = [...preChannelMessages]
        .reverse()
        .find((m) => m.role === "momo" && m.look && m.look !== "rest")?.look;

      // Opsi 1 (Auto-Adaptive Momo + Manual Pin Override):
      // - If user selected a specific role/bot in Role Selector (`isPinnedRole`), lock strictly to `currentBot.look`.
      // - If user is on default adaptive Momo (`activeBot.id === "momo"`), re-score per turn from query intent
      //   (falling back to the previous turn's look on short/ambiguous follow-ups).
      const initialLook = (
        isPinnedRole
          ? currentBot.look
          : inferLookByKeyword(text, {
              fallbackLook: lastChannelBotLook || existingSession?.look,
            }) || "rest"
      ) as LookId;
      const initialMood = inferMoodByInput(text, initialLook);
      const initialLabel = isPinnedRole
        ? currentBot.name
        : initialLook === "rest"
          ? "Momo"
          : `Momo · ${LOOK_NAMES[initialLook] || initialLook}`;

      setActiveLook(initialLook);
      setMood(initialMood);

      const channelSourceMessages = preChannelMessages;
      const otherChannelMessages = existingSession
        ? targetChannel === "explore"
          ? existingSession.messages
          : (existingSession.exploreMessages ?? [])
        : [];
      const retryIndex = preRetryIndex;
      const editUserIndex = preEditUserIndex;

      const followingBotOnEdit =
        isEditUser && existingSession && editUserIndex !== -1
          ? channelSourceMessages
              .slice(editUserIndex + 1)
              .find((m) => m.role === "momo")
          : undefined;
      const isSameQueryResendOnEdit =
        isEditUser &&
        !followingBotOnEdit?.roleGate &&
        precedingUserMsg &&
        precedingUserMsg.text.trim() === text.trim();

      const retryPreviousText =
        isRetry && existingSession && retryIndex !== -1
          ? serializeMessageForHistory(channelSourceMessages[retryIndex]).slice(0, 1200)
          : isSameQueryResendOnEdit && followingBotOnEdit
            ? serializeMessageForHistory(followingBotOnEdit).slice(0, 1200)
            : undefined;
      const effectiveIsRetry = isRetry || Boolean(isSameQueryResendOnEdit);

      const freshStreamingBotMsg: ChatMessage = {
        id: botMsgId,
        role: "momo",
        text: "",
        parts: [],
        streaming: true,
        reasoningText: "",
        reasoningStreaming: false,
        hasNativeReasoning: false,
        modelHasReasoning: currentWantReasoning,
        activeModelId: currentModelId,
        reasoningEffortUsed: currentEffectiveEffort,
        startedAt: Date.now(),
        tokenCount: 0,
        elapsedSec: 0,
        promptTokens: undefined,
        completionTokens: undefined,
        reasoningTokens: undefined,
        cachedTokens: undefined,
        sources: undefined,
        imagePool: [],
        truncated: false,
        activityLabel: undefined,
        showActions: false,
        look: initialLook,
        botLabel: initialLabel,
        retryPrompt: text,
      };

      let historyPayload: Array<{ role: "user" | "assistant"; text: string }>;
      let nextSessionMessages: ChatMessage[];

      const handoffDividerMsg: ChatMessage | null = options?.handoffFromRole
        ? {
            id: makeId("sys"),
            role: "system",
            systemKind: "handoff",
            text: `Beralih peran: ${options.handoffFromRole} → ${currentBot.name}`,
          }
        : null;

      if (isEditUser && existingSession && editUserIndex !== -1) {
        historyPayload = channelSourceMessages
          .slice(0, editUserIndex)
          .filter((m) => (m.role === "user" || m.role === "momo") && !m.roleGate)
          .map((m) => ({
            role:
              m.role === "user" ? ("user" as const) : ("assistant" as const),
            text: serializeMessageForHistory(m),
          }))
          .filter((m) => m.text.trim().length > 0);

        const updatedUserMsg: ChatMessage = {
          ...channelSourceMessages[editUserIndex],
          text,
          attachments: attached.length > 0 ? attached : undefined,
        };
        nextSessionMessages = channelSourceMessages
          .slice(0, editUserIndex)
          .concat(
            ...(handoffDividerMsg ? [handoffDividerMsg] : []),
            updatedUserMsg,
            freshStreamingBotMsg,
          );
      } else if (isRetry && existingSession && retryIndex !== -1) {
        // Revert in-place: use the actual user message immediately preceding this bot turn
        const historyEndIdx =
          prePrecedingUserIdx !== -1 ? prePrecedingUserIdx : retryIndex;
        historyPayload = channelSourceMessages
          .slice(0, historyEndIdx)
          .filter((m) => (m.role === "user" || m.role === "momo") && !m.roleGate)
          .map((m) => ({
            role:
              m.role === "user" ? ("user" as const) : ("assistant" as const),
            text: serializeMessageForHistory(m),
          }))
          .filter((m) => m.text.trim().length > 0);

        const keepUntilIdx =
          prePrecedingUserIdx !== -1 ? prePrecedingUserIdx + 1 : retryIndex;
        nextSessionMessages = channelSourceMessages
          .slice(0, keepUntilIdx)
          .concat(freshStreamingBotMsg);
      } else {
        const primaryHist = channelSourceMessages
          .filter((m) => (m.role === "user" || m.role === "momo") && !m.roleGate)
          .map((m) => ({
            role:
              m.role === "user" ? ("user" as const) : ("assistant" as const),
            text: serializeMessageForHistory(m),
          }))
          .filter((m) => m.text.trim().length > 0);
        const crossChannelSeed =
          primaryHist.length === 0 && otherChannelMessages.length > 0
            ? otherChannelMessages
                .slice(-4)
                .filter((m) => (m.role === "user" || m.role === "momo") && !m.roleGate)
                .map((m) => ({
                  role:
                    m.role === "user"
                      ? ("user" as const)
                      : ("assistant" as const),
                  text: serializeMessageForHistory(m),
                }))
                .filter((m) => m.text.trim().length > 0)
            : [];
        historyPayload = [...crossChannelSeed, ...primaryHist];

        const newMessages: ChatMessage[] = [
          ...(handoffDividerMsg ? [handoffDividerMsg] : []),
          {
            id: userMsgId,
            role: "user",
            text,
            attachments: attached.length > 0 ? attached : undefined,
          },
          freshStreamingBotMsg,
        ];
        nextSessionMessages = newMessages;
      }

      if (!existingSession) {
        const sid = makeId("ses");
        targetSessionId = sid;
        const shortTitle = text.length > 42 ? `${text.slice(0, 42)}...` : text;
        const newSession: ChatSession = {
          id: sid,
          title: shortTitle,
          look: initialLook,
          ...(isPinnedRole ? { pinnedBotId: currentBot.id } : {}),
          createdAt: Date.now(),
          messages: targetChannel === "chat" ? nextSessionMessages : [],
          ...(targetChannel === "explore"
            ? { exploreMessages: nextSessionMessages }
            : {}),
        };
        activeSessionIdRef.current = sid;
        sessionsRef.current = [newSession, ...sessionsRef.current];
        setSessions((prev) => [newSession, ...prev]);
        setActiveSessionId(sid);
        requestAnimationFrame(() => {
          if (threadRef.current) threadRef.current.scrollTop = 0;
        });
      } else {
        targetSessionId = existingSession.id;
        updateSessionMessages(
          targetSessionId,
          (prev) => {
            if (isEditUser && options?.editUserMsgId) {
              const liveIdx = prev.findIndex(
                (m) => m.id === options.editUserMsgId,
              );
              if (liveIdx !== -1) {
                const updatedUserMsg: ChatMessage = {
                  ...prev[liveIdx],
                  text,
                  attachments: attached.length > 0 ? attached : undefined,
                };
                return prev
                  .slice(0, liveIdx)
                  .concat(
                    ...(handoffDividerMsg ? [handoffDividerMsg] : []),
                    updatedUserMsg,
                    freshStreamingBotMsg,
                  );
              }
            }
            if (isRetry && options?.retryMsgId) {
              const liveRetryIdx = prev.findIndex(
                (m) => m.id === options.retryMsgId,
              );
              if (liveRetryIdx !== -1) {
                let liveUserIdx = -1;
                for (let i = liveRetryIdx - 1; i >= 0; i--) {
                  if (prev[i].role === "user") {
                    liveUserIdx = i;
                    break;
                  }
                }
                const keepUntil =
                  liveUserIdx !== -1 ? liveUserIdx + 1 : liveRetryIdx;
                return prev.slice(0, keepUntil).concat(freshStreamingBotMsg);
              }
            }
            return [...prev, ...nextSessionMessages];
          },
          initialLook,
          targetChannel,
        );
      }

      const sessionId = targetSessionId;
      let latestBotText = "";
      const rawExploreMsgs = preExistingSession?.exploreMessages ?? [];
      const existingExploreMsgs =
        isRetry && targetChannel === "explore" && preRetryIndex !== -1
          ? rawExploreMsgs.slice(0, preRetryIndex)
          : rawExploreMsgs;
      const existingExploreComponents = Array.from(
        new Set(
          existingExploreMsgs
            .filter((m) => m.role === "momo" && m.text)
            .slice(-2)
            .flatMap((m) =>
              parseMixedStreamToMistlineBlocks(m.text, { final: true })
                .filter((b) => b.kind === "ui")
                .map((b) => b.name),
            ),
        ),
      );
      const resolvedBoardState = extractSessionBoardState(
        preExistingSession,
        initialLook,
      );
      const workspaceSnapshot = {
        columns: resolvedBoardState.columns.map((c) => ({
          id: c.id,
          title: c.title,
        })),
        items: resolvedBoardState.items.slice(0, 24).map((it) => ({
          title: it.title,
          columnId: it.columnId,
          ...(typeof it.done === "boolean" ? { done: it.done } : {}),
          ...(it.slot ? { slot: it.slot } : {}),
        })),
        pinnedTitles: (preExistingSession?.pinnedItems ?? [])
          .slice(0, 12)
          .map((p) => p.title),
        exploreTurnCount: existingExploreMsgs.filter((m) => m.role === "momo")
          .length,
        existingExploreComponents,
      };

      try {
        const res = await fetch("/api/brain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            message: text,
            roleGateConfirmed: options?.bypassRoleGate === true,
            messages: [
              ...historyPayload,
              { role: "user", text: promptForBrain },
            ],
            attachments: attached.map((a) => ({
              name: a.name,
              kind: a.kind,
              mimeType: a.mimeType,
              ...(a.imageDataUrl ? { imageDataUrl: a.imageDataUrl } : {}),
              ...(a.extractedText ? { extractedText: a.extractedText } : {}),
            })),
            activeLook: initialLook,
            sessionLook: existingSession?.look || undefined,
            pinnedBot: isPinnedRole
              ? {
                  name: currentBot.name,
                  job: currentBot.job,
                  look: currentBot.look,
                }
              : null,
            uiInteraction: options?.uiInteraction ?? null,
            workspaceView: effectiveWorkspaceView,
            workspaceSnapshot,
            isRetry: effectiveIsRetry,
            needsTitle: !existingSession,
            ...(retryPreviousText ? { retryPreviousText } : {}),
            modelId: currentModelId,
            reasoningEffort: currentEffectiveEffort,
            reasoningEnabled: currentWantReasoning,
          }),
        });

        if (res.status === 409) {
          const { roleGate } = await res.json() as { roleGate?: RoleDecision };
          if (roleGate && roleGate.kind !== "answer" && LOOK_NAMES[roleGate.suggestedLook]) {
            if (!ac.signal.aborted) updateSessionMessages(sessionId,
              (prev) => prev.map((m) => m.id === botMsgId ? makeGateMessage(roleGate) : m),
              undefined, targetChannel);
            return;
          }
        }
        if (!res.ok || !res.body) {
          throw new Error(`Server merespons status ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const applySse = (ev: BrainSseEvent) => {
          if (ev.type === "turn_meta") {
            const metaLook = isPinnedRole
              ? currentBot.look
              : initialLook !== "rest"
                ? initialLook
                : ev.look || "rest";
            const resolvedLabel = isPinnedRole
              ? currentBot.name
              : metaLook === "rest"
                ? "Momo"
                : `Momo · ${LOOK_NAMES[metaLook] || metaLook}`;
            setActiveLook(metaLook);
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? archiveAndRestoreSessionBoard(
                      s,
                      metaLook,
                      boardPrevLookRef.current,
                    )
                  : s,
              ),
            );
            boardPrevLookRef.current = null;
            setMood(ev.mood || "focused");
            stageRef.current.pulseIdea();
            stageRef.current.triggerExpression(
              ev.mood === "concerned"
                ? "sorry"
                : ev.mood === "happy"
                  ? "happy"
                  : "working",
              1100,
            );
            updateSessionMessages(
              sessionId,
              (prev) =>
                prev.map((m) =>
                  m.id === botMsgId
                    ? reduceBotMessageWithSse(m, {
                        ...ev,
                        look: metaLook,
                        botLabel: resolvedLabel,
                      })
                    : m,
                ),
              metaLook,
              targetChannel,
            );
            return;
          }

          if (ev.type === "session_title") {
            // Replace the placeholder (the truncated first message) unless the user renamed it meanwhile.
            const placeholder = text.length > 42 ? `${text.slice(0, 42)}...` : text;
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId && s.title === placeholder ? { ...s, title: ev.title } : s,
              ),
            );
            return;
          }

          if (ev.type === "image_pool") {
            recordVerifiedImageUrls(ev.urls);
            // Keep the verified set on the turn so a reload whitelists exactly what the live render did.
            updateSessionMessages(
              sessionId,
              (prev) => prev.map((m) => (m.id === botMsgId ? { ...m, imagePool: ev.urls } : m)),
              undefined,
              targetChannel,
            );
            return;
          }

          if (ev.type === "board_update") {
            recordVerifiedImageUrls(
              (ev.items || []).map((it) => it.imageUrl),
            );
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      boardColumns: ev.columns,
                      boardItems: ev.items,
                    }
                  : s,
              ),
            );
            return;
          }

          if (ev.type === "text_delta" && ev.delta) {
            latestBotText += ev.delta;
          }

          updateSessionMessages(
            sessionId,
            (prev) =>
              prev.map((m) => {
                if (m.id !== botMsgId) return m;
                return reduceBotMessageWithSse(m, ev);
              }),
            undefined,
            targetChannel,
          );
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }
          if (ac.signal.aborted) break;

          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const lines = frame.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const jsonStr = trimmed.slice(5).trim();
              if (!jsonStr) continue;
              try {
                const parsed = JSON.parse(jsonStr) as BrainSseEvent;
                applySse(parsed);
              } catch {
                // Ignore malformed SSE frame
              }
            }
          }
        }

        if (buffer.trim()) {
          for (const line of buffer.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            try {
              const parsed = JSON.parse(
                trimmed.slice(5).trim(),
              ) as BrainSseEvent;
              applySse(parsed);
            } catch {
              // Ignore trailing fragment
            }
          }
        }

        if (!ac.signal.aborted) {
          const parsedUiBlocks = parseMixedStreamToMistlineBlocks(
            latestBotText,
            { final: true },
          );
          const hasRenderedUi = parsedUiBlocks.some((b) => b.kind === "ui");

          // Persist drafted items to Pinboard ONLY in Persistent Workspace modes
          // (Explore / Board), keeping inline Chat Response UI ephemeral unless pinned.
          if (
            effectiveWorkspaceView === "explore" ||
            effectiveWorkspaceView === "board"
          ) {
            const roleLens = getRoleLens(initialLook);
            const roleCfg = getRoleWorkspaceConfig(initialLook);
            const draftedItems = extractMistlineBoardDrafts(
              parsedUiBlocks,
              roleLens.laneHints,
            );
            if (draftedItems.length > 0) {
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== sessionId) return s;
                  const cols =
                    s.boardColumns && s.boardColumns.length > 0
                      ? [...s.boardColumns]
                      : [...roleCfg.boardDefaultColumns];
                  const existingItems = s.boardItems ? [...s.boardItems] : [];
                  const seenTitles = new Set(
                    existingItems.map((it) => it.title.trim().toLowerCase()),
                  );
                  const resolveColId = (laneTitle?: string): string => {
                    if (!laneTitle) return cols[0]?.id || "col-1";
                    const norm = laneTitle.trim().toLowerCase();
                    const existingCol = cols.find(
                      (c) =>
                        c.title.trim().toLowerCase() === norm ||
                        c.id.trim().toLowerCase() === norm,
                    );
                    if (existingCol) return existingCol.id;
                    const newColId = `lane-${norm.replace(/[^a-z0-9]+/g, "-")}-${cols.length + 1}`;
                    cols.push({ id: newColId, title: laneTitle.trim() });
                    return newColId;
                  };
                  for (const d of draftedItems) {
                    const keyTitle = d.title.trim().toLowerCase();
                    if (!keyTitle || seenTitles.has(keyTitle)) continue;
                    seenTitles.add(keyTitle);
                    existingItems.push({
                      id: makeId("brd"),
                      columnId: resolveColId(d.laneTitle),
                      title: d.title,
                      ...(d.subtitle ? { subtitle: d.subtitle } : {}),
                      ...(d.slot ? { slot: d.slot } : {}),
                      ...(d.metric ? { metric: d.metric } : {}),
                      ...(d.note ? { handNote: d.note } : {}),
                      ...(d.pin ? { pin: d.pin } : {}),
                      ...(d.image ? { imageUrl: d.image } : {}),
                      ...(d.imageQuery ? { imageQuery: d.imageQuery } : {}),
                    });
                  }
                  return {
                    ...s,
                    boardColumns: cols,
                    boardItems: existingItems,
                  };
                }),
              );
            }
          }

          updateSessionMessages(
            sessionId,
            (prev) =>
              prev.map((m) =>
                m.id === botMsgId && m.streaming
                  ? reduceBotMessageWithSse(m, { type: "turn_done" })
                  : m,
              ),
            undefined,
            targetChannel,
          );
          stageRef.current.triggerExpression(
            hasRenderedUi ? "sparkle" : "happy",
            1200,
          );
          if (autoSpeak && latestBotText.trim()) {
            speakText(botMsgId, latestBotText);
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          const errMessage =
            err instanceof Error ? err.message : "Koneksi ke server AI gagal.";
          updateSessionMessages(
            sessionId,
            (prev) =>
              prev.map((m) =>
                m.id === botMsgId
                  ? reduceBotMessageWithSse(m, {
                      type: "turn_error",
                      message: errMessage,
                    })
                  : m,
              ),
            undefined,
            targetChannel,
          );
          stageRef.current.triggerExpression("sorry", 1400);
        }
      } finally {
        if (runAbortRef.current === ac) {
          runAbortRef.current = null;
          setMiniAvatarStreamBusy(false);
          setBusy(false);
          stageRef.current.setFocusTarget(null);
        }
      }
    },
    [
      activeBot,
      activeLook,
      allBots,
      autoSpeak,
      cancelOngoingTurn,
      offline,
      speakText,
      stage,
      stopSpeechSynthesis,
      updateSessionMessages,
    ],
  );

  const submitPromptRef = useRef(submitPrompt);
  submitPromptRef.current = submitPrompt;

  const handleMessageCopy = useCallback(async () => true, []);
  const handleRetryMessage = useCallback(
    (msg: ChatMessage, channel: "chat" | "explore" = "chat") => {
      const ses =
        (activeSessionIdRef.current
          ? sessionsRef.current.find((s) => s.id === activeSessionIdRef.current)
          : undefined) ??
        sessionsRef.current.find(
          (s) =>
            s.messages.some((m) => m.id === msg.id) ||
            (s.exploreMessages ?? []).some((m) => m.id === msg.id),
        );
      const list = ses
        ? channel === "explore"
          ? (ses.exploreMessages ?? [])
          : ses.messages
        : [];
      const botIdx = list.findIndex((m) => m.id === msg.id);
      let precedingUser: ChatMessage | undefined;
      const searchFrom = botIdx !== -1 ? botIdx - 1 : list.length - 1;
      for (let i = searchFrom; i >= 0; i--) {
        if (list[i]?.role === "user") {
          precedingUser = list[i];
          break;
        }
      }
      const promptText = msg.retryPrompt || precedingUser?.text || "";
      const retryAttachments = precedingUser?.attachments;
      if (!promptText && (!retryAttachments || retryAttachments.length === 0)) {
        return;
      }
      void submitPromptRef.current(promptText, {
        retryMsgId: msg.id,
        attachments: retryAttachments,
        targetChannel: channel,
      });
    },
    [],
  );
  const handleEditUserMessage = useCallback(
    (msg: ChatMessage, nextText: string) => {
      const ses =
        (activeSessionIdRef.current
          ? sessionsRef.current.find((s) => s.id === activeSessionIdRef.current)
          : undefined) ??
        sessionsRef.current.find((s) =>
          s.messages.some((m) => m.id === msg.id),
        );
      const existingMsg = ses?.messages.find((m) => m.id === msg.id) ?? msg;
      const cleaned = nextText.trim();
      const attachments = existingMsg.attachments;
      if (!cleaned && (!attachments || attachments.length === 0)) {
        return;
      }
      void submitPromptRef.current(cleaned, {
        editUserMsgId: msg.id,
        attachments,
        targetChannel: "chat",
      });
    },
    [],
  );
  const handleRoleGateEditQuery = useCallback((msg: ChatMessage) => {
    const gate = msg.roleGate;
    if (!gate) return;
    setForcedEditRequest({ msgId: gate.userMsgId, seq: Date.now() });
  }, []);

  const consumedGateId = useRef<string | null>(null);
  const claimGate = useCallback((id: string) => {
    const session = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (session?.messages.at(-1)?.id !== id || consumedGateId.current === id) return false;
    consumedGateId.current = id;
    return true;
  }, []);

  const handleRoleGateSwitchRole = useCallback(
    (msg: ChatMessage, targetBotId: string) => {
      const gate = msg.roleGate;
      if (!gate) return;
      const target = allBots.find((b) => b.id === targetBotId);
      if (!target || !claimGate(msg.id)) return;

      setActiveBotId(target.id);
      setActiveLook(target.look as LookId);

      const sesId = activeSessionIdRef.current;
      if (sesId) {
        const nextPinnedId = target.id !== "momo" ? target.id : undefined;
        const switchRole = (s: ChatSession) =>
          s.id === sesId
            ? { ...archiveAndRestoreSessionBoard(s, target.look), pinnedBotId: nextPinnedId }
            : s;
        sessionsRef.current = sessionsRef.current.map(switchRole);
        setSessions((prev) => prev.map(switchRole));
      }

      void submitPromptRef.current(gate.originalQuery, {
        editUserMsgId: gate.userMsgId,
        overrideBotId: target.id,
        bypassRoleGate: true,
        handoffFromRole: gate.activeRoleName,
        targetChannel: "chat",
      });
    },
    [allBots, claimGate],
  );

  const handleRoleGateStay = useCallback((msg: ChatMessage) => {
    const gate = msg.roleGate;
    if (!gate || !claimGate(msg.id)) return;
    void submitPromptRef.current(gate.originalQuery, {
      editUserMsgId: gate.userMsgId,
      bypassRoleGate: true,
      targetChannel: "chat",
    });
  }, [claimGate]);

  const handlePromptAction = useCallback((prompt: string) => {
    void submitPromptRef.current(prompt);
  }, []);

  const handleUiInteraction = useCallback(
    (interaction: UiInteractionPayload) => {
      void submitPromptRef.current(interaction.prompt, {
        uiInteraction: interaction,
      });
    },
    [],
  );

  const reorderBoardItems = useCallback(
    (
      list: WorkspaceBoardItem[],
      itemId: string,
      targetColumnId: string,
      targetIndex?: number,
    ): WorkspaceBoardItem[] => {
      const moving = list.find((it) => it.id === itemId);
      if (!moving) return list;
      const updatedItem: WorkspaceBoardItem = {
        ...moving,
        columnId: targetColumnId,
      };
      const rest = list.filter((it) => it.id !== itemId);
      if (typeof targetIndex !== "number" || !Number.isFinite(targetIndex)) {
        return [...rest, updatedItem];
      }
      const colPositions: number[] = [];
      rest.forEach((it, idx) => {
        if (it.columnId === targetColumnId) colPositions.push(idx);
      });
      if (colPositions.length === 0 || targetIndex >= colPositions.length) {
        if (colPositions.length === 0) return [...rest, updatedItem];
        const insertAt = colPositions[colPositions.length - 1] + 1;
        return [
          ...rest.slice(0, insertAt),
          updatedItem,
          ...rest.slice(insertAt),
        ];
      }
      const clampedIdx = Math.max(0, targetIndex);
      const insertAt = colPositions[clampedIdx];
      return [...rest.slice(0, insertAt), updatedItem, ...rest.slice(insertAt)];
    },
    [],
  );

  const sessionBoardItemsRef = useRef<WorkspaceBoardItem[]>([]);
  sessionBoardItemsRef.current = sessionBoardState.items;

  const resolveBoardOwnerSessionId = useCallback(
    (targetItemId?: string): string | null => {
      if (targetItemId) {
        const hit = sessionBoardItemsRef.current.find(
          (it) => it.id === targetItemId,
        );
        if (hit?.sessionId) return hit.sessionId;
      }
      const curSid = activeSessionIdRef.current;
      if (curSid) {
        const curSes = sessionsRef.current.find((s) => s.id === curSid);
        if (
          curSes &&
          extractSessionBoardState(curSes, curSes.look || activeLook).items
            .length > 0
        ) {
          return curSid;
        }
      }
      const fallbackOwner = sessionBoardItemsRef.current.find((it) =>
        Boolean(it.sessionId),
      )?.sessionId;
      return fallbackOwner || curSid;
    },
    [activeLook],
  );

  const handleMoveBoardItem = useCallback(
    (itemId: string, targetColumnId: string, targetIndex?: number) => {
      const targetSid = resolveBoardOwnerSessionId(itemId);
      if (!targetSid) {
        const snapshot = extractSessionBoardState(null, activeLook);
        const moved = reorderBoardItems(
          snapshot.items,
          itemId,
          targetColumnId,
          targetIndex,
        );
        const sid = makeId("ses");
        setSessions((prev) => [
          {
            id: sid,
            title: roleConfig.boardLabel,
            look: activeLook,
            pinnedBotId: activeBot.id === "momo" ? undefined : activeBot.id,
            createdAt: Date.now(),
            messages: [],
            boardColumns: snapshot.columns,
            boardItems: moved,
          },
          ...prev,
        ]);
        setActiveSessionId(sid);
        return;
      }

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSid) return s;
          const base = extractSessionBoardState(s, s.look || activeLook);
          const updated = reorderBoardItems(
            base.items,
            itemId,
            targetColumnId,
            targetIndex,
          );
          return {
            ...s,
            boardColumns: base.columns,
            boardItems: updated,
          };
        }),
      );
    },
    [
      activeBot.id,
      activeLook,
      reorderBoardItems,
      resolveBoardOwnerSessionId,
      roleConfig.boardLabel,
    ],
  );

  const handleAddBoardItem = useCallback(
    (columnId: string, item: Omit<WorkspaceBoardItem, "id" | "columnId">) => {
      const targetSid = resolveBoardOwnerSessionId();
      const newItem: WorkspaceBoardItem = {
        ...item,
        id: makeId("crd"),
        columnId,
      };
      if (!targetSid) {
        const snapshot = extractSessionBoardState(null, activeLook);
        const sid = makeId("ses");
        setSessions((prev) => [
          {
            id: sid,
            title: roleConfig.boardLabel,
            look: activeLook,
            pinnedBotId: activeBot.id === "momo" ? undefined : activeBot.id,
            createdAt: Date.now(),
            messages: [],
            boardColumns: snapshot.columns,
            boardItems: [...snapshot.items, newItem],
          },
          ...prev,
        ]);
        setActiveSessionId(sid);
        return;
      }

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSid) return s;
          const base = extractSessionBoardState(s, s.look || activeLook);
          return {
            ...s,
            boardColumns: base.columns,
            boardItems: [...base.items, newItem],
          };
        }),
      );
    },
    [activeBot.id, activeLook, resolveBoardOwnerSessionId, roleConfig.boardLabel],
  );

  const handleUpdateBoardItem = useCallback(
    (itemId: string, patch: Partial<WorkspaceBoardItem>) => {
      const targetSid = resolveBoardOwnerSessionId(itemId);
      if (!targetSid) return;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSid) return s;
          const base = extractSessionBoardState(s, s.look || activeLook);
          const targetItem = base.items.find((it) => it.id === itemId);
          const targetKey = targetItem?.title.trim().toLowerCase();
          const updatedItems = base.items.map((it) =>
            it.id === itemId ? { ...it, ...patch } : it,
          );
          const existingPinned = s.pinnedItems ?? [];
          const nextPinned =
            patch.starred === false
              ? existingPinned.filter(
                  (p) =>
                    p.id !== itemId &&
                    (!targetKey || p.title.trim().toLowerCase() !== targetKey),
                )
              : existingPinned.map((p) =>
                  p.id === itemId ||
                  (targetKey && p.title.trim().toLowerCase() === targetKey)
                    ? { ...p, ...patch }
                    : p,
                );
          return {
            ...s,
            boardColumns: base.columns,
            boardItems: updatedItems,
            pinnedItems: nextPinned,
          };
        }),
      );
    },
    [activeLook, resolveBoardOwnerSessionId],
  );

  const handleDeleteBoardItem = useCallback(
    (itemId: string) => {
      const targetSid = resolveBoardOwnerSessionId(itemId);
      if (!targetSid) return;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSid) return s;
          const base = extractSessionBoardState(s, s.look || activeLook);
          const removed = base.items.find((it) => it.id === itemId);
          const removedKey = removed?.title.trim().toLowerCase();
          const updatedItems = base.items.filter((it) => it.id !== itemId);
          const nextPinned = (s.pinnedItems ?? []).filter(
            (p) =>
              p.id !== itemId &&
              (!removedKey || p.title.trim().toLowerCase() !== removedKey),
          );
          return {
            ...s,
            boardColumns: base.columns,
            boardItems: updatedItems,
            pinnedItems: nextPinned,
          };
        }),
      );
    },
    [activeLook, resolveBoardOwnerSessionId],
  );

  const clearDictateError = useCallback(() => {
    if (dictateErrTimerRef.current !== null) {
      window.clearTimeout(dictateErrTimerRef.current);
      dictateErrTimerRef.current = null;
    }
    setDictateError(null);
  }, []);

  const showTransientDictateError = useCallback((msg: string) => {
    setDictateError(msg);
    if (dictateErrTimerRef.current !== null) {
      window.clearTimeout(dictateErrTimerRef.current);
    }
    dictateErrTimerRef.current = window.setTimeout(() => {
      dictateErrTimerRef.current = null;
      setDictateError(null);
    }, 3800);
  }, []);

  const handleToggleMic = useCallback(() => {
    if (dictatingRef.current || dictating) {
      stopDictationCleanup();
      return;
    }

    stopDictationCleanup();
    clearDictateError();
    const sid = dictateSessionIdRef.current;
    dictateBaseTextRef.current = inputValueRef.current.trimEnd();

    const releaseMeterStream = () => {
      if (dictateVoiceRafRef.current) {
        cancelAnimationFrame(dictateVoiceRafRef.current);
        dictateVoiceRafRef.current = 0;
      }
      const stream = dictateMediaStreamRef.current;
      dictateMediaStreamRef.current = null;
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
      }
      const ctx = dictateAudioCtxRef.current;
      dictateAudioCtxRef.current = null;
      if (ctx) {
        try {
          void ctx.close().catch(() => {});
        } catch {
          // ignore
        }
      }
      if (composerRef.current) {
        composerRef.current.style.removeProperty("--crest-voice-level");
      }
    };

    const startAudioMeter = (stream: MediaStream) => {
      dictateMediaStreamRef.current = stream;
      if (typeof AudioContext === "undefined") return;
      try {
        const ctx = new AudioContext();
        dictateAudioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        source.connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);
        const pumpMeter = () => {
          if (dictateSessionIdRef.current !== sid || !dictatingRef.current)
            return;
          analyser.getByteFrequencyData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i++) sum += bins[i];
          const avg = bins.length > 0 ? sum / (bins.length * 255) : 0;
          const level = Math.min(1, avg * 3.4);
          if (composerRef.current) {
            composerRef.current.style.setProperty(
              "--crest-voice-level",
              level.toFixed(3),
            );
          }
          dictateVoiceRafRef.current = requestAnimationFrame(pumpMeter);
        };
        dictateVoiceRafRef.current = requestAnimationFrame(pumpMeter);
      } catch {
        // Metering optional; SpeechRecognition still works without AudioContext
      }
    };

    const startRecognitionSession = (
      Ctor: new () => SpeechRecLike,
      opts: {
        lang: string;
        localFallbackTried: boolean;
        meterReleasedRetry: boolean;
      },
    ) => {
      if (dictateSessionIdRef.current !== sid) return;

      const rec = new Ctor();
      rec.lang = opts.lang;
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      if (opts.localFallbackTried && "processLocally" in rec) {
        rec.processLocally = true;
      }

      rec.onresult = (ev) => {
        if (dictateSessionIdRef.current !== sid) return;
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i];
          const seg = res?.[0]?.transcript || "";
          if (!seg) continue;
          if (res?.isFinal === false) {
            interimText += seg;
          } else {
            finalText += seg;
          }
        }
        const spoken = (finalText + interimText)
          .replace(/\s+/g, " ")
          .trimStart();
        if (!spoken) return;
        const base = dictateBaseTextRef.current;
        setInputValue(base ? `${base} ${spoken}` : spoken);
      };

      rec.onerror = (ev) => {
        if (dictateSessionIdRef.current !== sid) return;
        const code = ev?.error || "";

        // Natural speech pauses should not prematurely abort active dictation
        if (code === "no-speech" || code === "aborted") {
          return;
        }

        const detachCurrent = () => {
          if (speechRecRef.current === rec) {
            speechRecRef.current = null;
          }
          rec.onresult = null;
          rec.onerror = null;
          rec.onend = null;
          try {
            rec.abort?.();
          } catch {
            // ignore
          }
        };

        if (
          code === "language-not-supported" &&
          opts.lang !== (navigator.language || "en-US")
        ) {
          detachCurrent();
          dictateBaseTextRef.current = inputValueRef.current.trimEnd();
          startRecognitionSession(Ctor, {
            ...opts,
            lang: navigator.language || "en-US",
          });
          return;
        }

        if (
          code === "network" &&
          !opts.localFallbackTried &&
          "processLocally" in rec
        ) {
          detachCurrent();
          dictateBaseTextRef.current = inputValueRef.current.trimEnd();
          startRecognitionSession(Ctor, {
            ...opts,
            localFallbackTried: true,
          });
          return;
        }

        if (
          code === "audio-capture" &&
          dictateMediaStreamRef.current &&
          !opts.meterReleasedRetry
        ) {
          detachCurrent();
          releaseMeterStream();
          dictateBaseTextRef.current = inputValueRef.current.trimEnd();
          startRecognitionSession(Ctor, {
            ...opts,
            meterReleasedRetry: true,
          });
          return;
        }

        stopDictationCleanup({ abort: true });
        if (code === "not-allowed" || code === "service-not-allowed") {
          showTransientDictateError("Izin mikrofon ditolak");
        } else if (code === "audio-capture") {
          showTransientDictateError("Mikrofon tidak ditemukan");
        } else if (code === "network") {
          showTransientDictateError("Koneksi dikte terputus");
        } else {
          showTransientDictateError("Gagal menyalakan dikte");
        }
      };

      rec.onend = () => {
        if (speechRecRef.current === rec) {
          stopDictationCleanup();
        }
      };

      speechRecRef.current = rec;
      dictatingRef.current = true;
      setDictating(true);
      stage.triggerExpression("listening", 2500);

      try {
        rec.start();
      } catch {
        stopDictationCleanup({ abort: true });
        showTransientDictateError("Gagal menyalakan dikte");
      }
    };

    const Ctor = getSpeechRecognitionCtor();

    // Always request browser microphone permission first inside user gesture so permission prompt is reliably surfaced
    if (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia
    ) {
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (dictateSessionIdRef.current !== sid) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          if (!Ctor) {
            stream.getTracks().forEach((t) => t.stop());
            stopDictationCleanup({ abort: true });
            showTransientDictateError("Dikte tidak didukung");
            return;
          }
          startRecognitionSession(Ctor, {
            lang: "id-ID",
            localFallbackTried: false,
            meterReleasedRetry: false,
          });
          if (dictatingRef.current) {
            startAudioMeter(stream);
          } else {
            stream.getTracks().forEach((t) => t.stop());
          }
        })
        .catch((err: unknown) => {
          if (dictateSessionIdRef.current !== sid) return;
          stopDictationCleanup({ abort: true });
          const errName =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name || "")
              : "";
          if (
            errName === "NotFoundError" ||
            errName === "DevicesNotFoundError"
          ) {
            showTransientDictateError("Mikrofon tidak ditemukan");
          } else {
            showTransientDictateError("Izin mikrofon ditolak");
          }
        });
      return;
    }

    if (!Ctor) {
      showTransientDictateError("Dikte tidak didukung");
      return;
    }
    startRecognitionSession(Ctor, {
      lang: "id-ID",
      localFallbackTried: false,
      meterReleasedRetry: true,
    });
  }, [
    clearDictateError,
    dictating,
    showTransientDictateError,
    stage,
    stopDictationCleanup,
  ]);

  const handleNewChat = useCallback(() => {
    cancelOngoingTurn();
    stopSpeechSynthesis();
    setOffline(false);
    setActiveSessionId(null);
    setActiveLook(activeBot.look || "rest");
    setMood("neutral");
    stage.resetToRest();
    setSideOpen(false);
    // "+ Obrolan baru" has to land on a visible chat — on Pinboard it otherwise clears
    // the session while the user stays on the board and nothing appears to happen.
    if (workspaceView !== "explore") setWorkspaceView("chat");
  }, [
    activeBot.look,
    cancelOngoingTurn,
    stage,
    stopSpeechSynthesis,
    workspaceView,
  ]);

  const handleSelectSession = useCallback(
    (session: ChatSession) => {
      if (session.id === activeSessionIdRef.current) {
        setSideOpen(false);
        return;
      }
      cancelOngoingTurn();
      stopSpeechSynthesis();
      setOffline(false);
      setActiveSessionId(session.id);
      setActiveBotId(session.pinnedBotId ?? "momo");
      setActiveLook(session.look || "rest");
      setMood("neutral");
      stage.wakeFromIdle();
      setSideOpen(false);
      requestAnimationFrame(() => {
        if (threadRef.current) threadRef.current.scrollTop = 0;
      });
    },
    [
      cancelOngoingTurn,
      stage,
      stopSpeechSynthesis,
    ],
  );

  const handleStartRenameSession = useCallback(
    (surface: "side" | "rail", session: ChatSession) => {
      renameCancelGuardRef.current = false;
      setSkeuoCtxMenu(null);
      setEditingSessionKey({ surface, id: session.id });
      setEditingTitleDraft(session.title || "Obrolan baru");
    },
    [],
  );

  const handleCancelRenameSession = useCallback(() => {
    renameCancelGuardRef.current = true;
    setEditingSessionKey(null);
    setEditingTitleDraft("");
  }, []);

  const handleCommitRenameSession = useCallback(
    (sessionId: string, rawTitle: string) => {
      if (renameCancelGuardRef.current) {
        renameCancelGuardRef.current = false;
        return;
      }
      const trimmed = rawTitle.trim().slice(0, 120);
      setEditingSessionKey(null);
      setEditingTitleDraft("");
      if (!trimmed) return;
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s)),
      );
    },
    [],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      setSkeuoCtxMenu(null);
      setEditingSessionKey((cur) => (cur?.id === sessionId ? null : cur));
      const wasActive = activeSessionIdRef.current === sessionId;
      if (wasActive) {
        cancelOngoingTurn();
        stopSpeechSynthesis();
        setOffline(false);
      }
      const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      let nextActiveId = activeSessionIdRef.current;
      if (wasActive) {
        const fallback = remaining[0] ?? null;
        nextActiveId = fallback ? fallback.id : null;
        setActiveSessionId(nextActiveId);
        if (fallback) {
          setActiveLook(fallback.look || activeBot.look || "rest");
        } else {
          setActiveLook(activeBot.look || "rest");
          setMood("neutral");
          stage.resetToRest();
        }
      }
      try {
        localStorage.setItem(
          STORAGE_SESSIONS_KEY,
          JSON.stringify(remaining.slice(0, 20).map(sanitizeSessionForStorage)),
        );
        if (nextActiveId) {
          localStorage.setItem(STORAGE_ACTIVE_SESSION_KEY, nextActiveId);
        } else {
          localStorage.removeItem(STORAGE_ACTIVE_SESSION_KEY);
        }
      } catch {
        // ignore storage errors
      }
    },
    [activeBot.look, cancelOngoingTurn, stage, stopSpeechSynthesis],
  );

  const openSkeuoCtxMenu = useCallback(
    (
      e: React.MouseEvent,
      kind: "dock" | "session",
      sessionId?: string,
      surface?: "side" | "rail",
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const maxX =
        typeof window !== "undefined" ? window.innerWidth - 176 : e.clientX;
      const maxY =
        typeof window !== "undefined" ? window.innerHeight - 140 : e.clientY;
      setSkeuoCtxMenu({
        x: Math.max(10, Math.min(e.clientX, maxX)),
        y: Math.max(10, Math.min(e.clientY, maxY)),
        kind,
        sessionId,
        surface,
      });
    },
    [],
  );

  const handleSelectBot = useCallback(
    (botId: string) => {
      const target = allBots.find((b) => b.id === botId) ?? DEFAULT_BOT;
      setActiveBotId(target.id);
      setActiveLook(target.look);
      setMood(DEFAULT_MOOD_BY_LOOK[target.look] ?? "happy");
      if (activeSessionId) {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSessionId) return s;
            const next = archiveAndRestoreSessionBoard(s, target.look);
            return {
              ...next,
              pinnedBotId: target.id !== "momo" ? target.id : undefined,
            };
          }),
        );
      }
      stage.wakeFromIdle();
      stage.bumpSquash(-1.5);
    },
    [activeSessionId, allBots, stage],
  );

  const handleCreateBot = useCallback(
    (name: string, job: string, look: string) => {
      const id = `custom:${Date.now()}`;
      const newBot: BotIdentity = {
        id,
        name,
        job,
        look,
        own: true,
      };
      const current = getCustomBotsSnapshot();
      writeCustomBots([...current, newBot]);
      if (activeSessionId) {
        setSessions((prev) => prev.map((s) => s.id === activeSessionId
          ? { ...archiveAndRestoreSessionBoard(s, look), pinnedBotId: id } : s));
      }
      setActiveBotId(id);
      setActiveLook(look);
      setMood("happy");
      stage.wakeFromIdle();
      stage.triggerExpression("sparkle", 1400);
    },
    [activeSessionId, stage],
  );

  const handleDeleteBot = useCallback(
    (botId: string) => {
      const current = getCustomBotsSnapshot();
      writeCustomBots(current.filter((b) => b.id !== botId));
      if (activeBotId === botId) {
        setActiveBotId("momo");
        setActiveLook("rest");
      }
    },
    [activeBotId],
  );

  const composerSnapshot: ComposerSnapshot = useMemo(
    () => ({
      botName: activeBot.name,
      roleId: activeLook,
      isCustomBot: Boolean(activeBot.own),
      rolePalette: resolvePaletteTuple(activeLook, paletteOverrides),
      busy,
      dictating,
      dictateError,
      sentSeq,
      inputValue,
      placeholder:
        !started && exploreBridgeTopic
          ? `Tanya apa saja soal ${exploreBridgeTopic.replace(/\.+$/, "")}...`
          : `Tanya ${activeBot.name} apa saja`,
    }),
    [
      activeBot,
      activeLook,
      paletteOverrides,
      busy,
      dictating,
      dictateError,
      sentSeq,
      inputValue,
      started,
      exploreBridgeTopic,
    ],
  );

  const closeSidebar = useCallback(() => {
    setProfileMenuOpen(false);
    setRailHistoryOpen(false);
    sideFocusRef.current = Boolean(sidebarRef.current?.contains(document.activeElement));
    setSidePhase((p) => (p === "open" ? "closing" : p === "railOut" ? "closed" : p));
  }, []);

  const openSidebar = useCallback(() => {
    setRailHistoryOpen(false);
    sideFocusRef.current = Boolean(railRef.current?.contains(document.activeElement));
    // The rail leaves first; its exit completion opens the drawer.
    setSidePhase((p) => (p === "closed" ? "railOut" : p === "closing" ? "open" : p));
  }, []);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setProfileMenuOpen(false);
      setSideOpen((v) => !v);
    } else if (sidePhase === "open") {
      closeSidebar();
    } else {
      openSidebar();
    }
  }, [closeSidebar, isMobile, openSidebar, sidePhase]);

  const focusAfterSidebar = (id: string) => {
    if (!sideFocusRef.current) return;
    sideFocusRef.current = false;
    requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
  };

  return (
    <div
      ref={appMountRef}
      className={`app${sideHidden && !isMobile ? " side-hidden" : ""}`}
      style={accentStyle}
    >
      {/* Left Navigation Sidebar (fixed-width inner wrapper avoids text reflow on collapse/reveal) */}
      <aside
        ref={sidebarRef}
        id="side"
        className={`side${sideOpen ? " open" : ""}${sideHidden && !isMobile ? " is-hidden" : ""}`}
        aria-hidden={(isMobile ? !sideOpen : sideHidden) ? true : undefined}
        inert={isMobile ? !sideOpen : sideHidden}
      >
        <motion.div
          className="side-inner"
          variants={reduceMotion ? SIDE_PANEL_REDUCED : SIDE_PANEL_VARIANTS}
          initial={false}
          animate={isMobile ? "open" : sideHidden ? "collapsed" : "open"}
          onAnimationComplete={(label) => {
            if (label === "collapsed") {
              setSidePhase((p) => (p === "closing" ? "closed" : p));
              focusAfterSidebar("floatingSidebarOpen");
            } else if (label === "open") {
              focusAfterSidebar("sideCollapse");
            }
          }}
        >
          <motion.div className="bar brand" variants={sidePartVariants}>
            <div className="brand-lockup">
              <motion.div
                className="brand-mark-wrap"
                whileHover={{ scale: 1.08, rotate: -4 }}
                whileTap={{ scale: 0.94 }}
                transition={{ duration: 0.2, ease: EASE_MOMO }}
              >
                <svg
                  className="brand-mark"
                  viewBox="0 0 28 28"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="0.8"
                    y="10"
                    width="2.6"
                    height="8"
                    rx="1.3"
                    fill="var(--accent-shade, #DA6C4D)"
                  />
                  <rect
                    x="24.6"
                    y="10"
                    width="2.6"
                    height="8"
                    rx="1.3"
                    fill="var(--accent-shade, #DA6C4D)"
                  />
                  <rect
                    x="2.5"
                    y="3"
                    width="23"
                    height="22"
                    rx="6"
                    fill="var(--accent, #EF8C66)"
                  />
                  <rect
                    x="5.5"
                    y="7"
                    width="17"
                    height="14"
                    rx="4"
                    fill="#141416"
                  />
                  <motion.rect
                    x="9.2"
                    y="11"
                    width="3"
                    height="6"
                    rx="1.5"
                    fill="var(--accent-light, #FBC2A2)"
                    animate={{ scaleY: [1, 1, 0.16, 1, 1] }}
                    transition={{
                      duration: 4.4,
                      times: [0, 0.92, 0.96, 0.99, 1],
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    style={{ transformOrigin: "10.7px 14px" }}
                  />
                  <motion.rect
                    x="15.8"
                    y="11"
                    width="3"
                    height="6"
                    rx="1.5"
                    fill="var(--accent-light, #FBC2A2)"
                    animate={{ scaleY: [1, 1, 0.16, 1, 1] }}
                    transition={{
                      duration: 4.4,
                      times: [0, 0.92, 0.96, 0.99, 1],
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    style={{ transformOrigin: "17.3px 14px" }}
                  />
                </svg>
              </motion.div>
              <span className="brand-name">Momo</span>
            </div>

            <motion.button
              id="sideCollapse"
              type="button"
              className="icon-btn side-collapse"
              aria-label="Sembunyikan sidebar"
              title="Sembunyikan sidebar"
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.94 }}
              transition={{ duration: 0.18, ease: EASE_MOMO }}
              onClick={handleToggleSidebar}
            >
              <MomoIcon name="layout" size={16} />
            </motion.button>
          </motion.div>

          <motion.button
            id="newChat"
            type="button"
            className="row new"
            variants={sidePartVariants}
            whileHover={{ x: 2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE_MOMO }}
            onClick={handleNewChat}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="t">Obrolan baru</span>
          </motion.button>

          <motion.div
            className="groups sc"
            variants={reduceMotion ? SIDE_LIST_REDUCED : SIDE_LIST_VARIANTS}
          >
            {visibleSessions.length > 0 ? (
              <div id="chatsGroup" className="group">
                <div className="label momo-side-chats-label">
                  <span>
                    {workspaceView === "explore" ? "Explore" : "Percakapan"}
                    <sup
                      className="momo-rail-pop-count"
                      style={{ position: "relative", top: "-0.4em", verticalAlign: "baseline", marginInlineStart: 3, fontSize: 11 }}
                    >
                      {visibleSessions.length}
                    </sup>
                  </span>
                </div>
                <div id="chats">
                  <AnimatePresence initial={false}>
                    {visibleSessions.map((ses) => {
                      const isOn = activeSessionId === ses.id;
                      const dotColor = resolvePaletteTuple(
                        ses.look,
                        paletteOverrides,
                      )[1];
                      const rowKey = `side:${ses.id}`;
                      const isHovered = hoveredSessionKey === rowKey;
                      const isEditing =
                        editingSessionKey?.surface === "side" &&
                        editingSessionKey.id === ses.id;
                      const showActions = isHovered || isEditing;
                      return (
                        <motion.div
                          key={ses.id}
                          layout="position"
                          layoutDependency={visibleSessions}
                          role="button"
                          tabIndex={0}
                          data-session-id={ses.id}
                          style={{ "--ind": dotColor } as React.CSSProperties}
                          className={`row momo-session-row${isOn ? " on" : ""}${isEditing ? " is-editing" : ""}${showActions && !isEditing ? " is-actions-open" : ""}`}
                          whileTap={isEditing ? undefined : { scale: 0.988 }}
                          transition={{ duration: 0.16, ease: EASE_MOMO }}
                          onMouseEnter={() => setHoveredSessionKey(rowKey)}
                          onMouseLeave={() =>
                            setHoveredSessionKey((k) =>
                              k === rowKey ? null : k,
                            )
                          }
                          onContextMenu={(e) =>
                            openSkeuoCtxMenu(e, "session", ses.id, "side")
                          }
                          onClick={() => {
                            if (!isEditing) handleSelectSession(ses);
                          }}
                          onKeyDown={(e) => {
                            if (
                              !isEditing &&
                              e.target === e.currentTarget &&
                              (e.key === "Enter" || e.key === " ")
                            ) {
                              e.preventDefault();
                              handleSelectSession(ses);
                            }
                          }}
                        >
                          {isOn && (
                            <motion.span
                              layoutId="session-knob"
                              className="momo-session-knob"
                              aria-hidden="true"
                              transition={
                                reduceMotion
                                  ? { duration: 0 }
                                  : { type: "spring", stiffness: 480, damping: 40 }
                              }
                            />
                          )}
                          <span className="session-avatar">
                            <MomoMiniCanvas
                              look={ses.look}
                              size={30}
                              dead={offline && isOn}
                              darkFloor={dark}
                              animated={isOn}
                              paletteOverrides={paletteOverrides}
                            />
                          </span>
                          {isEditing ? (
                            <input
                              type="text"
                              className="momo-session-rename-input"
                              value={editingTitleDraft}
                              aria-label="Ubah nama percakapan"
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                setEditingTitleDraft(e.target.value)
                              }
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleCommitRenameSession(
                                    ses.id,
                                    editingTitleDraft,
                                  );
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  handleCancelRenameSession();
                                }
                              }}
                              onBlur={() =>
                                handleCommitRenameSession(
                                  ses.id,
                                  editingTitleDraft,
                                )
                              }
                            />
                          ) : (
                            <span className="t" title={ses.title}>
                              {ses.title}
                            </span>
                          )}
                          <SessionRowActions
                            visible={showActions}
                            isEditing={isEditing}
                            session={ses}
                            editingTitleDraft={editingTitleDraft}
                            onStartRename={(s) =>
                              handleStartRenameSession("side", s)
                            }
                            onCommitRename={handleCommitRenameSession}
                            onCancelRename={handleCancelRenameSession}
                            onDelete={handleDeleteSession}
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>
            ) : (
              <div className="group">
                <div className="label momo-side-chats-label">
                  <span>Percakapan</span>
                </div>
                <p
                  style={{
                    padding: "6px 10px",
                    fontSize: "12.5px",
                    lineHeight: "18px",
                    color: "var(--mute)",
                  }}
                >
                  Mulai tanya Momo untuk membuat sesi baru.
                </p>
              </div>
            )}
          </motion.div>

          <motion.div className="side-foot" variants={sidePartVariants}>
            <motion.button
              ref={profileBtnRef}
              id="profileMenuBtn"
              type="button"
              className="side-profile-btn"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              data-open={profileMenuOpen ? "1" : undefined}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.16, ease: EASE_MOMO }}
              onClick={() => {
                setBotMenuOpen(false);
                setBotFormOpen(false);
                setProfileMenuOpen((o) => !o);
              }}
            >
              <span className="side-profile-ava">
                <MomoMiniCanvas
                  look={activeLook}
                  size={28}
                  dead={offline}
                  darkFloor={dark}
                  paletteOverrides={paletteOverrides}
                />
                <i className={`profile-ava-dot${offline ? " off" : ""}`} />
              </span>
              <span className="side-profile-info">
                <strong>Alex</strong>
                <span>
                  {dark ? "Gelap" : "Terang"} · {offline ? "Offline" : "Online"}
                </span>
              </span>
              <svg
                className="side-profile-chev"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m7 15 5 5 5-5" />
                <path d="m7 9 5-5 5 5" />
              </svg>
            </motion.button>
          </motion.div>
        </motion.div>
      </aside>

      <AnimatePresence
        onExitComplete={() => setSidePhase((p) => (p === "railOut" ? "open" : p))}
      >
        {sidePhase === "closed" && (
          <motion.div
            ref={railRef}
            key="floating-mini-rail"
            className="momo-floating-rail is-detached"
            data-floating-rail="true"
            data-rail-mode="floating-left"
            variants={reduceMotion ? RAIL_REDUCED : RAIL_VARIANTS}
            initial="out"
            animate="in"
            exit="out"
            onContextMenu={(e) => {
              const el = e.target as HTMLElement | null;
              if (el?.closest("[data-rail-history-popover='true']")) return;
              openSkeuoCtxMenu(e, "dock");
            }}
          >
            <motion.button
              type="button"
              id="floatingSidebarOpen"
              className="momo-rail-btn"
              variants={railBtnVariants}
              aria-label="Tampilkan sidebar"
              title="Tampilkan sidebar"
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={openSidebar}
            >
              <House size={16} aria-hidden="true" />
            </motion.button>
            <span className="momo-rail-sep" aria-hidden="true" />
            <motion.button
              type="button"
              className="momo-rail-btn"
              variants={railBtnVariants}
              aria-label="Sesi baru"
              title="Sesi baru (+)"
              data-rail-new="true"
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => {
                setRailHistoryOpen(false);
                handleNewChat();
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </motion.button>
            <motion.button
              type="button"
              className={`momo-rail-btn${railHistoryOpen ? " is-active" : ""}`}
              variants={railBtnVariants}
              aria-label="Riwayat sesi"
              aria-expanded={railHistoryOpen}
              title="Riwayat percakapan"
              data-rail-history="true"
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => {
                setRailHistoryOpen((v) => !v);
                setRailSearch("");
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l3 2" />
              </svg>
            </motion.button>

            <AnimatePresence>
              {railHistoryOpen && (
                <motion.div
                  key="rail-history-popover"
                  data-rail-history-popover="true"
                  className="momo-rail-history-pop"
                  initial={{ opacity: 0, x: -8, scale: 0.96 }}
                  animate={{
                    opacity: 1,
                    x: 0,
                    scale: 1,
                    transition: { duration: 0.18, ease: EASE_MOMO },
                  }}
                  exit={{
                    opacity: 0,
                    x: -6,
                    scale: 0.97,
                    transition: { duration: 0.13, ease: EASE_EXIT },
                  }}
                >
                  <div className="momo-rail-pop-head">
                    <span className="momo-rail-pop-heading">
                      {workspaceView === "explore" ? "Explore" : "Percakapan"}
                      {visibleSessions.length > 0 && (
                        <span className="momo-rail-pop-count">
                          {visibleSessions.length}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="momo-rail-pop-new"
                      aria-label="Obrolan baru"
                      title="Obrolan baru"
                      onClick={() => {
                        setRailHistoryOpen(false);
                        handleNewChat();
                      }}
                    >
                      <Plus size={11.5} strokeWidth={2.3} />
                    </button>
                  </div>
                  {visibleSessions.length > 5 && (
                    <input
                      type="search"
                      className="momo-rail-pop-search"
                      placeholder={
                        workspaceView === "explore"
                          ? "Cari explore..."
                          : "Cari percakapan..."
                      }
                      value={railSearch}
                      onChange={(e) => setRailSearch(e.target.value)}
                      autoFocus
                    />
                  )}
                  {visibleSessions.length === 0 ? (
                    <div className="momo-rail-pop-empty">
                      {workspaceView === "explore"
                        ? "Belum ada sesi explore."
                        : "Belum ada percakapan."}
                    </div>
                  ) : (
                    <div className="momo-rail-pop-list sc">
                      <AnimatePresence initial={false}>
                        {visibleSessions
                          .filter((ses) => {
                            const q = railSearch.trim().toLowerCase();
                            if (!q) return true;
                            const rLabel = getRoleWorkspaceConfig(
                              ses.look,
                            ).label.toLowerCase();
                            return (
                              ses.title.toLowerCase().includes(q) ||
                              rLabel.includes(q)
                            );
                          })
                          .slice(0, 14)
                          .map((ses) => {
                            const isOn = activeSessionId === ses.id;
                            const dotColor = resolvePaletteTuple(
                              ses.look,
                              paletteOverrides,
                            )[1];
                            const mins = Math.max(
                              0,
                              Math.floor(
                                (Date.now() - (ses.createdAt || Date.now())) /
                                  60000,
                              ),
                            );
                            const ageStr =
                              mins < 2
                                ? "baru"
                                : mins < 60
                                  ? `${mins}m`
                                  : mins < 1440
                                    ? `${Math.floor(mins / 60)}j`
                                    : `${Math.floor(mins / 1440)}h`;
                            const railKey = `rail:${ses.id}`;
                            const isHovered = hoveredSessionKey === railKey;
                            const isEditing =
                              editingSessionKey?.surface === "rail" &&
                              editingSessionKey.id === ses.id;
                            const showActions = isHovered || isEditing;
                            const exploreTurns =
                              workspaceView === "explore"
                                ? (ses.exploreMessages ?? []).filter((m) => m.role === "user")
                                : [];
                            return [
                              <motion.div
                                key={`rail-${ses.id}`}
                                layout="position"
                                role="button"
                                tabIndex={0}
                                data-rail-session-id={ses.id}
                                className={`momo-rail-pop-item${isOn ? " is-active" : ""}${isEditing ? " is-editing" : ""}${showActions && !isEditing ? " is-actions-open" : ""}`}
                                onMouseEnter={() =>
                                  setHoveredSessionKey(railKey)
                                }
                                onMouseLeave={() =>
                                  setHoveredSessionKey((k) =>
                                    k === railKey ? null : k,
                                  )
                                }
                                onContextMenu={(e) =>
                                  openSkeuoCtxMenu(e, "session", ses.id, "rail")
                                }
                                onClick={() => {
                                  if (!isEditing) {
                                    setRailHistoryOpen(false);
                                    handleSelectSession(ses);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (
                                    !isEditing &&
                                    e.target === e.currentTarget &&
                                    (e.key === "Enter" || e.key === " ")
                                  ) {
                                    e.preventDefault();
                                    setRailHistoryOpen(false);
                                    handleSelectSession(ses);
                                  }
                                }}
                              >
                                <span
                                  className="momo-rail-pop-avatar"
                                  style={
                                    { "--ind": dotColor } as React.CSSProperties
                                  }
                                >
                                  <MomoMiniCanvas
                                    look={ses.look}
                                    size={18}
                                    dead={offline && isOn}
                                    darkFloor={dark}
                                    animated={isOn}
                                    paletteOverrides={paletteOverrides}
                                  />
                                </span>
                                <span className="momo-rail-pop-main">
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      className="momo-session-rename-input is-compact"
                                      value={editingTitleDraft}
                                      aria-label="Ubah nama percakapan"
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) =>
                                        setEditingTitleDraft(e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          handleCommitRenameSession(
                                            ses.id,
                                            editingTitleDraft,
                                          );
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          handleCancelRenameSession();
                                        }
                                      }}
                                      onBlur={() =>
                                        handleCommitRenameSession(
                                          ses.id,
                                          editingTitleDraft,
                                        )
                                      }
                                    />
                                  ) : (
                                    <>
                                      <span
                                        className="momo-rail-pop-title"
                                        title={ses.title}
                                      >
                                        {ses.title}
                                      </span>
                                      {isOn && (
                                        <span
                                          className="momo-rail-pop-dot"
                                          aria-hidden="true"
                                        />
                                      )}
                                      <span className="momo-rail-pop-age">
                                        {ageStr}
                                      </span>
                                    </>
                                  )}
                                </span>
                                <SessionRowActions
                                  visible={showActions}
                                  isEditing={isEditing}
                                  compact
                                  session={ses}
                                  editingTitleDraft={editingTitleDraft}
                                  onStartRename={(s) =>
                                    handleStartRenameSession("rail", s)
                                  }
                                  onCommitRename={handleCommitRenameSession}
                                  onCancelRename={handleCancelRenameSession}
                                  onDelete={handleDeleteSession}
                                />
                              </motion.div>,
                              exploreTurns.length > 0 && (
                                <div
                                  key={`rail-sub-${ses.id}`}
                                  className="momo-rail-pop-sub"
                                  role="group"
                                  aria-label={`Explore di ${ses.title}`}
                                >
                                  {exploreTurns.slice(-8).map((m) => {
                                    const turnIdx = exploreTurns.indexOf(m);
                                    return (
                                      <button
                                        key={m.id}
                                        type="button"
                                        className="momo-rail-pop-subitem"
                                        data-rail-explore-turn={turnIdx}
                                        title={m.text}
                                        onClick={() => {
                                          setRailHistoryOpen(false);
                                          handleSelectSession(ses);
                                          setExploreFocus({ idx: turnIdx, seq: Date.now() });
                                        }}
                                      >
                                        {m.text}
                                      </button>
                                    );
                                  })}
                                </div>
                              ),
                            ];
                          })}
                      </AnimatePresence>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Workspace */}
      <main ref={mainRef} className="main">
        <MainChevronBackdrop
          activeLook={activeLook}
          paletteOverrides={paletteOverrides}
          started={backdropStarted}
          busy={busy}
          dark={dark}
          offline={offline}
          sideHidden={sideHidden}
        />
        <canvas
          ref={wipeCanvasRef}
          className="theme-matrix-wipe"
          aria-hidden="true"
        />
        <header
          className="bar top momo-top-bare"
          data-workspace-view={workspaceView}
        >
          {/* Top header sidebar toggle - HANYA muncul saat sidebar terbuka atau mobile; saat sidebar tersembunyi (sideHidden), akses sidebar sepenuhnya lewat floating mini rail avatar di kiri agar tidak dobel tombol */}
          {(!sideHidden || isMobile) && (
            <motion.button
              id="sideToggle"
              type="button"
              className="icon-btn side-toggle"
              aria-label="Tampilkan atau sembunyikan sidebar"
              title="Sembunyikan sidebar"
              aria-expanded={isMobile ? sideOpen : !sideHidden}
              initial={{ opacity: 0, scale: 0.88 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.88 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              transition={{ duration: 0.18, ease: EASE_MOMO }}
              onClick={handleToggleSidebar}
            >
              <MomoIcon name="layout" size={18} />
            </motion.button>
          )}

          <div
            className={`momo-top-crest-trigger${crestCollapsed ? " is-collapsed" : ""}`}
            onMouseEnter={openCrest}
            onMouseLeave={scheduleCloseCrest}
            onClick={() => {
              if (crestCollapsed) openCrest();
            }}
            onFocusCapture={openCrest}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                scheduleCloseCrest();
              }
            }}
          >
            <motion.span
              className="momo-top-crest-peek"
              aria-hidden="true"
              initial={false}
              animate={
                crestCollapsed
                  ? { opacity: 0.65, scaleX: 1, y: 0 }
                  : { opacity: 0, scaleX: 0.6, y: -8 }
              }
              transition={{ duration: 0.22, ease: EASE_MOMO }}
            />
            <motion.div
              className="momo-top-crest-motion"
              initial={false}
              animate={
                crestCollapsed
                  ? { y: -48, opacity: 0, scale: 0.96 }
                  : { y: 0, opacity: 1, scale: 1 }
              }
              transition={{
                type: "spring",
                stiffness: 420,
                damping: 32,
                mass: 0.78,
              }}
              style={{ pointerEvents: crestCollapsed ? "none" : "auto" }}
            >
              <motion.div
                ref={dockScope}
                className="momo-top-crest-dock"
                style={{ transformOrigin: "50% 0%" }}
              >
                {(() => {
                  const shoulder = 44;
                  const navW = concaveDockSize.w;
                  const navH = concaveDockSize.h;
                  const W = navW + shoulder * 2;
                  const H = navH + 8;
                  const x0 = 0;
                  const x1 = shoulder;
                  const x2 = shoulder + navW;
                  const x3 = W;
                  const k = +(shoulder * 0.56).toFixed(2);
                  const yTop = 0.6;
                  const yBot = +(H - 0.6).toFixed(2);
                  const fillPath = `M 0 0 L ${W} 0 L ${x3} ${yTop} C ${x3 - k} ${yTop}, ${x2 + k} ${yBot}, ${x2} ${yBot} L ${x1} ${yBot} C ${x1 - k} ${yBot}, ${x0 + k} ${yTop}, ${x0} ${yTop} Z`;
                  const strokePath = `M ${x0} ${yTop} C ${x0 + k} ${yTop}, ${x1 - k} ${yBot}, ${x1} ${yBot} L ${x2} ${yBot} C ${x2 + k} ${yBot}, ${x3 - k} ${yTop}, ${x3} ${yTop}`;
                  return (
                    <svg
                      className="momo-top-concave-svg"
                      viewBox={`0 0 ${W} ${H}`}
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <defs>
                        <linearGradient
                          id="momoTopConcaveGrad"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop offset="0%" stopColor="var(--crest-grad-top)" />
                          <stop
                            offset="48%"
                            stopColor="var(--crest-grad-mid)"
                          />
                          <stop
                            offset="100%"
                            stopColor="var(--crest-grad-bot)"
                          />
                        </linearGradient>
                        <linearGradient
                          id="momoTopCeilingShadow"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="var(--crest-ceiling-shadow)"
                          />
                          <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
                        </linearGradient>
                        <filter
                          id="momoTopInnerBlur"
                          x="-10%"
                          y="-10%"
                          width="120%"
                          height="140%"
                        >
                          <feGaussianBlur stdDeviation="2.6" />
                        </filter>
                        <clipPath id="momoTopConcaveClip">
                          <path d={fillPath} />
                        </clipPath>
                      </defs>
                      <g clipPath="url(#momoTopConcaveClip)">
                        <path
                          className="momo-top-concave-fill"
                          d={fillPath}
                          fill="url(#momoTopConcaveGrad)"
                        />
                        <rect
                          x="0"
                          y="0"
                          width={W}
                          height="11"
                          fill="url(#momoTopCeilingShadow)"
                        />
                        <path
                          className="momo-top-concave-inner-shadow"
                          d={strokePath}
                          filter="url(#momoTopInnerBlur)"
                        />
                        <path
                          className="momo-top-concave-specular"
                          d={`M ${x0 + 1} ${yTop + 0.6} C ${x0 + k} ${yTop + 0.6}, ${x1 - k} ${yBot - 1.1}, ${x1} ${yBot - 1.1} L ${x2} ${yBot - 1.1} C ${x2 + k} ${yBot - 1.1}, ${x3 - k} ${yTop + 0.6}, ${x3 - 1} ${yTop + 0.6}`}
                        />
                      </g>
                      <path
                        className="momo-top-concave-stroke"
                        d={strokePath}
                      />
                    </svg>
                  );
                })()}
                <nav
                  ref={workspaceTabsCallbackRef}
                  id="workspaceTabs"
                  className="momo-view-switcher"
                  role="tablist"
                  aria-label="Mode ruang kerja"
                >
                  {(
                    [
                      { id: "explore", label: "Explore" },
                      { id: "chat", label: "Chat" },
                      { id: "board", label: roleConfig.boardLabel },
                    ] as const
                  ).map((tab) => {
                    const isSelected = workspaceView === tab.id;
                    return (
                      <motion.button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        data-workspace-tab={tab.id}
                        className={`momo-view-tab${isSelected ? " is-active" : ""}`}
                        whileHover={{ y: -0.8 }}
                        whileTap={{ scale: 0.955 }}
                        transition={{ duration: 0.14, ease: EASE_MOMO }}
                        onClick={() => switchWorkspaceView(tab.id)}
                      >
                        {isSelected && (
                          <motion.span
                            layoutId="workspace-tab-pill"
                            className="momo-view-tab-pill"
                            transition={SPRING_THUMB}
                          />
                        )}
                        <span className="momo-view-tab-inner">
                          {tab.id === "explore" ? (
                            <svg
                              viewBox="0 0 16 16"
                              width="12"
                              height="12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            >
                              <circle cx="8" cy="8" r="5.5" />
                              <polygon
                                points="10.2 5.8 8.9 9.1 5.8 10.2 7.1 6.9"
                                fill="currentColor"
                                stroke="none"
                              />
                            </svg>
                          ) : tab.id === "chat" ? (
                            <svg
                              viewBox="0 0 16 16"
                              width="12"
                              height="12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M3 4.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6.5L3.5 13.8V4.5Z" />
                            </svg>
                          ) : (
                            <svg
                              viewBox="0 0 16 16"
                              width="12"
                              height="12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <rect
                                x="2.2"
                                y="2.8"
                                width="3.2"
                                height="10.4"
                                rx="0.9"
                              />
                              <rect
                                x="6.5"
                                y="2.8"
                                width="3.2"
                                height="7.4"
                                rx="0.9"
                              />
                              <rect
                                x="10.8"
                                y="2.8"
                                width="3.2"
                                height="8.8"
                                rx="0.9"
                              />
                            </svg>
                          )}
                          <span>{tab.label}</span>
                          {isSelected && (
                            <motion.span
                              layoutId="workspace-tab-led"
                              className="momo-view-tab-led"
                              transition={SPRING_THUMB}
                            />
                          )}
                        </span>
                      </motion.button>
                    );
                  })}
                </nav>
              </motion.div>
            </motion.div>
          </div>
        </header>

        <AnimatePresence initial={false}>
          <motion.div
            key={workspaceView}
            data-workspace-view={workspaceView}
            className={`momo-workspace-stage is-fullspan${started ? " is-started" : ""}`}
            initial="initial"
            animate="animate"
            exit="exit"
            variants={{
              initial: { opacity: 0, x: viewDir * 18 },
              animate: {
                opacity: 1,
                x: 0,
                transition: { duration: 0.28, ease: EASE_MOMO },
              },
              exit: {
                opacity: 0,
                x: -viewDir * 18,
                pointerEvents: "none",
                transition: { duration: 0.22, ease: EASE_MOMO },
              },
            }}
          >
            <AnimatePresence initial={false}>
              {workspaceView === "chat" && started && sidePhase === "closed" && (
                <BlinkingSquares
                  key="chat-ambient-l"
                  className="chat-ambient-grid is-left"
                  direction="left"
                  gridSize={72}
                  squareSize={0.24}
                  fadeStart={0.55}
                  intensity={dark ? 0.55 : 0.9}
                  color={dark ? accentTuple[1] : accentTuple[2]}
                />
              )}

            </AnimatePresence>
            {workspaceView === "explore" ? (
              <BoardItemStateContext.Provider value={boardStickerStates}>
                <ExploreWorkspaceView
                roleId={activeLook}
                session={activeSession}
                busy={busy}
                slotExploreRef={slotExploreRef}
                onSubmitPrompt={(p, interaction, targetChannel) => {
                  if (targetChannel === "chat") {
                    switchWorkspaceView("chat");
                  }
                  void submitPrompt(p, {
                    ...(interaction ? { uiInteraction: interaction } : {}),
                    ...(targetChannel ? { targetChannel } : {}),
                  });
                }}
                onRetryTurn={(botMsg) => handleRetryMessage(botMsg, "explore")}
                onOpenBoard={() => switchWorkspaceView("board")}
                focusTurn={exploreFocus}
                pinnedTitles={pinnedTitles}
                onTogglePinItem={handleTogglePinItem}
              />
              </BoardItemStateContext.Provider>
            ) : workspaceView === "board" ? (
              <RoleBoardWorkspaceView
                roleLabel={roleConfig.label}
                sessionTitle={activeSession?.title || ""}
                boardLabel={roleConfig.boardLabel}
                columns={sessionBoardState.columns}
                items={sessionBoardState.items}
                reshapeChips={roleConfig.boardReshapeChips}
                busy={busy}
                onMoveItem={handleMoveBoardItem}
                onAddItem={handleAddBoardItem}
                onUpdateItem={handleUpdateBoardItem}
                onDeleteItem={handleDeleteBoardItem}
                onSwitchToChat={() => switchWorkspaceView("chat")}
                onPromptAction={(p, interaction) => {
                  const targetChannel: "chat" | "explore" | undefined =
                    interaction?.action === "deep_dive" ? "chat" : undefined;
                  if (interaction?.action === "deep_dive") {
                    switchWorkspaceView("chat");
                  }
                  void submitPrompt(p, {
                    ...(interaction ? { uiInteraction: interaction } : {}),
                    ...(targetChannel ? { targetChannel } : {}),
                  });
                }}
              />
            ) : (
              <div
                id="thread"
                ref={threadCallbackRef}
                className={`thread sc${started ? " started" : ""}${busy ? " busy" : ""}${offline ? " offline" : ""}`}
              >
                <AnimatePresence mode="wait">
                  {!started ? (
                    <motion.section
                      key="empty"
                      id="empty"
                      className="empty"
                      aria-label="Sambutan Momo"
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      variants={{
                        initial: { opacity: 0 },
                        animate: {
                          opacity: 1,
                          transition: { duration: 0.24, ease: EASE_MOMO },
                        },
                        exit: {
                          opacity: 0,
                          transition: { duration: 0.16, ease: EASE_MOMO },
                        },
                      }}
                    >
                      <motion.div
                        className="hero-head"
                        variants={{
                          initial: { opacity: 0, y: 12 },
                          animate: {
                            opacity: 1,
                            y: 0,
                            transition: { duration: 0.26, ease: EASE_MOMO },
                          },
                          exit: {
                            opacity: 0,
                            y: -10,
                            transition: { duration: 0.18, ease: EASE_MOMO },
                          },
                        }}
                      >
                        <div className="hero-greet">
                          {exploreBridgeTopic
                            ? `Dari Explore: ${exploreBridgeTopic}`
                            : hydrationSafeGreeting}
                        </div>
                        <HeroAskLockup
                          roleId={activeLook}
                          botName={activeBot.name}
                          isCustomBot={Boolean(activeBot.own)}
                          menuOpen={botMenuOpen}
                          onToggleMenu={() => {
                            setBotFormOpen(false);
                            setBotMenuOpen((o) => !o);
                          }}
                          buttonRef={botPickBtnRef}
                        />
                      </motion.div>
                      <div
                        id="slotBig"
                        ref={slotBigRef}
                        className="hero-slot big"
                      />
                      <AnimatePresence mode="popLayout">
                        <motion.div
                          key={`hero-chat-sugg-${activeLook}-${exploreBridgeTopic ? "ctx" : "base"}`}
                          className="hero-chat-sugg-wrap"
                          data-role-mode={roleConfig.presentation.editorialMode}
                          data-chat-context-bridge={
                            exploreBridgeTopic ? "true" : "false"
                          }
                          initial="initial"
                          animate="animate"
                          exit="exit"
                          variants={{
                            initial: { opacity: 0, y: 12 },
                            animate: {
                              opacity: 1,
                              y: 0,
                              transition: {
                                duration: 0.24,
                                delay: 0.04,
                                ease: EASE_MOMO,
                              },
                            },
                            exit: {
                              opacity: 0,
                              y: 12,
                              transition: { duration: 0.16, ease: EASE_MOMO },
                            },
                          }}
                        >
                          <span className="hero-chat-cue">
                            {exploreBridgeTopic
                              ? `tanya apa saja soal “${exploreBridgeTopic}” ~`
                              : roleConfig.chatHeroCue}
                          </span>
                          <div className="hero-chat-chips">
                            {contextualChatSuggestions.map((item, idx) => (
                              <motion.button
                                key={`${activeLook}-${item.tag}-${idx}`}
                                type="button"
                                data-chat-suggestion={idx}
                                className="hero-chat-chip"
                                title={item.prompt}
                                variants={{
                                  initial: { opacity: 0, y: 10, scale: 0.96 },
                                  animate: {
                                    opacity: 1,
                                    y: 0,
                                    scale: 1,
                                    transition: {
                                      duration: 0.22,
                                      delay: 0.05 + idx * 0.045,
                                      ease: EASE_MOMO,
                                    },
                                  },
                                  exit: {
                                    opacity: 0,
                                    y: 8,
                                    scale: 0.97,
                                    transition: {
                                      duration: 0.14,
                                      ease: EASE_MOMO,
                                    },
                                  },
                                }}
                                whileHover={{ y: -2.5, scale: 1.02 }}
                                whileTap={{ scale: 0.97 }}
                                onClick={() => void submitPrompt(item.prompt)}
                              >
                                <span className="hero-chat-chip-tag">
                                  {item.tag}
                                </span>
                                <span className="hero-chat-chip-label">
                                  {item.label}
                                </span>
                                <span
                                  className="hero-chat-chip-arr"
                                  aria-hidden="true"
                                >
                                  ↗
                                </span>
                              </motion.button>
                            ))}
                          </div>
                        </motion.div>
                      </AnimatePresence>
                    </motion.section>
                  ) : (
                    <React.Fragment key="conversation">
                      <BoardItemStateContext.Provider value={boardStickerStates}>
                        <MessageThread
                        key={activeSessionId || "own"}
                        messages={displayedMessages}
                        speakingMsgId={speakingMsgId}
                        paletteOverrides={paletteOverrides}
                        role={activeLook}
                        allBots={allBots}
                        activeBotId={activeBot.id}
                        forcedEditRequest={forcedEditRequest}
                        messagesRef={messagesScrollRef}
                        onCopy={handleMessageCopy}
                        onSpeakToggle={handleSpeakToggle}
                        onRetry={handleRetryMessage}
                        onEditUserMessage={handleEditUserMessage}
                        onPromptAction={handlePromptAction}
                        onUiInteraction={handleUiInteraction}
                        onRoleGateEditQuery={handleRoleGateEditQuery}
                        onRoleGateSwitchRole={handleRoleGateSwitchRole}
                        onRoleGateStay={handleRoleGateStay}
                        onAvatarSwitchRole={handleSelectBot}
                        pinnedTitles={pinnedTitles}
                        onTogglePinItem={handleTogglePinItem}
                        onWriteProposalChange={handleWriteProposalChange}
                      />
                      </BoardItemStateContext.Provider>
                    </React.Fragment>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <motion.footer
          ref={dockCallbackRef}
          className={`dock${workspaceView === "explore" && !exploreStarted ? " is-explore-hidden" : ""}`}
          initial={false}
          animate={{
            y: workspaceView === "explore" && !exploreStarted ? 156 : 0,
            opacity: workspaceView === "explore" && !exploreStarted ? 0 : 1,
          }}
          transition={{ duration: 0.34, ease: EASE_MOMO }}
          onAnimationComplete={() => {
            if (typeof window !== "undefined") {
              window.dispatchEvent(new Event("momo:slot-sync"));
            }
          }}
          style={{
            pointerEvents:
              workspaceView === "explore" && !exploreStarted
                ? "none"
                : undefined,
          }}
        >
          <motion.div
            className="composer-shell"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE_MOMO, delay: 0.15 }}
          >
            <MomoComposer
              snapshot={composerSnapshot}
              speechSupported={speechSupported}
              selectedModelId={selectedModelId}
              reasoningEffort={reasoningEffort}
              onSelectModel={(mid) => {
                selectedModelRef.current = mid;
                setSelectedModelId(mid);
                const meta = resolveModelMeta(mid);
                const nextEffort = normalizeReasoningEffort(
                  meta,
                  reasoningEffortRef.current,
                );
                reasoningEffortRef.current = nextEffort;
                setReasoningEffort(nextEffort);
                persistModelPrefs(mid, nextEffort);
              }}
              onChangeReasoningEffort={(effort) => {
                const meta = resolveModelMeta(selectedModelRef.current);
                const nextEffort = normalizeReasoningEffort(meta, effort);
                reasoningEffortRef.current = nextEffort;
                setReasoningEffort(nextEffort);
                persistModelPrefs(selectedModelRef.current, nextEffort);
              }}
              onInputChange={(val) => {
                clearDictateError();
                setInputValue(val);
              }}
              onSubmit={(txt, atts) => {
                clearDictateError();
                void submitPrompt(txt, { attachments: atts });
              }}
              onStop={handleStop}
              onToggleMic={handleToggleMic}
              onCancelDictation={() => stopDictationCleanup()}
              onDismissDictateError={clearDictateError}
              onFormElement={(el) => {
                composerRef.current = el as HTMLDivElement | null;
              }}
              slotPerchRef={slotPerchRef}
              slotInputLeftRef={slotInputLeftRef}
            />
          </motion.div>
        </motion.footer>
      </main>

      {/* Mobile Scrim */}
      <div
        id="scrim"
        className={`scrim${sideOpen ? " show" : ""}`}
        onClick={() => {
          setSideOpen(false);
        }}
      />

      {/* Floating Hero WebGL Canvas */}
      <MomoHeroCanvas canvasRef={heroCanvasRef} />

      {/* Anchored Bot Role Menu, Custom Bot Form & Bottom Profile Menu */}
      <BotMenuPopover
        open={botMenuOpen}
        anchorRef={botPickBtnRef}
        bots={allBots}
        activeBotId={activeBot.id}
        paletteOverrides={paletteOverrides}
        onSelectBot={handleSelectBot}
        onDeleteBot={handleDeleteBot}
        onOpenNewBot={() => setBotFormOpen(true)}
        onClose={() => setBotMenuOpen(false)}
      />

      <BotFormPopover
        open={botFormOpen}
        anchorRef={botPickBtnRef}
        paletteOverrides={paletteOverrides}
        onCreateBot={handleCreateBot}
        onClose={() => setBotFormOpen(false)}
      />

      <ProfileMenuPopover
        open={profileMenuOpen}
        anchorRef={profileBtnRef}
        dark={dark}
        offline={offline}
        autoSpeak={autoSpeak}
        activeLook={activeLook}
        paletteOverrides={paletteOverrides}
        activeBotName={activeBot.name}
        activeRoleColor={resolvePaletteTuple(activeLook, paletteOverrides)[1]}
        hasActiveMessages={started}
        onSetTheme={setThemeMode}
        onSetOffline={(off) => {
          setOffline(off);
          if (!off) stage.wakeFromIdle();
        }}
        onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
        onResetSession={handleNewChat}
        onClose={() => setProfileMenuOpen(false)}
      />

      {/* Skeuomorphic Context Menu for Floating Dock & Chat History Rows */}
      <AnimatePresence>
        {skeuoCtxMenu &&
          (() => {
            const targetSession =
              skeuoCtxMenu.kind === "session" && skeuoCtxMenu.sessionId
                ? sessions.find((s) => s.id === skeuoCtxMenu.sessionId)
                : undefined;
            return (
              <motion.div
                key="skeuo-ctx-menu"
                data-skeuo-ctx-menu="true"
                role="menu"
                className="momo-skeuo-ctx-menu"
                style={{ left: skeuoCtxMenu.x, top: skeuoCtxMenu.y }}
                initial={{ opacity: 0, scale: 0.95, y: -3 }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  y: 0,
                  transition: { duration: 0.16, ease: EASE_MOMO },
                }}
                exit={{
                  opacity: 0,
                  scale: 0.96,
                  y: -2,
                  transition: { duration: 0.12, ease: EASE_EXIT },
                }}
              >
                {skeuoCtxMenu.kind === "session" && targetSession ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="open"
                      className="momo-skeuo-ctx-item"
                      onClick={() => {
                        setSkeuoCtxMenu(null);
                        setRailHistoryOpen(false);
                        handleSelectSession(targetSession);
                      }}
                    >
                      <MessageSquare size={13} strokeWidth={2} />
                      <span>Buka percakapan</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="rename"
                      className="momo-skeuo-ctx-item"
                      onClick={() => {
                        const surf = skeuoCtxMenu.surface ?? "side";
                        if (surf === "rail") setRailHistoryOpen(true);
                        handleStartRenameSession(surf, targetSession);
                      }}
                    >
                      <Pencil size={13} strokeWidth={2} />
                      <span>Ubah nama</span>
                    </button>
                    <div className="momo-skeuo-ctx-sep" aria-hidden="true" />
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="delete"
                      className="momo-skeuo-ctx-item is-danger"
                      onClick={() => handleDeleteSession(targetSession.id)}
                    >
                      <Trash2 size={13} strokeWidth={2} />
                      <span>Hapus percakapan</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="show-sidebar"
                      className="momo-skeuo-ctx-item"
                      onClick={() => {
                        setSkeuoCtxMenu(null);
                        openSidebar();
                      }}
                    >
                      <PanelLeft size={13} strokeWidth={2} />
                      <span>Tampilkan sidebar</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="new-chat"
                      className="momo-skeuo-ctx-item"
                      onClick={() => {
                        setSkeuoCtxMenu(null);
                        setRailHistoryOpen(false);
                        handleNewChat();
                      }}
                    >
                      <Plus size={13} strokeWidth={2} />
                      <span>Obrolan baru</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-ctx-action="toggle-history"
                      className="momo-skeuo-ctx-item"
                      onClick={() => {
                        setSkeuoCtxMenu(null);
                        setRailHistoryOpen((v) => !v);
                      }}
                    >
                      <History size={13} strokeWidth={2} />
                      <span>
                        {railHistoryOpen
                          ? "Tutup riwayat"
                          : "Riwayat percakapan"}
                      </span>
                    </button>
                  </>
                )}
              </motion.div>
            );
          })()}
      </AnimatePresence>
    </div>
  );
};
