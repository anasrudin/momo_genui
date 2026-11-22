import type { WriteProposalCard, WriteProposalRow } from "@/lib/famhub/proposalCard";

export type RolePaletteTuple = readonly [string, string, string, string];

export type LookId =
  | "rest"
  | "cook"
  | "investigate"
  | "write"
  | "dead"
  | "builder"
  | "music"
  | "tutor"
  | "garden"
  | "designer"
  | "director"
  | "coach"
  | "traveller"
  | "money"
  | "planner"
  | "captain"
  | "tester"
  | "guard"
  | "bug";

export type MoodId =
  | "neutral"
  | "happy"
  | "focused"
  | "curious"
  | "unsure"
  | "concerned"
  | "listening"
  | "thinking";

export type ExpressionId =
  | "happy"
  | "surprised"
  | "dizzy"
  | "sparkle"
  | "wink"
  | "sleepy"
  | "sorry"
  | "working"
  | "speaking"
  | "listening";

export interface SourceItem {
  title: string;
  url: string;
  description?: string;
  snippet?: string;
  domain?: string;
  imageUrl?: string;
  /** The article's own lead photo (og:image), kept apart from the verified photo pool. NewsFeed only. */
  articleImageUrl?: string;
  publishedDate?: string;
}

export interface BotIdentity {
  id: string;
  look: string;
  name: string;
  job: string;
  own?: boolean;
}

export interface TextPart {
  id: string;
  kind: "text";
  text: string;
  streaming?: boolean;
}

export type GenUiStatus = "shell" | "building" | "ready" | "aborted" | "error";

export type GenUiToneHint =
  | "accent"
  | "ok"
  | "warn"
  | "bad"
  | "neutral"
  | string;

export interface GenUiCardItem {
  kicker?: string;
  title: string;
  body: string;
  meta?: string;
  badge?: string;
  badgeTone?: GenUiToneHint;
  lit?: boolean;
  imageUrl?: string;
  imageQuery?: string;
  imageAlt?: string;
  sourceUrl?: string;
  prompt?: string;
}

export interface GenUiStepItem {
  title: string;
  note?: string;
  meta?: string;
  active?: boolean;
}

/**
 * Minimal backwards-compatibility specs retained strictly for extracting legacy
 * localStorage sessions (`momo.sessions.v1`) into Pinboard items.
 */
export type GenUiBlockSpec =
  | {
      type: "cards";
      columns?: 2 | 3;
      items: GenUiCardItem[];
    }
  | {
      type: "tabs";
      tabs: Array<{
        id: string;
        label: string;
        blocks: GenUiBlockSpec[];
      }>;
    }
  | {
      type: "steps";
      heading?: string;
      items: GenUiStepItem[];
    }
  | {
      type: "editorial_cards";
      heading?: string;
      handNote?: string;
      items: Array<{
        slot?: string;
        title: string;
        body?: string;
        metric?: string;
        handNote?: string;
        pin?: "star" | "alert" | "check" | "sun" | "heart";
        tone?: GenUiToneHint;
        imageUrl?: string;
        imageQuery?: string;
        imageAlt?: string;
        sourceUrl?: string;
        prompt?: string;
      }>;
    }
  | {
      type: "board_preview";
      title: string;
      handNote?: string;
      boardLabel?: string;
      columns: Array<{
        id: string;
        title: string;
        subtitle?: string;
        items: Array<{
          slot?: string;
          title: string;
          note?: string;
          metric?: string;
          pin?: "star" | "alert" | "check" | "sun" | "heart";
        }>;
      }>;
    };

export type WorkspaceViewId = "explore" | "chat" | "board";

export type TaskTransition =
  | "new_task"
  | "continue_task"
  | "refine_task"
  | "change_direction";

export type WorkspaceCompositionMode = "response_ui" | "persistent_workspace";

export type WorkspaceUpdateStrategy =
  | "create"
  | "append"
  | "update"
  | "replace";

export interface WorkspaceSnapshotPayload {
  columns: Array<{ id: string; title: string }>;
  items: Array<{ title: string; columnId: string; done?: boolean; slot?: string }>;
  pinnedTitles: string[];
  exploreTurnCount: number;
  existingExploreComponents: string[];
}

export interface UiPlanSummaryMeta {
  compositionMode: WorkspaceCompositionMode;
  taskTransition: TaskTransition;
  updateStrategy: WorkspaceUpdateStrategy;
  archivedPriorOnPivot?: boolean;
  activeCapabilities: string[];
}

export interface UiInteractionPayload {
  partId?: string;
  blockId?: string;
  blockType: string;
  action: string;
  label: string;
  value?: string | number | Record<string, unknown>;
  prompt: string;
}

export interface WorkspaceBoardColumn {
  id: string;
  title: string;
  subtitle?: string;
  dateLabel?: string;
}

export interface WorkspaceBoardItem {
  id: string;
  columnId: string;
  slot?: string;
  title: string;
  subtitle?: string;
  handNote?: string;
  metric?: string;
  pin?: "star" | "alert" | "check" | "sun" | "heart";
  sticker?: "heart" | "star" | "check" | "sun";
  imageUrl?: string;
  imageQuery?: string;
  starred?: boolean;
  done?: boolean;
  tone?: GenUiToneHint;
  accentHex?: string;
  sessionId?: string;
  sessionTitle?: string;
}

