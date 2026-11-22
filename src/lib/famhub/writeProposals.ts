/**
 * Recording things in FamHub from a chat, with the human in the loop.
 *
 * The model can only PROPOSE a write (`famhub_propose`). The proposal is
 * validated and turned into one of FamHub's own actions here, kept in memory
 * under a random id for ten minutes, and shown to the user as a card. FamHub's
 * write API is called only by `confirmProposal`, which the confirm endpoint
 * runs when the user presses "Simpan" — and it sends the stored action, never
 * anything the browser or the model supplies at that point.
 *
 * Off unless MOMO_FAMHUB_WRITE=1, MOMO_FAMHUB_URL, MOMO_FAMHUB_MEMBER and
 * MOMO_PASSWORD are all set: a write feature must not exist without the login.
 *
 * Nothing here parses free text. The model supplies structured arguments;
 * this module validates them. Money is whole rupiah.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { SESSION_COOKIE, authConfig, verifySession } from "@/lib/auth/session";
import type { WriteProposalRow } from "./proposalCard";

export const FAMHUB_PROPOSE_TOOL = "famhub_propose";
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

type Env = Record<string, string | undefined>;

/**
 * FamHub's `ExpenseCategory`, minus `reward` and `savings`: FamHub's own entry
 * form does not offer those two to a parent, they belong to its automations.
 * Labels are the ones FamHub shows (`src/lib/labels.ts` there).
 */
export const FAMHUB_CATEGORIES = [
  { id: "groceries", label: "Belanja" },
  { id: "bills", label: "Tagihan" },
  { id: "transport", label: "Transport" },
  { id: "education", label: "Pendidikan" },
  { id: "health", label: "Kesehatan" },
  { id: "home", label: "Rumah" },
  { id: "fun", label: "Hiburan" },
  { id: "allowance", label: "Uang saku" },
  { id: "other", label: "Lainnya" },
] as const;

export type FamhubCategory = (typeof FAMHUB_CATEGORIES)[number]["id"];

const categoryLabel = (id: FamhubCategory) => FAMHUB_CATEGORIES.find((c) => c.id === id)!.label;
const isCategory = (v: unknown): v is FamhubCategory => FAMHUB_CATEGORIES.some((c) => c.id === v);

/* ------------------------------------------------------------------ gating */

export interface FamhubWriteConfig {
  /** FamHub's base URL, no trailing slash. */
  url: string;
  /** Name of the FamHub member Momo writes as. */
  member: string;
}

