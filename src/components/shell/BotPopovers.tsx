"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MomoMiniCanvas } from "@/avatar/MomoMiniCanvas";
import { MomoIcon } from "@/components/icons/MomoIcon";
import { EASE_MOMO, MOTION_VOCABULARY } from "@/components/motion/MotionPrimitives";
import {
  LOOK_JOBS,
  LOOK_NAMES,
  PRESET_BOT_GROUPS,
  ROLE_PALETTES,
} from "@/data/looks";
import { inferLookByKeyword, resolvePaletteKey } from "@/lib/localBrain";
import type { BotIdentity } from "@/types/momo";

function useDismissOnOutside(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  anchorRef: React.RefObject<HTMLElement | null>,
  onClose: () => void
) {
  const latestOnCloseRef = useRef(onClose);
  latestOnCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        containerRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      latestOnCloseRef.current();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        latestOnCloseRef.current();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    // Capture phase: some focused descendants swallow Escape before it bubbles to document.
    window.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [open, containerRef, anchorRef]);
}

function computeAnchorPosition(
  anchorEl: HTMLElement | null,
  popWidth: number,
  popHeight: number,
  align: "center" | "start" = "center",
): { top: number; left: number; origin: string } {
  if (typeof window === "undefined" || !anchorEl) {
    return { top: 180, left: 240, origin: "50% 0%" };
  }
  const rect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 12;
  const rawLeft =
    align === "start" ? rect.left - 4 : rect.left + rect.width / 2 - popWidth / 2;
  const left = Math.max(pad, Math.min(vw - popWidth - pad, rawLeft));
  const fitsBelow = rect.bottom + 8 + popHeight <= vh - pad;
  const top = fitsBelow
    ? rect.bottom + 8
    : Math.max(pad, rect.top - 8 - popHeight);
  const originY = fitsBelow ? "0%" : "100%";
  const originX = `${Math.round(rect.left + rect.width / 2 - left)}px`;
  return { top, left, origin: `${originX} ${originY}` };
}

interface CompactRoleGridProps {
  bots: BotIdentity[];
  activeBotId: string;
  recommendedBotId?: string;
  paletteOverrides: Record<string, string>;
  onPick: (botId: string) => void;
}

const ROLE_GRID_COLS = 3;

