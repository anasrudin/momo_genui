"use client";

import React, {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, ChevronDown, Copy, Pause, Pencil, RotateCcw, Volume2 } from "lucide-react";
import { MomoMiniCanvas } from "@/avatar/MomoMiniCanvas";
import { compressUiBlocksForHistory } from "@/lib/genUiStreamParser";
import { formatWithSourcesForCopy, hexToRgba, resolvePaletteTuple } from "@/lib/localBrain";
import { OpenUiStreamView } from "@/components/genui/OpenUiStreamView";
import { containsOpenUiMarkup } from "@/lib/openui/streamParser";
import { EASE_MOMO, MOTION_VOCABULARY } from "@/components/motion/MotionPrimitives";
import { BotMenuPopover } from "@/components/shell/BotPopovers";
import { MarkdownMessage } from "@/components/shell/MarkdownMessage";
import { SourcePillRow } from "@/components/shell/SourcePillRow";
import { MomoThinkingProcess } from "@/components/shell/MomoThinkingProcess";
import { FamhubProposalCard } from "@/components/shell/FamhubProposalCard";
import type { WriteProposalCard } from "@/lib/famhub/proposalCard";
import { LOOK_NAMES } from "@/data/looks";
import type {
  BotIdentity,
  ChatMessage,
  MessagePart,
  SourceItem,
  UiInteractionPayload,
  WorkspaceBoardItem,
} from "@/types/momo";

// A role keycap or role name is tinted by the role it names, not by the session accent,
// so older turns keep their own role colour after the session switches role.
function roleTintVars(pal: readonly string[]): React.CSSProperties {
  return {
    "--c": pal[1],
    "--c-light": pal[0],
    "--c-deep": pal[3],
    "--accent": pal[1],
    "--accent-light": pal[0],
    "--accent-shade": pal[2],
    "--accent-sel": `color-mix(in srgb, ${pal[0]} 52%, #f7f7f7)`,
  } as React.CSSProperties;
}

export interface MessageThreadProps {
  messages: ChatMessage[];
  speakingMsgId: string | null;
  paletteOverrides: Record<string, string>;
  role?: string;
  allBots?: BotIdentity[];
  activeBotId?: string;
  forcedEditRequest?: { msgId: string; seq: number } | null;
  messagesRef?: React.Ref<HTMLDivElement>;
  onCopy: (text: string, sources?: SourceItem[]) => Promise<boolean>;
  onSpeakToggle: (msg: ChatMessage) => void;
  onRetry: (msg: ChatMessage) => void;
  onEditUserMessage?: (msg: ChatMessage, nextText: string) => void;
  onPromptAction: (prompt: string) => void;
  onUiInteraction?: (interaction: UiInteractionPayload) => void;
  onRoleGateEditQuery?: (msg: ChatMessage) => void;
  onRoleGateSwitchRole?: (msg: ChatMessage, targetBotId: string) => void;
  onRoleGateStay?: (msg: ChatMessage) => void;
  onAvatarSwitchRole?: (targetBotId: string) => void;
  pinnedTitles?: Set<string>;
  onTogglePinItem?: (item: Omit<WorkspaceBoardItem, "id" | "columnId">) => void;
  onWriteProposalChange?: (msgId: string, proposalId: string, patch: Pick<WriteProposalCard, "status" | "error">) => void;
}

const SystemMessageItem = memo<{ msg: ChatMessage }>(function SystemMessageItem({
  msg,
}) {
  const cls =
    msg.systemKind === "handoff"
      ? "sys is-handoff"
      : msg.systemKind === "drop"
        ? "sys ok"
        : "sys";
  // "Beralih peran: Chef → Maker" → label, previous role, new role.
  const handoff =
    msg.systemKind === "handoff" ? /^(.+?):\s*(.+?)\s*→\s*(.+)$/.exec(msg.text) : null;
  return (
    <motion.div
      className={cls}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: MOTION_VOCABULARY.durations.normal, ease: MOTION_VOCABULARY.easings.standard }}
    >
      {handoff ? (
        <span className="sys-handoff__body">
          <span className="sys-handoff__label">{handoff[1]}</span>
          <span className="sys-handoff__role is-from">{handoff[2]}</span>
          <ArrowRight size={11} strokeWidth={2.2} aria-hidden="true" />
          <span className="sr-only">ke</span>
          <span className="sys-handoff__role">{handoff[3]}</span>
        </span>
      ) : (
        <span>{msg.text}</span>
      )}
    </motion.div>
  );
});