/** Null unless every condition holds. Read at run time, like the login. */
export function famhubWriteConfig(env: Env = process.env): FamhubWriteConfig | null {
  if (env.MOMO_FAMHUB_WRITE !== "1") return null;
  if (!env.MOMO_PASSWORD) return null;
  const url = (env.MOMO_FAMHUB_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return null;
  const member = (env.MOMO_FAMHUB_MEMBER ?? "").trim();
  if (!member) return null;
  return { url, member };
}

export interface FamhubContext {
  config: FamhubWriteConfig;
  actor: { id: string; name: string };
  /** Every wallet: the actor is a parent, and FamHub lets a parent use all of them. */
  wallets: Array<{ id: string; name: string }>;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

interface FamilyLike {
  members?: unknown;
  wallets?: unknown;
}

/** Member name → id, from the household `GET /api/family` returns. Pure. */
export function resolveFamhubContext(
  config: FamhubWriteConfig,
  family: FamilyLike | null | undefined,
): { ok: true; context: FamhubContext } | { ok: false; reason: string } {
  if (!family || !Array.isArray(family.members) || !Array.isArray(family.wallets)) {
    return { ok: false, reason: "FamHub belum punya data keluarga (GET /api/family kosong)" };
  }
  const members = (family.members as Array<{ id?: unknown; name?: unknown; role?: unknown }>).filter(
    (m) => m && typeof m.id === "string" && typeof m.name === "string",
  );
  const hits = members.filter((m) => norm(m.name as string) === norm(config.member));
  if (hits.length === 0) return { ok: false, reason: `anggota "${config.member}" (MOMO_FAMHUB_MEMBER) tidak ditemukan di FamHub` };
  if (hits.length > 1) return { ok: false, reason: `lebih dari satu anggota FamHub bernama "${config.member}"` };
  if (hits[0].role !== "admin") return { ok: false, reason: `anggota "${config.member}" bukan admin (orang tua) di FamHub` };
  const wallets = (family.wallets as Array<{ id?: unknown; name?: unknown }>)
    .filter((w) => w && typeof w.id === "string" && typeof w.name === "string")
    .map((w) => ({ id: w.id as string, name: w.name as string }));
  return { ok: true, context: { config, actor: { id: hits[0].id as string, name: hits[0].name as string }, wallets } };
}

const CONTEXT_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/** The context is read before a chat turn starts streaming, so a FamHub that is down must not hold the turn up for long. */
const CONTEXT_TIMEOUT_MS = 3_000;
let contextCache: { at: number; key: string; context: FamhubContext | null } | null = null;
let lastLoggedReason = "";

export function resetFamhubContextCache(opts: { keepLogged?: boolean } = {}): void {
  contextCache = null;
  if (!opts.keepLogged) lastLoggedReason = "";
}

/**
 * The acting member and the wallets, read from FamHub (`GET /api/family`, read-only).
 * Null — feature off — when FamHub cannot be read or the member does not resolve
 * to a parent; the reason goes to the server log once.
 */
export async function loadFamhubContext(
  config: FamhubWriteConfig,
  opts: { fetchImpl?: typeof fetch; now?: number; log?: (line: string) => void } = {},
): Promise<FamhubContext | null> {
  const now = opts.now ?? Date.now();
  const key = `${config.url}\n${config.member}`;
  if (contextCache && contextCache.key === key && now - contextCache.at < CONTEXT_CACHE_MS) return contextCache.context;

  let result: ReturnType<typeof resolveFamhubContext>;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${config.url}/api/family`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: FamilyLike | null };
    result = resolveFamhubContext(config, body?.data);
  } catch (e) {
    result = { ok: false, reason: `FamHub tidak terbaca di ${config.url} (${(e as Error).message})` };
  }

  const context = result.ok ? result.context : null;
  if (!result.ok && result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    (opts.log ?? console.warn)(`[momo] FamHub write is OFF: ${result.reason}`);
  }
  if (result.ok) lastLoggedReason = "";
  contextCache = { at: now, key, context };
  return context;
}

/* ------------------------------------------- proposals → FamHub's actions */

/** The two FamHub actions this feature can send, field for field as FamHub's `Action` type declares them. */
export type FamhubAction =
  | { type: "transaction/add"; id: string; walletId: string; amount: number; category: FamhubCategory; note: string; date: string }
  | { type: "bill/add"; bill: { id: string; name: string; amount: number; dayOfMonth: number; category: FamhubCategory } };

export interface StoredProposal {
  kind: "transaction" | "bill";
  /** Sent to FamHub as-is on confirm. */
  action: FamhubAction;
  actorId: string;
  title: string;
  /** What the user is shown, and therefore what they agree to. */
  rows: WriteProposalRow[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export function formatRupiah(n: number): string {
  return `Rp${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const formatDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** The server's local calendar date, which is what FamHub's own screens use for "today". */
export function localToday(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A whole number as a number or a digits-only string; anything else (including "150 ribu") is not an amount. */
function wholeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

const optionalText = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const CATEGORY_HINT = `category harus salah satu dari: ${FAMHUB_CATEGORIES.map((c) => c.id).join(", ")}`;

type BuildResult = { ok: true; proposal: StoredProposal } | { ok: false; error: string };

/**
 * Validates the model's arguments and builds the FamHub action. Returns an
 * error sentence (for the model to relay) instead of a proposal when anything
 * is off; nothing is guessed or repaired.
 */
export function buildProposal(
  args: Record<string, unknown>,
  ctx: FamhubContext,
  opts: { today?: string; newId?: () => string } = {},
): BuildResult {
  const fail = (error: string): BuildResult => ({ ok: false, error });
  const newId = opts.newId ?? randomUUID;
  const kind = args.kind;
  if (kind !== "transaction" && kind !== "bill") return fail('kind harus "transaction" atau "bill"');

  const amount = wholeNumber(args.amount);
  if (amount === null || amount <= 0) return fail("amount harus bilangan bulat rupiah lebih dari 0 (contoh 150000), tanpa tanda minus");

  if (args.category !== undefined && args.category !== null && args.category !== "" && !isCategory(args.category)) return fail(CATEGORY_HINT);
  const actorRow = { label: "Dicatat oleh", value: ctx.actor.name };

  if (kind === "bill") {
    const name = optionalText(args.name);
    if (!name || name.length > 80) return fail("name (nama tagihan) wajib diisi, paling panjang 80 karakter");
    const day = wholeNumber(args.dayOfMonth);
    if (day === null || day < 1 || day > 28) return fail("dayOfMonth harus tanggal 1 sampai 28 (FamHub tidak menerima 29-31)");
    const category: FamhubCategory = isCategory(args.category) ? args.category : "bills";
    return {
      ok: true,
      proposal: {
        kind,
        action: { type: "bill/add", bill: { id: newId(), name, amount, dayOfMonth: day, category } },
        actorId: ctx.actor.id,
        title: "Catat ke FamHub?",
        rows: [
          { label: "Tagihan rutin", value: name },
          { label: "Jumlah", value: formatRupiah(amount) },
          { label: "Jatuh tempo", value: `Tiap tanggal ${day}` },
          { label: "Kategori", value: categoryLabel(category) },
          actorRow,
        ],
      },
    };
  }

  const direction = args.direction;
  if (direction !== "out" && direction !== "in") return fail('direction harus "out" (pengeluaran) atau "in" (pemasukan)');

  const walletName = optionalText(args.wallet);
  const available = ctx.wallets.map((w) => w.name).join(", ");
  if (!walletName) return fail(`wallet (nama dompet) wajib diisi. Dompet yang ada: ${available}`);
  const matches = ctx.wallets.filter((w) => norm(w.name) === norm(walletName));
  if (matches.length === 0) return fail(`Dompet "${walletName}" tidak ditemukan. Dompet yang ada: ${available}`);
  if (matches.length > 1) return fail(`Ada lebih dari satu dompet bernama "${walletName}"; tidak bisa dipilih dari sini`);

  const date = args.date === undefined || args.date === null || args.date === "" ? (opts.today ?? localToday()) : args.date;
  if (typeof date !== "string" || !isRealDate(date)) return fail("date harus tanggal nyata berformat YYYY-MM-DD");

  const category: FamhubCategory = isCategory(args.category) ? args.category : "other";
  const typedNote = optionalText(args.note);
  if (typedNote.length > 200) return fail("note paling panjang 200 karakter");
  // FamHub's own form falls back to the category label when the note is empty
  const note = typedNote || categoryLabel(category);

  return {
    ok: true,
    proposal: {
      kind,
      action: {
        type: "transaction/add",
        id: newId(),
        walletId: matches[0].id,
        amount: direction === "out" ? -amount : amount,
        category,
        note,
        date,
      },
      actorId: ctx.actor.id,
      title: "Catat ke FamHub?",
      rows: [
        { label: "Jenis", value: direction === "out" ? "Pengeluaran" : "Pemasukan" },
        { label: "Jumlah", value: formatRupiah(amount) },
        { label: "Dompet", value: matches[0].name },
        { label: "Kategori", value: categoryLabel(category) },
        { label: "Catatan", value: note },
        { label: "Tanggal", value: formatDate(date) },
        actorRow,
      ],
    },
  };
}

/* ------------------------------------------------------------------- store */

/** Pending proposals, in memory: this app is one process, and a restart simply forgets them. */
export class ProposalStore {
  private items = new Map<string, { proposal: StoredProposal; expiresAt: number }>();

  constructor(private max = 200) {}

  get size(): number {
    return this.items.size;
  }

  private sweep(now: number): void {
    for (const [id, item] of this.items) if (item.expiresAt <= now) this.items.delete(id);
  }

  put(proposal: StoredProposal, now: number = Date.now()): { id: string; expiresAt: number } {
    this.sweep(now);
    // a Map iterates in insertion order, so the first key is the oldest
    while (this.items.size >= this.max) this.items.delete(this.items.keys().next().value as string);
    const id = randomBytes(16).toString("hex");
    const expiresAt = now + PROPOSAL_TTL_MS;
    this.items.set(id, { proposal, expiresAt });
    return { id, expiresAt };
  }

  /** Removes and returns the proposal: confirming and cancelling both spend the id. */
  take(id: unknown, now: number = Date.now()): StoredProposal | null {
    if (typeof id !== "string" || !id) return null;
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    return item.expiresAt > now ? item.proposal : null;
  }
}

const STORE_KEY = Symbol.for("momo.famhub.proposalStore");

/** One store for the whole process, also when the bundler gives two routes their own copy of this module. */
export function proposalStore(): ProposalStore {
  const g = globalThis as unknown as Record<symbol, ProposalStore | undefined>;
  return (g[STORE_KEY] ??= new ProposalStore());
}

/* ----------------------------------------------------------------- confirm */

export interface ConfirmResult {
  status: number;
  body: Record<string, unknown>;
}

const GONE: ConfirmResult = {
  status: 410,
  body: { ok: false, error: "Usulan ini sudah tidak berlaku (kedaluwarsa, dibatalkan, atau sudah diproses)." },
};

/** The one place FamHub's write API is called: the stored action, as the stored actor, once. */
export async function confirmProposal(
  store: ProposalStore,
  config: FamhubWriteConfig,
  id: unknown,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<ConfirmResult> {
  const proposal = store.take(id, opts.now);
  if (!proposal) return GONE;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${config.url}/api/family/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({ action: proposal.action, actorId: proposal.actorId }),
    });
    const body = (await res.json().catch(() => null)) as { version?: unknown; error?: unknown } | null;
    if (res.ok) return { status: 200, body: { ok: true, ...(typeof body?.version === "number" ? { version: body.version } : {}) } };
    return {
      status: res.status >= 400 && res.status < 600 ? res.status : 502,
      body: { ok: false, error: typeof body?.error === "string" ? body.error : `FamHub menolak (HTTP ${res.status}).` },
    };
  } catch {
    return { status: 502, body: { ok: false, error: "FamHub tidak bisa dihubungi. Belum tentu tersimpan: cek di FamHub, lalu minta usulan baru bila perlu." } };
  }
}

export function cancelProposal(store: ProposalStore, id: unknown, now?: number): boolean {
  return store.take(id, now) !== null;
}

/* ------------------------------------------------- what the model is told */

export function famhubProposeDeclaration(ctx: FamhubContext): { name: string; description: string; parameters: unknown } {
  const wallets = ctx.wallets.map((w) => `"${w.name}"`).join(", ");
  return {
    name: FAMHUB_PROPOSE_TOOL,
    description:
      `Mengusulkan satu pencatatan di FamHub (aplikasi keluarga milik pengguna): transaksi (kind "transaction") atau tagihan rutin bulanan (kind "bill"). ` +
      `Tool ini TIDAK menyimpan apa pun: pengguna melihat kartu konfirmasi dan menekan Simpan atau Batal sendiri. ` +
      `Dompet yang ada: ${wallets}. Uang selalu rupiah bulat (150 ribu = 150000).`,
    parameters: {
      type: "OBJECT",
      required: ["kind", "amount"],
      properties: {
        kind: { type: "STRING", enum: ["transaction", "bill"], description: "transaction = satu pemasukan/pengeluaran; bill = tagihan rutin tiap bulan." },
        amount: { type: "INTEGER", description: "Rupiah bulat, selalu positif (arah uang ada di `direction`)." },
        direction: { type: "STRING", enum: ["out", "in"], description: "Hanya transaction, wajib: out = pengeluaran, in = pemasukan." },
        wallet: { type: "STRING", description: `Hanya transaction, wajib: nama dompet persis, salah satu dari ${wallets}.` },
        category: {
          type: "STRING",
          enum: FAMHUB_CATEGORIES.map((c) => c.id),
          description: `Kategori FamHub: ${FAMHUB_CATEGORIES.map((c) => `${c.id} (${c.label})`).join(", ")}. Default: other untuk transaction, bills untuk bill.`,
        },
        note: { type: "STRING", description: "Hanya transaction: catatan singkat, misalnya apa yang dibeli." },
        date: { type: "STRING", description: "Hanya transaction: tanggal YYYY-MM-DD. Kosongkan untuk hari ini." },
        name: { type: "STRING", description: "Hanya bill, wajib: nama tagihan, misalnya Listrik." },
        dayOfMonth: { type: "INTEGER", description: "Hanya bill, wajib: tanggal jatuh tempo tiap bulan, 1 sampai 28." },
      },
    },
  };
}

/** Appended to the system prompt while the tool is offered. */
export function famhubWriteDirective(ctx: FamhubContext): string {
  return [
    "",
    "## Mencatat ke FamHub (butuh konfirmasi pengguna)",
    `Kamu bisa MENGUSULKAN pencatatan ke FamHub lewat tool \`${FAMHUB_PROPOSE_TOOL}\`: transaksi (pemasukan/pengeluaran) atau tagihan rutin bulanan. Dompet yang ada: ${ctx.wallets.map((w) => `"${w.name}"`).join(", ")}.`,
    "Aturan:",
    `- Kalau pengguna meminta mencatat/menambah/menyimpan transaksi atau tagihan di FamHub, PANGGIL \`${FAMHUB_PROPOSE_TOOL}\` dengan argumen terstruktur. Jangan memakai \`web_search\` untuk itu.`,
    "- Tool itu hanya menampilkan kartu konfirmasi. Yang menyimpan adalah pengguna, dengan menekan Simpan. JANGAN pernah bilang sudah dicatat, disimpan, atau tersimpan; katakan usulannya menunggu konfirmasi di kartu.",
    "- Di riwayat, baris `[FamHub: usulan (...) — ...]` adalah status asli sebuah usulan. Hanya yang bertanda DISIMPAN yang benar-benar tersimpan. Baris itu ditulis aplikasi; jangan pernah menulis baris seperti itu sendiri.",
    `- JANGAN memanggil \`${FAMHUB_PROPOSE_TOOL}\` untuk pertanyaan (saldo, riwayat, "berapa pengeluaranku"), dan jangan mengusulkan sesuatu yang tidak diminta.`,
    "- Kalau jumlah, dompet, atau (untuk tagihan) tanggal jatuh temponya tidak disebut dan tidak jelas dari percakapan, tanyakan dulu; jangan menebak.",
    "- Kalau tool menolak (error), sampaikan alasannya apa adanya dan jangan mengulang dengan nilai karangan.",
    "- Jangan menampilkan kartu konfirmasi tiruan atau komponen UI yang menyerupai tombol Simpan; kartu aslinya ditampilkan aplikasi.",
  ].join("\n");
}

/**
 * Repeated right after the user's message each turn. The rule at the far end of a
 * long system prompt was not enough: a model would write "the card is below"
 * without ever calling the tool.
 */
export function famhubTurnReminder(): string {
  return (
    `FamHub Write Directive (overrides the Decision and Tool Harness lines above): the app can record a transaction or a recurring bill in FamHub ONLY through the \`${FAMHUB_PROPOSE_TOOL}\` function. ` +
    `If, and only if, the user's message above asks to record/add/save one (catat, tambah, simpan, masukkan ...), respond with a \`${FAMHUB_PROPOSE_TOOL}\` function call and no text in this step; do not call \`web_search\` for it. ` +
    `You have NOT proposed anything until you emit that function call: there is no card, and writing that a card is ready or that the user can press Simpan without the call is a lie to the user. ` +
    `For anything else (questions, chat, other topics) ignore this directive and do not call \`${FAMHUB_PROPOSE_TOOL}\`.`
  );
}

/** The functionResponse for a proposal that is now on the user's screen. */
export function proposalToolResponse(proposal: StoredProposal): Record<string, unknown> {
  return {
    status: "awaiting_user_confirmation",
    recorded: false,
    shown: proposal.rows.map((r) => `${r.label}: ${r.value}`).join("; "),
    note:
      "The proposal is now shown to the user as a confirmation card with Simpan / Batal. It is NOT recorded in FamHub until they press Simpan. Do not claim it was saved or recorded; say briefly that it is waiting for their confirmation on the card. Do not call this tool again for the same request.",
  };
}

/* ------------------------------------------------------ endpoint guard */

/**
 * Who may call the confirm/cancel endpoints. 404 while the feature is off, so
 * the endpoints do not exist then; 401 without a valid session. The proxy
 * already demands the session for every /api route; this checks it again, so
 * the write path does not hang on one matcher.
 */
export function famhubEndpointAccess(
  cookieHeader: string | null | undefined,
  env: Env = process.env,
  now: number = Date.now(),
): { ok: true; config: FamhubWriteConfig } | { ok: false; status: 404 | 401 } {
  const config = famhubWriteConfig(env);
  const auth = authConfig(env);
  if (!config || !auth) return { ok: false, status: 404 };
  const cookie = (cookieHeader ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!verifySession(auth.secret, cookie, now)) return { ok: false, status: 401 };
  return { ok: true, config };
}