function CompactRoleGrid({
  bots,
  activeBotId,
  recommendedBotId,
  paletteOverrides,
  onPick,
}: CompactRoleGridProps) {
  const glassId = React.useId();
  const reduceMotion = useReducedMotion();
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const highlighted = hover ?? focus ?? activeBotId;
  const lookOf = (id: string) =>
    id === "momo"
      ? "rest"
      : id.startsWith("preset:")
        ? id.slice(7)
        : (bots.find((b) => b.id === id)?.look ?? "rest");

  const nameOf = (id: string) => {
    if (id === "momo") return "Momo";
    const own = bots.find((b) => b.id === id && b.own);
    if (own) return own.name;
    const look = lookOf(id);
    return LOOK_NAMES[look] || look;
  };

  const paletteOf = (look: string) => {
    const palKey = resolvePaletteKey(look, paletteOverrides);
    return ROLE_PALETTES[palKey] ?? ROLE_PALETTES.persimmon;
  };

  const featured = recommendedBotId && recommendedBotId !== "momo"
    ? [recommendedBotId, "momo"]
    : [];
  const ownIds = bots.filter((b) => b.own).map((b) => b.id);
  const groups: Array<[string, string[]]> = [
    ["Buatanku", ownIds] as [string, string[]],
    ...PRESET_BOT_GROUPS.map(
      ([label, looks]) =>
        [label, [...(label === "Harian" ? ["momo"] : []), ...looks.map((l) => `preset:${l}`)]] as [string, string[]],
    ),
  ]
    .map(
      ([label, ids]) =>
        [label, ids.filter((id) => !featured.includes(id))] as [string, string[]],
    )
    .filter(([, ids]) => ids.length > 0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowDown"
            ? ROLE_GRID_COLS
            : e.key === "ArrowUp"
              ? -ROLE_GRID_COLS
              : 0;
    if (!step) return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ),
    );
    if (!items.length) return;
    e.preventDefault();
    const cur = items.findIndex((el) => el === document.activeElement);
    const next =
      cur < 0 ? 0 : Math.max(0, Math.min(items.length - 1, cur + step));
    items[next]?.focus();
  };

  const renderChip = (id: string, isFeatured = false) => {
    const look = lookOf(id);
    const pal = paletteOf(look);
    const selected = activeBotId === id;
    const isRecommended = Boolean(recommendedBotId && id === recommendedBotId);
    return (
      <motion.button
        key={id}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        className={`role-grid__chip${isFeatured ? " is-featured" : ""}${isRecommended ? " is-rec" : ""}${selected ? " is-on" : ""}`}
        style={
          {
            "--c": pal[1],
            "--c-light": pal[0],
            "--c-deep": pal[3],
          } as React.CSSProperties
        }
        onPointerEnter={(e) => { if (e.pointerType !== "touch") setHover(id); }}
        onFocus={() => { setHover(null); setFocus(id); }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        transition={{ duration: 0.14, ease: EASE_MOMO }}
        onClick={() => onPick(id)}
        title={LOOK_JOBS[look] || nameOf(id)}
      >
        {highlighted === id && (
          <motion.span
            aria-hidden="true"
            className="role-grid__glass"
            layoutId={glassId}
            initial={false}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 540, damping: 40 }}
          />
        )}
        <span className="role-grid__dot" aria-hidden="true" />
        <span className="role-grid__name">{nameOf(id)}</span>
        {isRecommended && <span className="role-grid__tag">Cocok</span>}
        {selected && !isRecommended && (
          <MomoIcon name="check" size={12} className="role-grid__check" />
        )}
      </motion.button>
    );
  };

  return (
    <div className="role-grid" onKeyDown={handleKeyDown}
      onPointerLeave={() => setHover(null)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocus(null); }}>
      {featured.length > 0 && <div className="role-grid__featured">
        {featured.map((id) => renderChip(id, true))}
      </div>}
      {groups.map(([label, ids]) => (
        <section key={label} className="role-grid__group">
          <div className="role-grid__sep" role="separator" aria-label={label}>
            <span>{label}</span>
          </div>
          <div className="role-grid__cells">{ids.map((id) => renderChip(id))}</div>
        </section>
      ))}
    </div>
  );
}

export interface BotMenuPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  bots: BotIdentity[];
  activeBotId: string;
  paletteOverrides: Record<string, string>;
  onSelectBot: (botId: string) => void;
  onDeleteBot?: (botId: string) => void;
  onOpenNewBot?: () => void;
  onClose: () => void;
  compact?: boolean;
  recommendedBotId?: string;
}

