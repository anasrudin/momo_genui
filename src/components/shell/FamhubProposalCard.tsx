"use client";

import React, { memo, useEffect, useId, useState } from "react";
import { AlertTriangle, Check, Clock, X } from "lucide-react";
import { proposalView, type WriteProposalCard } from "@/lib/famhub/proposalCard";

interface FamhubProposalCardProps {
  card: WriteProposalCard;
  /** Records the outcome on the turn, so a reload shows it instead of live buttons. */
  onChange: (id: string, patch: Pick<WriteProposalCard, "status" | "error">) => void;
}

const GONE_TEXT = "Sudah tidak berlaku (kedaluwarsa atau sudah diproses). Cek FamHub sebelum mencatat ulang.";

async function post(path: string, id: string): Promise<{ status: number; error?: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // only the id: what gets written is the action the server stored when it showed this card
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const error = typeof body?.error === "string" && body.error !== "unauthorized" && body.error !== "not_found" ? body.error : undefined;
    return { status: res.status, error };
  } catch {
    return { status: 0 };
  }
}

/**
 * "Catat ke FamHub?" — the model proposed a write; this card is where the
 * human decides. Nothing reaches FamHub unless "Simpan" is pressed here.
 */
export const FamhubProposalCard = memo(function FamhubProposalCard({ card, onChange }: FamhubProposalCardProps) {
  const titleId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<"save" | "cancel" | null>(null);
  const view = proposalView(card, now);

  // flip to "expired" by itself when the server would stop accepting the id
  useEffect(() => {
    if (card.status !== "pending") return;
    const left = card.expiresAt - Date.now();
    if (!(left > 0)) {
      setNow(Date.now());
      return;
    }
    const t = window.setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2_000_000_000));
    return () => window.clearTimeout(t);
  }, [card.status, card.expiresAt]);

  const save = async () => {
    if (busy || !proposalView(card, Date.now()).actionable) return setNow(Date.now());
    setBusy("save");
    const res = await post("/api/famhub/confirm", card.id);
    setBusy(null);
    if (res.status === 200) return onChange(card.id, { status: "saved" });
    if (res.status === 410) return onChange(card.id, { status: "error", error: GONE_TEXT });
    if (res.status === 401) return onChange(card.id, { status: "error", error: "Sesi login habis. Tidak disimpan; masuk lagi lalu minta usulan baru." });
    if (res.status === 404) return onChange(card.id, { status: "error", error: "Pencatatan ke FamHub sedang dimatikan di server. Tidak disimpan." });
    onChange(card.id, {
      status: "error",
      error: res.error
        ? `Tidak disimpan. FamHub: ${res.error}`
        : "FamHub tidak bisa dihubungi. Belum tentu tersimpan: cek di FamHub.",
    });
  };

  const cancel = async () => {
    if (busy) return;
    setBusy("cancel");
    await post("/api/famhub/cancel", card.id);
    setBusy(null);
    // whatever the server answered, this card is done: a cancelled card never saves
    onChange(card.id, { status: "cancelled" });
  };

  const Icon = view.state === "saved" ? Check : view.state === "cancelled" ? X : view.state === "expired" ? Clock : AlertTriangle;

  return (
    <section className="momo-famhub-card" data-state={busy ? "busy" : view.state} role="group" aria-labelledby={titleId}>
      <header className="momo-famhub-card__head">
        <span className="momo-famhub-card__app" aria-hidden="true">
          FamHub
        </span>
        <h3 id={titleId} className="momo-famhub-card__title">
          {card.title}
        </h3>
      </header>

      <dl className="momo-famhub-card__rows">
        {card.rows.map((row) => (
          <div key={row.label} className="momo-famhub-card__row" data-row={row.label === "Jumlah" ? "amount" : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {view.actionable ? (
        <div className="momo-famhub-card__actions">
          <button type="button" className="momo-famhub-card__btn is-primary" onClick={save} disabled={busy !== null} aria-busy={busy === "save"}>
            {busy === "save" ? "Menyimpan…" : "Simpan"}
          </button>
          <button type="button" className="momo-famhub-card__btn" onClick={cancel} disabled={busy !== null} aria-busy={busy === "cancel"}>
            Batal
          </button>
          <span className="momo-famhub-card__hint">Belum disimpan</span>
        </div>
      ) : null}

      {/* always mounted, so a screen reader hears the outcome when it appears */}
      <p className="momo-famhub-card__status" data-state={view.state} role="status" aria-live="polite">
        {view.text ? (
          <>
            <Icon size={14} strokeWidth={2.1} aria-hidden="true" />
            <span>{view.text}</span>
          </>
        ) : null}
      </p>
    </section>
  );
});