const UserMessageItem = memo<{
  msg: ChatMessage;
  isCopied: boolean;
  forcedEditSeq?: number;
  onCopyClick: (msg: ChatMessage) => void;
  onEditSubmit?: (msg: ChatMessage, nextText: string) => void;
}>(function UserMessageItem({ msg, isCopied, forcedEditSeq, onCopyClick, onEditSubmit }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(msg.text);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastHandledEditSeqRef = useRef<number>(0);

  useEffect(() => {
    if (!forcedEditSeq || forcedEditSeq === lastHandledEditSeqRef.current) return;
    lastHandledEditSeqRef.current = forcedEditSeq;
    setDraftText(msg.text);
    setIsEditing(true);
  }, [forcedEditSeq, msg.text]);

  const isLongMessage = useMemo(() => {
    const text = msg.text || "";
    if (text.length > 240) return true;
    const lineCount = text.split(/\r?\n/).length;
    return lineCount > 4;
  }, [msg.text]);

  useEffect(() => {
    if (!isEditing) {
      setDraftText(msg.text);
    }
  }, [msg.text, isEditing]);

  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(420, Math.max(36, el.scrollHeight))}px`;
  }, [isEditing, draftText]);

  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isEditing]);

  const canSubmitEdit =
    draftText.trim().length > 0 || Boolean(msg.attachments && msg.attachments.length > 0);

  const handleCommitEdit = useCallback(() => {
    if (!canSubmitEdit) return;
    const next = draftText.trim();
    setIsEditing(false);
    onEditSubmit?.(msg, next);
  }, [canSubmitEdit, draftText, msg, onEditSubmit]);

  const handleCancelEdit = useCallback(() => {
    setDraftText(msg.text);
    setIsEditing(false);
  }, [msg.text]);

  return (
    <motion.div
      className={`msg user${isEditing ? " is-editing" : ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION_VOCABULARY.durations.normal, ease: MOTION_VOCABULARY.easings.standard }}
    >
      {isEditing ? (
        <>
          <div className="bubble momo-user-edit-box">
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {msg.attachments.map((att) => (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-black/5 px-2 py-1 text-[11px] font-medium dark:border-white/15 dark:bg-white/10"
                  >
                    {att.kind === "image" && att.previewUrl ? (
                      <img
                        src={att.previewUrl}
                        alt={att.name}
                        className="h-4 w-4 rounded object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full"
                        style={{ background: att.accent || "var(--accent)" }}
                      />
                    )}
                    <span className="max-w-[140px] truncate">{att.name}</span>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="momo-user-edit-input"
              value={draftText}
              rows={1}
              aria-label="Edit pesan"
              placeholder="Tulis pertanyaan..."
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  handleCancelEdit();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleCommitEdit();
                }
              }}
            />
          </div>
          <div className="momo-user-edit-bar">
            <button
              type="button"
              className="momo-user-edit-btn is-cancel"
              onClick={handleCancelEdit}
            >
              Batal
            </button>
            <button
              type="button"
              className="momo-user-edit-btn is-submit"
              disabled={!canSubmitEdit}
              onClick={handleCommitEdit}
            >
              Kirim
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            className={`bubble${isLongMessage ? " is-collapsible" : ""}${isLongMessage && !isExpanded ? " is-collapsed" : ""}`}
          >
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {msg.attachments.map((att) => (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-black/5 px-2 py-1 text-[11px] font-medium dark:border-white/15 dark:bg-white/10"
                  >
                    {att.kind === "image" && att.previewUrl ? (
                      <img
                        src={att.previewUrl}
                        alt={att.name}
                        className="h-4 w-4 rounded object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full"
                        style={{ background: att.accent || "var(--accent)" }}
                      />
                    )}
                    <span className="max-w-[140px] truncate">{att.name}</span>
                  </span>
                ))}
              </div>
            )}
            <div
              className={`momo-user-bubble-text${isLongMessage && !isExpanded ? " is-collapsed" : ""}`}
            >
              {msg.text}
            </div>
            {isLongMessage && (
              <button
                type="button"
                className="momo-user-expand-btn"
                aria-expanded={isExpanded}
                onClick={() => setIsExpanded((v) => !v)}
              >
                <span>{isExpanded ? "Ringkas" : "Selengkapnya"}</span>
                <span aria-hidden="true">{isExpanded ? "▴" : "▾"}</span>
              </button>
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className={`act swap${isCopied ? " on" : ""}`}
              data-action="copy"
              data-tip={isCopied ? "Tersalin" : "Salin"}
              aria-label="Salin pesan"
              title="Salin"
              onClick={() => onCopyClick(msg)}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={isCopied ? "check" : "copy"}
                  className="momo-act-glyph"
                  initial={{ opacity: 0, scale: 0.78 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.78 }}
                  transition={{ duration: 0.15, ease: EASE_MOMO }}
                >
                  {isCopied ? (
                    <Check size={16} strokeWidth={1.85} aria-hidden="true" />
                  ) : (
                    <Copy size={16} strokeWidth={1.85} aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
            {onEditSubmit && (
              <button
                type="button"
                className="act"
                data-action="edit"
                data-tip="Edit & kirim ulang"
                aria-label="Edit pesan"
                title="Edit & kirim ulang"
                onClick={() => {
                  setDraftText(msg.text);
                  setIsEditing(true);
                }}
              >
                <span className="momo-act-glyph">
                  <Pencil size={15} strokeWidth={1.85} aria-hidden="true" />
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
});

const BotMessageItem = memo<{
  msg: ChatMessage;
  userContextText?: string;
  defaultRole?: string;
  paletteOverrides: Record<string, string>;
  allBots?: BotIdentity[];
  activeBotId?: string;
  isLatestBot: boolean;
  isCopied: boolean;
  isSpeaking: boolean;
  onCopyClick: (msg: ChatMessage) => void;
  onSpeakToggle: (msg: ChatMessage) => void;
  onRetry: (msg: ChatMessage) => void;
  onPromptAction: (prompt: string) => void;
  onUiInteraction?: (interaction: UiInteractionPayload) => void;
  onRoleGateEditQuery?: (msg: ChatMessage) => void;
  onRoleGateSwitchRole?: (msg: ChatMessage, targetBotId: string) => void;
  onRoleGateStay?: (msg: ChatMessage) => void;
  onAvatarSwitchRole?: (targetBotId: string) => void;
  pinnedTitles?: Set<string>;
  onTogglePinItem?: (item: Omit<WorkspaceBoardItem, "id" | "columnId">) => void;
  onWriteProposalChange?: (msgId: string, proposalId: string, patch: Pick<WriteProposalCard, "status" | "error">) => void;
}>(function BotMessageItem({
  msg,
  userContextText,
  defaultRole,
  paletteOverrides,
  allBots = [],
  activeBotId = "momo",
  isLatestBot,
  isCopied,
  isSpeaking,
  onCopyClick,
  onSpeakToggle,
  onRetry,
  onPromptAction,
  onUiInteraction,
  onRoleGateEditQuery,
  onRoleGateSwitchRole,
  onRoleGateStay,
  onAvatarSwitchRole,
  pinnedTitles,
  onTogglePinItem,
  onWriteProposalChange,
}) {
  const [everStreamed, setEverStreamed] = useState(Boolean(msg.streaming));
  const [streamedInPlace, setStreamedInPlace] = useState(Boolean(msg.streaming));
  const [gateMenuOpen, setGateMenuOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const gateRoleBtnRef = useRef<HTMLButtonElement | null>(null);
  const avatarTriggerRef = useRef<HTMLButtonElement | null>(null);
  const avatarMenuAnchorRef = useRef<HTMLElement | null>(null);
  const claimAvatarAnchor = (e: React.PointerEvent<HTMLElement>) => {
    avatarMenuAnchorRef.current = e.currentTarget;
  };

  useLayoutEffect(() => {
    if (msg.streaming) {
      setStreamedInPlace(true);
    }
  }, [msg.streaming]);

  useEffect(() => {
    if (msg.streaming) {
      setEverStreamed(true);
      return;
    }
    if (!everStreamed) return;
    const t = window.setTimeout(() => setEverStreamed(false), 260);
    return () => window.clearTimeout(t);
  }, [msg.streaming, everStreamed]);

  const look = msg.look || defaultRole || "rest";
  const pal = resolvePaletteTuple(look, paletteOverrides);
  const rawLabel = msg.botLabel || "Momo";
  const sepIdx = rawLabel.indexOf(" · ");
  const displayName = sepIdx !== -1 ? rawLabel.slice(0, sepIdx) : rawLabel;
  const labelRole = sepIdx !== -1 ? rawLabel.slice(sepIdx + 3) : null;
  const roleBadge = labelRole || (look !== "rest" ? LOOK_NAMES[look] : null);

  const parts: MessagePart[] = useMemo(() => {
    if (msg.parts && msg.parts.length > 0) return msg.parts;
    if (msg.text) {
      return [
        {
          id: `${msg.id}-txt`,
          kind: "text",
          text: msg.text,
          streaming: msg.streaming,
        },
      ];
    }
    return [];
  }, [msg.parts, msg.text, msg.id, msg.streaming]);

  const nonToolParts = parts.filter((p) => p.kind === "text");
  const hasVisibleOutput = nonToolParts.some((p) => p.text.length > 0);
  const hasRealReasoning = Boolean(
    msg.hasNativeReasoning || (msg.reasoningText && msg.reasoningText.trim().length > 0)
  );
  const showThinking = Boolean(
    msg.streaming ||
      hasRealReasoning ||
      parts.some((p) => p.kind === "tool" || p.kind === "gen_ui") ||
      (msg.role === "momo" &&
        (hasVisibleOutput || Boolean(msg.tokenCount || msg.elapsedSec)))
  );

  const msgId = msg.id;
  const handleProposalChange = useCallback(
    (proposalId: string, patch: Pick<WriteProposalCard, "status" | "error">) =>
      onWriteProposalChange?.(msgId, proposalId, patch),
    [msgId, onWriteProposalChange],
  );

  const roleTint = useMemo(() => roleTintVars(pal), [pal]);
  const botStyle = useMemo(
    () =>
      ({
        "--c": pal[1],
        "--c-light": pal[0],
        "--c-deep": pal[3],
        "--role-light": pal[0],
        "--role-deep": pal[3],
        "--role-ink": pal[3],
        "--role-bg": hexToRgba(pal[0], 0.36),
      }) as React.CSSProperties,
    [pal]
  );

  if (msg.roleGate) {
    const gate = msg.roleGate;
    const suggestedPal = resolvePaletteTuple(gate.suggestedLook, paletteOverrides);
    const recommendedBotId = `preset:${gate.suggestedLook}`;
    const activeRole = <strong className="momo-role-gate__role">{gate.activeRoleName}</strong>;
    const suggestedRole = (
      <strong className="momo-role-gate__role" style={roleTintVars(suggestedPal)}>
        {gate.suggestedRoleName}
      </strong>
    );

    return (
      <motion.div
        className={`msg bot is-role-gate${isLatestBot ? " latest" : ""}`}
        style={botStyle}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: MOTION_VOCABULARY.durations.normal, ease: MOTION_VOCABULARY.easings.standard }}
      >
        <motion.button
          type="button"
          className="momo-avatar-trigger is-gate"
          disabled={!isLatestBot}
          aria-label={`Ganti peran dari ${gate.activeRoleName}`}
          title="Klik untuk ganti peran"
          initial={{ scale: 0.84, rotate: -8 }}
          animate={{ scale: 1, rotate: [0, -5, 4, 0] }}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.45, ease: EASE_MOMO }}
          onClick={() => setGateMenuOpen((o) => !o)}
        >
          <MomoMiniCanvas
            look={gate.activeLook || look}
            size={28}
            paletteOverrides={paletteOverrides}
            ariaLabel={gate.activeRoleName || "Momo"}
          />
        </motion.button>

        <div className="relative min-w-0">
          <div className="who">
            <b>Momo</b>
            <span className="role">{gate.activeRoleName}</span>
          </div>

          <div className="momo-role-gate" role="region" aria-label="Konfirmasi peran">
            <p className="momo-role-gate__text">
              {msg.text ? (
                <>
                  Mau lanjut dari sisi {activeRole}, atau pindah ke {suggestedRole} untuk
                  bagian itu?
                </>
              ) : (
                <>
                  Eh, ini di luar peranku sebagai {activeRole}. Topik ini lebih pas ditangani{" "}
                  {suggestedRole} — mau ubah pertanyaannya atau ganti role dulu?
                </>
              )}
            </p>

            {isLatestBot && <div className="momo-role-gate__actions">
              <motion.button
                type="button"
                className="momo-role-gate__edit-btn"
                whileTap={{ scale: 0.97 }}
                onClick={() => onRoleGateEditQuery?.(msg)}
              >
                <Pencil size={12.5} strokeWidth={2} aria-hidden="true" />
                <span>Ubah Query</span>
              </motion.button>

              <motion.button
                ref={gateRoleBtnRef}
                type="button"
                className="bot-pick is-compact"
                data-open={gateMenuOpen ? "1" : "0"}
                aria-haspopup="menu"
                aria-expanded={gateMenuOpen}
                style={roleTintVars(suggestedPal)}
                whileTap={{ scale: 0.97 }}
                onClick={() => setGateMenuOpen((o) => !o)}
              >
                <span className="bot-pick-dot" aria-hidden="true" />
                <span className="bot-pick-label">Ganti ke {gate.suggestedRoleName}</span>
                <ChevronDown
                  size={13}
                  strokeWidth={2.2}
                  className="bot-pick-chev"
                  aria-hidden="true"
                />
              </motion.button>

              <button
                type="button"
                className="momo-role-gate__stay-btn"
                onClick={() => onRoleGateStay?.(msg)}
              >
                Tetap di {gate.activeRoleName}
              </button>
            </div>}
          </div>

          <BotMenuPopover
            open={isLatestBot && gateMenuOpen}
            anchorRef={gateRoleBtnRef}
            bots={allBots}
            activeBotId={activeBotId}
            paletteOverrides={paletteOverrides}
            compact
            recommendedBotId={recommendedBotId}
            onSelectBot={(targetBotId) => {
              setGateMenuOpen(false);
              onRoleGateSwitchRole?.(msg, targetBotId);
            }}
            onClose={() => setGateMenuOpen(false)}
          />
        </div>
      </motion.div>
    );
  }

  const didRoleSwitch = Boolean(msg.previousLook && msg.previousLook !== look);
  const prevRoleName = msg.previousLook
    ? msg.previousLook === "rest"
      ? "Momo"
      : LOOK_NAMES[msg.previousLook] || msg.previousLook
    : null;
  const curRoleName =
    roleBadge || (look === "rest" ? "Momo" : LOOK_NAMES[look] || look);
  // Only the latest bot answer can switch role; older ones are static labels.
  const canSwitchFromAvatar = Boolean(isLatestBot && onAvatarSwitchRole && allBots.length > 0);

  return (
    <motion.div
      className={`msg bot${isLatestBot ? " latest" : ""}`}
      style={botStyle}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION_VOCABULARY.durations.normal, ease: MOTION_VOCABULARY.easings.standard }}
    >
      {canSwitchFromAvatar ? (
        <motion.button
          ref={avatarTriggerRef}
          type="button"
          className={`momo-avatar-trigger${didRoleSwitch ? " is-switched" : ""}`}
          aria-haspopup="menu"
          aria-expanded={avatarMenuOpen}
          aria-label={`${msg.botLabel || "Momo"} — klik untuk ganti peran`}
          title="Klik untuk ganti peran"
          key={`av-${look}`}
          initial={didRoleSwitch ? { scale: 0.82, rotate: -10 } : false}
          animate={{ scale: 1, rotate: 0 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: "spring", stiffness: 420, damping: 24 }}
          onPointerDown={claimAvatarAnchor}
          onClick={(e) => {
            avatarMenuAnchorRef.current = e.currentTarget;
            setAvatarMenuOpen((o) => !o);
          }}
        >
          {didRoleSwitch && (
            <motion.span
              className="momo-avatar-pulse"
              aria-hidden="true"
              initial={{ scale: 0.78, opacity: 0.72 }}
              animate={{ scale: 1.48, opacity: 0 }}
              transition={{ duration: 0.65, ease: EASE_MOMO }}
            />
          )}
          <MomoMiniCanvas
            look={look}
            size={28}
            paletteOverrides={paletteOverrides}
            ariaLabel={msg.botLabel || "Momo"}
          />
        </motion.button>
      ) : (
        <span className={`momo-avatar-trigger is-static${didRoleSwitch ? " is-switched" : ""}`}>
          {didRoleSwitch && (
            <motion.span
              className="momo-avatar-pulse"
              aria-hidden="true"
              initial={{ scale: 0.78, opacity: 0.72 }}
              animate={{ scale: 1.48, opacity: 0 }}
              transition={{ duration: 0.65, ease: EASE_MOMO }}
            />
          )}
          <MomoMiniCanvas
            look={look}
            size={28}
            paletteOverrides={paletteOverrides}
            ariaLabel={msg.botLabel || "Momo"}
          />
        </span>
      )}

      <div className="relative min-w-0">
        <div className="who">
          <b>{displayName}</b>
          {didRoleSwitch && prevRoleName ? (
            canSwitchFromAvatar ? (
              <motion.button
                type="button"
                className="bot-pick is-compact is-mini is-switched"
                style={roleTint}
                data-open={avatarMenuOpen ? "1" : "0"}
                initial={{ opacity: 0, x: -6, scale: 0.94 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: "spring", stiffness: 420, damping: 28 }}
                onPointerDown={claimAvatarAnchor}
                onClick={(e) => {
                  avatarMenuAnchorRef.current = e.currentTarget;
                  setAvatarMenuOpen((o) => !o);
                }}
              >
                <span className="bot-pick-dot" aria-hidden="true" />
                <span className="momo-avatar-role-from">{prevRoleName}</span>
                <span className="momo-avatar-role-arrow" aria-hidden="true">→</span>
                <span className="momo-avatar-role-to">{curRoleName}</span>
                <ChevronDown size={11} strokeWidth={2.2} className="momo-avatar-role-chev" aria-hidden="true" />
              </motion.button>
            ) : (
              <span className="bot-pick is-compact is-mini is-switched is-static" style={roleTint}>
                <span className="bot-pick-dot" aria-hidden="true" />
                <span className="momo-avatar-role-from">{prevRoleName}</span>
                <span className="momo-avatar-role-arrow" aria-hidden="true">→</span>
                <span className="momo-avatar-role-to">{curRoleName}</span>
              </span>
            )
          ) : roleBadge && roleBadge !== displayName ? (
            canSwitchFromAvatar ? (
              <motion.button
                type="button"
                className="bot-pick is-compact is-mini"
                style={roleTint}
                data-open={avatarMenuOpen ? "1" : "0"}
                whileTap={{ scale: 0.97 }}
                onPointerDown={claimAvatarAnchor}
                onClick={(e) => {
                  avatarMenuAnchorRef.current = e.currentTarget;
                  setAvatarMenuOpen((o) => !o);
                }}
              >
                <span className="bot-pick-dot" aria-hidden="true" />
                <span>{roleBadge}</span>
                <ChevronDown size={11} strokeWidth={2.2} className="momo-avatar-role-chev" aria-hidden="true" />
              </motion.button>
            ) : (
              <span className="bot-pick is-compact is-mini is-static" style={roleTint}>
                <span className="bot-pick-dot" aria-hidden="true" />
                <span>{roleBadge}</span>
              </span>
            )
          ) : null}
        </div>

        {canSwitchFromAvatar && (
          <BotMenuPopover
            open={avatarMenuOpen}
            anchorRef={avatarMenuAnchorRef}
            bots={allBots}
            activeBotId={activeBotId}
            paletteOverrides={paletteOverrides}
            compact
            onSelectBot={(targetBotId) => {
              setAvatarMenuOpen(false);
              onAvatarSwitchRole?.(targetBotId);
            }}
            onClose={() => setAvatarMenuOpen(false)}
          />
        )}

        {showThinking && <MomoThinkingProcess msg={msg} />}

        <AnimatePresence mode="sync" initial={false}>
          {msg.streaming && !hasVisibleOutput && !showThinking && (
            <motion.div
              key="chat-stream-waiting"
              className="momo-stream-waiting"
              data-lifecycle="pending"
              aria-hidden="true"
              style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}
              initial={{ opacity: 0.4 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: EASE_MOMO }}
            >
              <span className="gu-skel__dot" />
              <span className="gu-skel__bar" style={{ width: 96 }} />
            </motion.div>
          )}

          {hasVisibleOutput && (
            <motion.div
              key="timeline"
              className="bot-timeline"
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr)",
                gap: 14,
                minWidth: 0,
                width: "100%",
                maxWidth: "100%",
                marginTop: showThinking ? 10 : 0,
              }}
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.24, ease: EASE_MOMO }}
            >
              {nonToolParts.map((part, pIdx) => {
                if (part.kind === "text") {
                  if (!part.text) return null;
                  const partStreaming = Boolean(
                    part.streaming ||
                    (msg.streaming && everStreamed && pIdx === nonToolParts.length - 1)
                  );
                  const hasInlineUi = containsOpenUiMarkup(part.text);
                  if (hasInlineUi) {
                    return (
                      <OpenUiStreamView
                        key={part.id}
                        text={part.text}
                        streaming={partStreaming}
                        contextText={userContextText}
                        surface="chat"
                        live={isLatestBot && !msg.streaming}
                        sources={msg.sources}
                        pinnedTitles={pinnedTitles}
                        onAction={(a) => onPromptAction(a.text)}
                        onUiInteraction={onUiInteraction}
                        onTogglePinItem={onTogglePinItem}
                      />
                    );
                  }
                  return (
                    <div key={part.id} className="body">
                      <MarkdownMessage
                        text={part.text}
                        sources={msg.sources}
                        isStreaming={partStreaming}
                      />
                    </div>
                  );
                }

                return null;
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {msg.writeProposals && msg.writeProposals.length > 0 && (
          <div className="momo-famhub-cards">
            {msg.writeProposals.map((card) => (
              <FamhubProposalCard key={card.id} card={card} onChange={handleProposalChange} />
            ))}
          </div>
        )}

        {msg.truncated && !msg.streaming && (
          <p
            className="gu-pen momo-hand-title"
            style={{ margin: "10px 2px 0", color: "var(--mute)", fontSize: 12 }}
          >
            jawaban terpotong, respons terhenti di tengah
          </p>
        )}

        {!msg.streaming && msg.sources && msg.sources.length > 0 && (
          <SourcePillRow sources={msg.sources} maxVisible={3} />
        )}

        {!msg.streaming &&
          (Boolean(msg.showActions) ||
            hasVisibleOutput ||
            Boolean(msg.text?.trim()) ||
            Boolean(msg.truncated)) && (
          <motion.div
            className="actions"
            initial={streamedInPlace ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: EASE_MOMO }}
          >
            <button
              type="button"
              className={`act swap${isCopied ? " on" : ""}`}
              data-action="copy"
              data-tip={isCopied ? "Tersalin" : "Salin"}
              aria-label="Salin jawaban"
              title="Salin"
              onClick={() => onCopyClick(msg)}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={isCopied ? "check" : "copy"}
                  className="momo-act-glyph"
                  initial={{ opacity: 0, scale: 0.78 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.78 }}
                  transition={{ duration: 0.15, ease: EASE_MOMO }}
                >
                  {isCopied ? (
                    <Check size={16} strokeWidth={1.85} aria-hidden="true" />
                  ) : (
                    <Copy size={16} strokeWidth={1.85} aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>

            <button
              type="button"
              className={`act${isSpeaking ? " on" : ""}`}
              data-action="speak"
              data-tip={isSpeaking ? "Berhenti" : "Bacakan"}
              aria-label={isSpeaking ? "Hentikan suara" : "Bacakan jawaban"}
              title={isSpeaking ? "Berhenti" : "Bacakan"}
              onClick={() => onSpeakToggle(msg)}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={isSpeaking ? "pause" : "speak"}
                  className="momo-act-glyph"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15, ease: EASE_MOMO }}
                >
                  {isSpeaking ? (
                    <Pause size={16} strokeWidth={1.85} aria-hidden="true" />
                  ) : (
                    <Volume2 size={16} strokeWidth={1.85} aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>

            <button
              type="button"
              className="act"
              data-action="retry"
              data-tip="Respon ulang"
              aria-label="Respon ulang jawaban"
              title="Respon ulang"
              onClick={() => onRetry(msg)}
            >
              <span className="momo-act-glyph">
                <RotateCcw size={16} strokeWidth={1.85} aria-hidden="true" />
              </span>
            </button>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
});

export const MessageThread = React.forwardRef<HTMLDivElement, MessageThreadProps>(
  function MessageThread(
    {
      messages,
      speakingMsgId,
      paletteOverrides,
      role,
      allBots,
      activeBotId,
      forcedEditRequest,
      messagesRef,
      onCopy,
      onSpeakToggle,
      onRetry,
      onEditUserMessage,
      onPromptAction,
      onUiInteraction,
      onRoleGateEditQuery,
      onRoleGateSwitchRole,
      onRoleGateStay,
      onAvatarSwitchRole,
      pinnedTitles,
      onTogglePinItem,
      onWriteProposalChange,
    },
    forwardedRef
  ) {
    const mergedMessagesRef = useCallback(
      (node: HTMLDivElement | null) => {
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;

        if (typeof messagesRef === "function") return messagesRef(node);
        if (messagesRef) {
          (messagesRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
        return undefined;
      },
      [forwardedRef, messagesRef]
    );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const onCopyRef = useRef(onCopy);
  onCopyRef.current = onCopy;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const lastBotIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "momo") return i;
    }
    return -1;
  }, [messages]);

  const handleCopyClick = useCallback(async (msg: ChatMessage) => {
    const payload =
      msg.role === "user"
        ? msg.text
        : formatWithSourcesForCopy(
            compressUiBlocksForHistory(msg.text),
            msg.sources,
          );
    let copiedOk = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        copiedOk = true;
      }
    } catch {
      copiedOk = false;
    }
    if (!copiedOk && typeof document !== "undefined") {
      try {
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        copiedOk = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        copiedOk = false;
      }
    }
    void onCopyRef.current(payload, msg.sources);
    if (!copiedOk) return;
    setCopiedId(msg.id);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopiedId((cur) => (cur === msg.id ? null : cur));
    }, 1500);
  }, []);

  // History opens at the top. Paint the first turn before mounting the rich
  // content further down; keep new turns in an already-open chat synchronous.
  const [splitHistory] = useState(() => messages.length > 4 && !messages.some(m => m.streaming));
  const historyReady = useDeferredValue(splitHistory, false);
  const showTail = historyReady || messages.at(-1)?.streaming;
  const visible = splitHistory && !showTail ? messages.slice(0, 2) : messages;
  let userContextText: string | undefined;
  const items = visible.map((msg, idx) => {
    if (msg.role === "system") return <SystemMessageItem key={msg.id} msg={msg} />;

    if (msg.role === "user") {
      if (msg.text) userContextText = msg.text;
      return (
        <UserMessageItem
          key={msg.id}
          msg={msg}
          isCopied={copiedId === msg.id}
          forcedEditSeq={forcedEditRequest?.msgId === msg.id ? forcedEditRequest.seq : undefined}
          onCopyClick={handleCopyClick}
          onEditSubmit={onEditUserMessage}
        />
      );
    }

    return (
      <BotMessageItem
        key={msg.id}
        msg={msg}
        userContextText={userContextText}
        defaultRole={msg.look ? undefined : role}
        paletteOverrides={paletteOverrides}
        allBots={allBots}
        activeBotId={activeBotId}
        isLatestBot={idx === lastBotIndex}
        isCopied={copiedId === msg.id}
        isSpeaking={speakingMsgId === msg.id}
        onCopyClick={handleCopyClick}
        onSpeakToggle={onSpeakToggle}
        onRetry={onRetry}
        onPromptAction={onPromptAction}
        onUiInteraction={onUiInteraction}
        onRoleGateEditQuery={onRoleGateEditQuery}
        onRoleGateSwitchRole={onRoleGateSwitchRole}
        onRoleGateStay={onRoleGateStay}
        onAvatarSwitchRole={onAvatarSwitchRole}
        pinnedTitles={pinnedTitles}
        onTogglePinItem={onTogglePinItem}
        onWriteProposalChange={onWriteProposalChange}
      />
    );
  });
  return (
    <div id="messages" className="messages" ref={mergedMessagesRef}>
      <AnimatePresence initial={false}>{splitHistory ? items.slice(0, 2) : items}</AnimatePresence>
      {splitHistory && showTail && (
        <AnimatePresence initial={false}>{items.slice(2)}</AnimatePresence>
      )}
    </div>
  );
  }
);
