/**
 * The confirmation card for a FamHub write, as the browser keeps it on a chat
 * turn. Pure and free of Node imports: the client, the server and the tests
 * share it.
 *
 * The card never holds the action itself, only the proposal id and the rows
 * that were shown. What gets written is decided by the server-side store
 * (`writeProposals.ts`), so nothing kept here can change a write.
 */

export interface WriteProposalRow {
  label: string;
  value: string;
}

export type WriteProposalStatus = "pending" | "saved" | "cancelled" | "expired" | "error";

export interface WriteProposalCard {
  id: string;
  title: string;
  rows: WriteProposalRow[];
  /** Epoch ms after which the server refuses the id. */
  expiresAt: number;
  status: WriteProposalStatus;
  error?: string;
}

export interface WriteProposalView {
  state: WriteProposalStatus;
  /** Whether "Simpan" / "Batal" may be offered. */
  actionable: boolean;
  /** The terminal line under the rows; empty while the card waits. */
  text: string;
}

/** What the card shows at `now`: a waiting proposal turns into "expired" by itself. */
export function proposalView(card: WriteProposalCard, now: number = Date.now()): WriteProposalView {
  if (card.status === "saved") return { state: "saved", actionable: false, text: "Tersimpan ke FamHub" };
  if (card.status === "cancelled") return { state: "cancelled", actionable: false, text: "Dibatalkan" };
  if (card.status === "error") return { state: "error", actionable: false, text: card.error || "Gagal menyimpan ke FamHub" };
  if (card.status === "expired" || !(card.expiresAt > now)) {
    return { state: "expired", actionable: false, text: "Kedaluwarsa, tidak disimpan" };
  }
  return { state: "pending", actionable: true, text: "" };
}

const HISTORY_LABEL: Record<WriteProposalStatus, string> = {
  pending: "BELUM dikonfirmasi, belum tersimpan",
  saved: "DISIMPAN oleh pengguna",
  cancelled: "DIBATALKAN oleh pengguna, tidak tersimpan",
  expired: "KEDALUWARSA, tidak tersimpan",
  error: "GAGAL disimpan",
};

/** One line for the chat history sent back to the model, so a later turn knows what became of a proposal. */
export function proposalHistoryLine(card: WriteProposalCard, now: number = Date.now()): string {
  const what = card.rows.map((r) => `${r.label}: ${r.value}`).join(", ");
  return `[FamHub: usulan (${what}) — ${HISTORY_LABEL[proposalView(card, now).state]}]`;
}