export interface ToolPart {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  label?: string;
  summary?: string;
  argsPreview?: string;
  query?: string;
  provider?: string;
  domains?: string[];
  resultsPreview?: Array<{ title: string; url: string; domain: string; imageUrl?: string }>;
  imagePreviews?: Array<{ imageUrl: string; caption?: string; sourceUrl?: string }>;
  startedAt?: number;
  elapsedMs?: number;
  status: "running" | "done";
}

export interface GenUiBlockItem {
  id: string;
  html?: string;
  spec?: GenUiBlockSpec;
}

export interface GenUiPart {
  id: string;
  kind: "gen_ui";
  toolCallId: string;
  title: string;
  eyebrow?: string;
  tone?: string;
  contained?: boolean;
  outline?: string[];
  css: string;
  blocks: GenUiBlockItem[];
  openuiLang?: string;
  openuiMediaMap?: Record<string, { url: string; sourceUrl?: string }>;
  status: GenUiStatus;
  error?: string;
}

export type MessagePart = TextPart | GenUiPart | ToolPart;

export type ComposerAttachmentKind = "image" | "note" | "event" | "voice" | "docs";

export interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: ComposerAttachmentKind;
  previewUrl?: string;
  imageDataUrl?: string;
  extractedText?: string;
  status: "uploading" | "ready";
  accent?: string;
}

export interface RoleGatePayload {
  activeLook: string;
  activeRoleName: string;
  suggestedLook: string;
  suggestedRoleName: string;
  originalQuery: string;
  userMsgId: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "momo" | "system";
  text: string;
  attachments?: ComposerAttachment[];
  parts?: MessagePart[];
  streaming?: boolean;
  look?: string;
  previousLook?: string;
  botLabel?: string;
  sources?: SourceItem[];
  /** FamHub writes proposed in this turn, with what became of each (see `lib/famhub/proposalCard.ts`). */
  writeProposals?: WriteProposalCard[];
  /** Image URLs the backend verified for this turn. Defined (possibly empty) on every turn recorded since the pool was introduced. */
  imagePool?: string[];
  showActions?: boolean;
  retryPrompt?: string;
  systemKind?: "note" | "drop" | "handoff";
  roleGate?: RoleGatePayload;
  reasoningText?: string;
  reasoningStreaming?: boolean;
  hasNativeReasoning?: boolean;
  modelHasReasoning?: boolean;
  activityLabel?: string;
  startedAt?: number;
  elapsedSec?: number;
  tokenCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  activeModelId?: string;
  reasoningEffortUsed?: "off" | "low" | "medium" | "high";
  truncated?: boolean;
  uiPlanMeta?: UiPlanSummaryMeta;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  exploreMessages?: ChatMessage[];
  pinnedItems?: WorkspaceBoardItem[];
  look: string;
  pinnedBotId?: string;
  createdAt: number;
  boardColumns?: WorkspaceBoardColumn[];
  boardItems?: WorkspaceBoardItem[];
  boardsByLook?: Record<
    string,
    { columns: WorkspaceBoardColumn[]; items: WorkspaceBoardItem[] }
  >;
}

export type BrainSseEvent =
  | {
      type: "turn_meta";
      look: string;
      mood: MoodId;
      botLabel?: string;
      previousLook?: string;
      suggestedLook?: string;
      hasNativeReasoning?: boolean;
      modelHasReasoning?: boolean;
      modelId?: string;
      reasoningEffort?: "off" | "low" | "medium" | "high";
      uiPlanMeta?: UiPlanSummaryMeta;
    }
  | {
      type: "activity_update";
      label: string;
    }
  | {
      type: "reasoning_delta";
      delta: string;
      tokenCount?: number;
    }
  | {
      type: "telemetry_update";
      tokenCount: number;
      elapsedSec: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
    }
  | {
      type: "part_start";
      partId: string;
      kind: "text";
    }
  | {
      type: "text_delta";
      partId: string;
      delta: string;
    }
  | {
      type: "sources_update";
      sources: SourceItem[];
    }
  | {
      type: "part_end";
      partId: string;
    }
  | {
      type: "part_discard";
      partId: string;
    }
  | {
      type: "tool_start";
      toolCallId: string;
      name: string;
      label?: string;
      argsPreview?: string;
      query?: string;
      provider?: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      summary?: string;
      elapsedMs?: number;
      query?: string;
      providers?: string[];
      domains?: string[];
      resultsPreview?: Array<{ title: string; url: string; domain: string; imageUrl?: string }>;
      imagePreviews?: Array<{ imageUrl: string; caption?: string; sourceUrl?: string }>;
    }
  | {
      type: "image_pool";
      urls: string[];
    }
  | {
      type: "session_title";
      title: string;
    }
  | {
      /** A FamHub write the model proposed. Nothing is recorded until the user confirms it by id. */
      type: "write_proposal";
      id: string;
      kind: "transaction" | "bill";
      title: string;
      rows: WriteProposalRow[];
      expiresAt: number;
    }
  | {
      type: "board_update";
      columns: WorkspaceBoardColumn[];
      items: WorkspaceBoardItem[];
    }
  | {
      type: "turn_done";
      sources?: SourceItem[];
      mood?: MoodId;
      tokenCount?: number;
      elapsedSec?: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
      modelId?: string;
      truncated?: boolean;
    }
  | {
      type: "turn_error";
      message: string;
    };