export const BotMenuPopover: React.FC<BotMenuPopoverProps> = ({
  open,
  anchorRef,
  bots,
  activeBotId,
  paletteOverrides,
  onSelectBot,
  onDeleteBot,
  onOpenNewBot,
  onClose,
  compact = false,
  recommendedBotId,
}) => {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pillRect, setPillRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
  } | null>(null);
  useDismissOnOutside(open, popRef, anchorRef, onClose);

  const menuPositionRef = useCallback(
    (el: HTMLDivElement | null) => {
      popRef.current = el;
      if (!el) return;
      const update = () => {
        const w = compact ? el.offsetWidth : 300;
        const h = compact
          ? el.offsetHeight || 296
          : Math.min(window.innerHeight * 0.65, 420);
        const pos = computeAnchorPosition(
          anchorRef.current,
          w,
          h,
          compact ? "start" : "center",
        );
        el.style.top = `${pos.top}px`;
        el.style.left = `${pos.left}px`;
        el.style.transformOrigin = pos.origin;
      };
      update();
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      return () => {
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        if (popRef.current === el) {
          popRef.current = null;
        }
      };
    },
    [anchorRef, compact]
  );

  const customBots = bots.filter((b) => b.own);
  const activeHighlightId = hoveredId ?? recommendedBotId ?? activeBotId;

  const resolveHighlightColor = useCallback(
    (id: string): string => {
      let look = "rest";
      if (id.startsWith("preset:")) {
        look = id.slice(7);
      } else if (id !== "momo") {
        look = bots.find((b) => b.id === id)?.look ?? "rest";
      }
      const palKey = resolvePaletteKey(look, paletteOverrides);
      return ROLE_PALETTES[palKey]?.[1] ?? ROLE_PALETTES.persimmon[1];
    },
    [bots, paletteOverrides]
  );

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const btn = rowRefs.current.get(activeHighlightId);
      if (!btn) {
        setPillRect(null);
        return;
      }
      setPillRect({
        x: btn.offsetLeft,
        y: btn.offsetTop,
        w: btn.offsetWidth,
        h: btn.offsetHeight,
        color: resolveHighlightColor(activeHighlightId),
      });
    };
    measure();
  }, [open, activeHighlightId, bots.length, resolveHighlightColor]);

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    );
    if (!items.length) return;
    e.preventDefault();
    const cur = items.findIndex((el) => el === document.activeElement);
    let nextIdx = 0;
    if (e.key === "ArrowDown") nextIdx = cur >= 0 ? (cur + 1) % items.length : 0;
    else if (e.key === "ArrowUp") nextIdx = cur >= 0 ? (cur - 1 + items.length) % items.length : items.length - 1;
    else if (e.key === "End") nextIdx = items.length - 1;
    items[nextIdx]?.focus();
  };

  const renderBotRow = (
    id: string,
    look: string,
    name: string,
    job: string,
    isOwn?: boolean,
  ) => {
    const palKey = resolvePaletteKey(look, paletteOverrides);
    const dotColor = ROLE_PALETTES[palKey]?.[1] ?? ROLE_PALETTES.persimmon[1];
    const selected = activeBotId === id;

    return (
      <div
        key={id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          paddingLeft: 4,
        }}
      >
        <motion.button
          ref={(el) => {
            if (el) rowRefs.current.set(id, el);
            else rowRefs.current.delete(id);
          }}
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          className={selected ? "on" : undefined}
          whileTap={{ scale: 0.985 }}
          transition={{ duration: 0.14, ease: EASE_MOMO }}
          onMouseEnter={() => setHoveredId(id)}
          onFocus={() => setHoveredId(id)}
          onClick={() => {
            onSelectBot(id);
            onClose();
          }}
        >
          <span
            className="dotc"
            style={{ "--c": dotColor } as React.CSSProperties}
          />
          <span className="nm">{name}</span>
          <span className="job">{job}</span>
          {selected && <MomoIcon name="check" size={16} />}
        </motion.button>
        {isOwn && onDeleteBot && (
          <button
            type="button"
            className="icon-btn"
            style={{ width: 28, height: 28, flex: "none" }}
            aria-label={`Hapus ${name}`}
            title={`Hapus ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteBot(id);
            }}
          >
            <MomoIcon name="trash" size={15} />
          </button>
        )}
      </div>
    );
  };

  const tree = (
    <AnimatePresence
      onExitComplete={() => {
        setHoveredId(null);
        setPillRect(null);
      }}
    >
      {open && (
        <motion.div
          ref={menuPositionRef}
          id={compact ? undefined : "botMenu"}
          className={`pop bot-menu open${compact ? " is-compact" : ""}`}
          role="menu"
          aria-label="Pilih peran asisten"
          style={{
            maxHeight: compact
              ? "calc(100dvh - 24px)"
              : "min(440px, calc(100dvh - 32px))",
          }}
          initial={{ opacity: 0, scale: 0.96, y: compact ? 0 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: compact ? 0 : -3 }}
          transition={{ duration: MOTION_VOCABULARY.durations.micro, ease: MOTION_VOCABULARY.easings.standard }}
        >
          {compact ? (
            <CompactRoleGrid
              bots={bots}
              activeBotId={activeBotId}
              recommendedBotId={recommendedBotId}
              paletteOverrides={paletteOverrides}
              onPick={(id) => {
                onSelectBot(id);
                onClose();
              }}
            />
          ) : (
            <>
              <div
                className="bot-list sc"
                onMouseLeave={() => setHoveredId(null)}
                onKeyDown={handleListKeyDown}
              >
                {pillRect && (
                  <motion.div
                    className="bot-menu-pill"
                    aria-hidden="true"
                    style={{ "--pill-c": pillRect.color } as React.CSSProperties}
                    initial={false}
                    animate={{
                      x: pillRect.x,
                      y: pillRect.y,
                      width: pillRect.w,
                      height: pillRect.h,
                    }}
                    transition={{
                      type: "spring",
                      stiffness: 520,
                      damping: 38,
                      mass: 0.5,
                    }}
                  />
                )}
                {renderBotRow(
                  "momo",
                  "rest",
                  "Momo",
                  LOOK_JOBS.rest || "Otomatis ikuti topik"
                )}

                {customBots.length > 0 && (
                  <>
                    <div className="label">Buatan kamu</div>
                    {customBots.map((b) =>
                      renderBotRow(b.id, b.look, b.name, b.job, true)
                    )}
                  </>
                )}

                {PRESET_BOT_GROUPS.map(([groupLabel, lookList]) => (
                  <React.Fragment key={groupLabel}>
                    <div className="label">{groupLabel}</div>
                    {lookList.map((look) =>
                      renderBotRow(
                        `preset:${look}`,
                        look,
                        LOOK_NAMES[look] || look,
                        LOOK_JOBS[look] || ""
                      )
                    )}
                  </React.Fragment>
                ))}
              </div>

              {onOpenNewBot && (
                <div className="bot-menu-foot">
                  <button
                    type="button"
                    role="menuitem"
                    className="bot-menu-new"
                    onClick={() => {
                      onClose();
                      onOpenNewBot();
                    }}
                  >
                    <span>+ Buat Bot...</span>
                  </button>
                </div>
              )}
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Compact menus live inside chat bubbles whose motion transforms/filters would
  // otherwise become the containing block for `position: fixed`.
  return compact && typeof document !== "undefined"
    ? createPortal(tree, document.body)
    : tree;
};

export interface BotFormPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  paletteOverrides: Record<string, string>;
  onCreateBot: (name: string, job: string, look: string) => void;
  onClose: () => void;
}

interface BotFormInnerProps extends BotFormPopoverProps {}

const BotFormInner: React.FC<BotFormInnerProps> = ({
  open,
  anchorRef,
  paletteOverrides,
  onCreateBot,
  onClose,
}) => {
  const formRef = useRef<HTMLFormElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [job, setJob] = useState("");
  useDismissOnOutside(open, formRef, anchorRef, onClose);

  const previewLook = inferLookByKeyword(job || name);
  const previewLookName =
    previewLook === "rest"
      ? "Default Momo"
      : `${LOOK_NAMES[previewLook] || previewLook} (${LOOK_JOBS[previewLook] || "Custom"})`;

  const formPositionRef = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      if (!el) return;
      const update = () => {
        const pos = computeAnchorPosition(anchorRef.current, 300, 250);
        el.style.top = `${pos.top}px`;
        el.style.left = `${pos.left}px`;
        el.style.transformOrigin = pos.origin;
      };
      update();
      window.addEventListener("resize", update);
      return () => {
        window.removeEventListener("resize", update);
        if (formRef.current === el) {
          formRef.current = null;
        }
      };
    },
    [anchorRef]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim() || "Momo Custom";
    const cleanJob = job.trim() || LOOK_JOBS[previewLook] || "Asisten pribadi";
    onCreateBot(cleanName, cleanJob, previewLook);
    onClose();
  };

  return (
    <motion.form
      ref={formPositionRef}
      id="botForm"
      className="pop bot-form open"
      onSubmit={handleSubmit}
      onAnimationComplete={(definition) => {
        if (
          definition &&
          typeof definition === "object" &&
          "opacity" in definition &&
          definition.opacity === 1
        ) {
          nameInputRef.current?.focus();
        }
      }}
      initial={{ opacity: 0, scale: 0.94, y: -5, filter: "blur(5px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.95, y: -3, filter: "blur(4px)" }}
      transition={{ duration: MOTION_VOCABULARY.durations.fast, ease: MOTION_VOCABULARY.easings.standard }}
    >
      <div className="bot-form-head">
        <MomoMiniCanvas
          look={previewLook}
          size={44}
          paletteOverrides={paletteOverrides}
          ariaLabel="Pratinjau kostum Momo"
        />
        <div>
          <h2>Buat asisten custom</h2>
          <p>Kostum preview: {previewLookName}</p>
        </div>
      </div>

      <input
        ref={nameInputRef}
        className="field"
        type="text"
        placeholder="Nama (mis. Mimo)"
        maxLength={28}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        className="field"
        type="text"
        placeholder="Tugas (mis. Masak, Budget, Bug)"
        maxLength={64}
        value={job}
        onChange={(e) => setJob(e.target.value)}
      />

      <div className="bot-form-actions">
        <button type="button" className="keybtn" onClick={onClose}>
          Batal
        </button>
        <button type="submit" className="keybtn primary" disabled={!name.trim()}>
          Pakai peran
        </button>
      </div>
    </motion.form>
  );
};

export const BotFormPopover: React.FC<BotFormPopoverProps> = ({
  open,
  anchorRef,
  paletteOverrides,
  onCreateBot,
  onClose,
}) => (
  <AnimatePresence>
    {open && (
      <BotFormInner
        open={open}
        anchorRef={anchorRef}
        paletteOverrides={paletteOverrides}
        onCreateBot={onCreateBot}
        onClose={onClose}
      />
    )}
  </AnimatePresence>
);

export interface ProfileMenuPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  dark: boolean;
  offline: boolean;
  autoSpeak: boolean;
  activeLook: string;
  paletteOverrides: Record<string, string>;
  activeBotName: string;
  activeRoleColor: string;
  hasActiveMessages: boolean;
  onSetTheme: (nextDark: boolean) => void;
  onSetOffline: (nextOffline: boolean) => void;
  onToggleAutoSpeak: () => void;
  onResetSession: () => void;
  onClose: () => void;
}

export const ProfileMenuPopover: React.FC<ProfileMenuPopoverProps> = ({
  open,
  anchorRef,
  dark,
  offline,
  autoSpeak,
  activeLook,
  paletteOverrides,
  activeBotName,
  activeRoleColor,
  hasActiveMessages,
  onSetTheme,
  onSetOffline,
  onToggleAutoSpeak,
  onResetSession,
  onClose,
}) => {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pillRect, setPillRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
  } | null>(null);
  useDismissOnOutside(open, popRef, anchorRef, onClose);

  // The optional password login (MOMO_PASSWORD) leaves a marker cookie; only then is there something to sign out of.
  const [canSignOut, setCanSignOut] = useState(false);
  useEffect(() => {
    if (open) setCanSignOut(/(?:^|;\s*)momo_auth=1(?:;|$)/.test(document.cookie));
  }, [open]);

  const menuPositionRef = useCallback(
    (el: HTMLDivElement | null) => {
      popRef.current = el;
      if (!el) return;
      const update = () => {
        const measuredH = el.offsetHeight || 292;
        const pos = computeAnchorPosition(anchorRef.current, 290, measuredH);
        el.style.top = `${pos.top}px`;
        el.style.left = `${pos.left}px`;
        el.style.transformOrigin = pos.origin;
      };
      update();
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      return () => {
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        if (popRef.current === el) {
          popRef.current = null;
        }
      };
    },
    [anchorRef]
  );

  const activeHighlightId = hoveredId;

  useLayoutEffect(() => {
    if (!open || !activeHighlightId) {
      setPillRect(null);
      return;
    }
    const measure = () => {
      const btn = rowRefs.current.get(activeHighlightId);
      if (!btn) {
        setPillRect(null);
        return;
      }
      setPillRect({
        x: btn.offsetLeft,
        y: btn.offsetTop,
        w: btn.offsetWidth,
        h: btn.offsetHeight,
        color: activeHighlightId === "offline-toggle" && offline ? "#8e8e96" : activeRoleColor,
      });
    };
    measure();
  }, [open, activeHighlightId, activeRoleColor, offline, dark, autoSpeak]);

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-profile-item="true"]')
    );
    if (!items.length) return;
    e.preventDefault();
    const cur = items.findIndex((el) => el === document.activeElement);
    let nextIdx = 0;
    if (e.key === "ArrowDown") nextIdx = cur >= 0 ? (cur + 1) % items.length : 0;
    else if (e.key === "ArrowUp") nextIdx = cur >= 0 ? (cur - 1 + items.length) % items.length : items.length - 1;
    else if (e.key === "End") nextIdx = items.length - 1;
    items[nextIdx]?.focus();
  };

  return (
    <AnimatePresence
      onExitComplete={() => {
        setHoveredId(null);
        setPillRect(null);
      }}
    >
      {open && (
        <motion.div
          ref={menuPositionRef}
          id="profileMenu"
          className="pop bot-menu profile-menu open"
          role="menu"
          aria-label="Menu profil dan pengaturan"
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={{ duration: MOTION_VOCABULARY.durations.micro, ease: MOTION_VOCABULARY.easings.standard }}
        >
          <div className="profile-menu-head">
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
            <div className="profile-menu-id">
              <strong>Alex</strong>
              <span>{activeBotName} · {offline ? "Offline" : "Online"}</span>
            </div>
            <span className="skw-badge" style={{ flex: "none" }}>
              Pro
            </span>
          </div>

          <div className="label" style={{ paddingTop: 4 }}>Tampilan</div>
          <div className="profile-theme-switch" role="radiogroup" aria-label="Pilih tema">
            <div className="profile-theme-track">
              <button
                id="themeLightItem"
                type="button"
                role="menuitemradio"
                aria-checked={!dark}
                className={`profile-theme-opt${!dark ? " is-active" : ""}`}
                onClick={() => onSetTheme(false)}
              >
                {!dark && (
                  <motion.span
                    layoutId="profile-theme-thumb"
                    className="profile-theme-thumb"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                )}
                <span className="profile-theme-label">
                  <motion.svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    animate={{ rotate: !dark ? 0 : -45, scale: !dark ? 1 : 0.88 }}
                    transition={{ duration: 0.28, ease: EASE_MOMO }}
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </motion.svg>
                  Terang
                </span>
              </button>

              <button
                id="themeDarkItem"
                type="button"
                role="menuitemradio"
                aria-checked={dark}
                className={`profile-theme-opt${dark ? " is-active" : ""}`}
                onClick={() => onSetTheme(true)}
              >
                {dark && (
                  <motion.span
                    layoutId="profile-theme-thumb"
                    className="profile-theme-thumb"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                )}
                <span className="profile-theme-label">
                  <motion.svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    animate={{ rotate: dark ? 0 : 25, scale: dark ? 1 : 0.88 }}
                    transition={{ duration: 0.28, ease: EASE_MOMO }}
                  >
                    <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z" />
                  </motion.svg>
                  Gelap
                </span>
              </button>
            </div>
          </div>

          <div
            className="bot-list sc"
            onMouseLeave={() => setHoveredId(null)}
            onKeyDown={handleListKeyDown}
          >
            {pillRect && (
              <motion.div
                className="bot-menu-pill"
                aria-hidden="true"
                style={{ "--pill-c": pillRect.color } as React.CSSProperties}
                initial={false}
                animate={{
                  x: pillRect.x,
                  y: pillRect.y,
                  width: pillRect.w,
                  height: pillRect.h,
                }}
                transition={{
                  type: "spring",
                  stiffness: 520,
                  damping: 38,
                  mass: 0.5,
                }}
              />
            )}

            <div className="label" style={{ paddingTop: 6 }}>Pengaturan</div>
            <div style={{ display: "flex", alignItems: "center", paddingLeft: 4 }}>
              <motion.button
                id="offlineToggleItem"
                ref={(el) => {
                  if (el) rowRefs.current.set("offline-toggle", el);
                  else rowRefs.current.delete("offline-toggle");
                }}
                type="button"
                data-profile-item="true"
                role="menuitemcheckbox"
                aria-checked={offline}
                className={`profile-menu-row${offline ? " on" : ""}`}
                whileTap={{ scale: 0.985 }}
                transition={{ duration: 0.14, ease: EASE_MOMO }}
                onMouseEnter={() => setHoveredId("offline-toggle")}
                onFocus={() => setHoveredId("offline-toggle")}
                onClick={() => onSetOffline(!offline)}
              >
                <span
                  className="dotc"
                  style={{ "--c": offline ? "#8e8e96" : "var(--ok, #1f7a4c)" } as React.CSSProperties}
                />
                <span className="nm">Mode Offline</span>
                <span className="job">{offline ? "Topi sembunyi" : "Online"}</span>
                <span className={`skw-toggle-track${offline ? " is-on" : ""}`} aria-hidden="true">
                  <motion.span
                    layout
                    className="skw-toggle-thumb"
                    transition={{ type: "spring", stiffness: 520, damping: 34 }}
                  />
                </span>
              </motion.button>
            </div>

            <div style={{ display: "flex", alignItems: "center", paddingLeft: 4 }}>
              <motion.button
                id="autoSpeakToggleItem"
                ref={(el) => {
                  if (el) rowRefs.current.set("autospeak-toggle", el);
                  else rowRefs.current.delete("autospeak-toggle");
                }}
                type="button"
                data-profile-item="true"
                role="menuitemcheckbox"
                aria-checked={autoSpeak}
                className={`profile-menu-row${autoSpeak ? " on" : ""}`}
                whileTap={{ scale: 0.985 }}
                transition={{ duration: 0.14, ease: EASE_MOMO }}
                onMouseEnter={() => setHoveredId("autospeak-toggle")}
                onFocus={() => setHoveredId("autospeak-toggle")}
                onClick={() => onToggleAutoSpeak()}
              >
                <MomoIcon name="sound" size={15} />
                <span className="nm">Suara Otomatis</span>
                <span className="job">{autoSpeak ? "Aktif" : "Mati"}</span>
                <span className={`skw-toggle-track${autoSpeak ? " is-on" : ""}`} aria-hidden="true">
                  <motion.span
                    layout
                    className="skw-toggle-thumb"
                    transition={{ type: "spring", stiffness: 520, damping: 34 }}
                  />
                </span>
              </motion.button>
            </div>
          </div>

          <div className="bot-menu-foot">
            <button
              id="profileResetSessionBtn"
              type="button"
              role="menuitem"
              className="bot-menu-new"
              onClick={() => {
                onResetSession();
                onClose();
              }}
            >
              <span>{hasActiveMessages ? "Reset Sesi Aktif" : "+ Obrolan Baru"}</span>
            </button>
            {canSignOut && (
              <button
                id="profileSignOutBtn"
                type="button"
                role="menuitem"
                className="bot-menu-new"
                style={{ marginTop: 6 }}
                onClick={() => {
                  void fetch("/api/logout", { method: "POST", headers: { Accept: "application/json" } })
                    .catch(() => undefined)
                    .then(() => window.location.assign("/login"));
                }}
              >
                <span>Keluar</span>
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
