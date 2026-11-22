import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import {
  FAMHUB_PROPOSE_TOOL,
  PROPOSAL_TTL_MS,
  ProposalStore,
  buildProposal,
  cancelProposal,
  confirmProposal,
  famhubEndpointAccess,
  famhubProposeDeclaration,
  famhubTurnReminder,
  famhubWriteConfig,
  famhubWriteDirective,
  loadFamhubContext,
  proposalToolResponse,
  resetFamhubContextCache,
  resolveFamhubContext,
  type FamhubContext,
} from "./writeProposals";
import { authConfig, signSession } from "@/lib/auth/session";
import { proposalHistoryLine, proposalView } from "./proposalCard";

const ENV = { MOMO_FAMHUB_WRITE: "1", MOMO_FAMHUB_URL: "http://127.0.0.1:3110/", MOMO_PASSWORD: "rahasia", MOMO_FAMHUB_MEMBER: "Budi" };
const NOW = 1_800_000_000_000;

const FAMILY = {
  members: [
    { id: "m-budi", name: "Budi", role: "admin" },
    { id: "m-sari", name: "Sari", role: "admin" },
    { id: "m-raka", name: "Raka", role: "member" },
  ],
  wallets: [
    { id: "w-kas", name: "Kas keluarga", kind: "shared", ownerId: null },
    { id: "w-budi", name: "Dompet Budi", kind: "personal", ownerId: "m-budi" },
    { id: "w-raka", name: "Dompet Raka", kind: "personal", ownerId: "m-raka" },
  ],
};

const CTX: FamhubContext = {
  config: { url: "http://127.0.0.1:3110", member: "Budi" },
  actor: { id: "m-budi", name: "Budi" },
  wallets: FAMILY.wallets.map((w) => ({ id: w.id, name: w.name })),
};
const OPTS = { today: "2026-11-22", newId: () => "id-1" };

/* ---------- gating ---------- */

test("gating: on only with the flag, a URL, a member AND a login password; each missing piece turns it off", () => {
  assert.deepEqual(famhubWriteConfig(ENV), { url: "http://127.0.0.1:3110", member: "Budi" });
  for (const key of Object.keys(ENV) as Array<keyof typeof ENV>) {
    assert.equal(famhubWriteConfig({ ...ENV, [key]: undefined }), null, `${key} unset`);
    assert.equal(famhubWriteConfig({ ...ENV, [key]: "" }), null, `${key} empty`);
  }
  assert.equal(famhubWriteConfig({ ...ENV, MOMO_FAMHUB_WRITE: "0" }), null);
  assert.equal(famhubWriteConfig({ ...ENV, MOMO_FAMHUB_WRITE: "true" }), null, "only the literal 1 turns it on");
  assert.equal(famhubWriteConfig({ ...ENV, MOMO_FAMHUB_URL: "famhub.local" }), null, "not an http(s) URL");
  assert.equal(famhubWriteConfig({ ...ENV, MOMO_FAMHUB_MEMBER: "   " }), null);
  assert.equal(famhubWriteConfig({}), null);
});

test("actor: the member name resolves to an admin's id; unknown, ambiguous and non-admin members turn the feature off with a reason", () => {
  const ok = resolveFamhubContext(CTX.config, FAMILY);
  assert.ok(ok.ok);
  assert.deepEqual(ok.context.actor, { id: "m-budi", name: "Budi" });
  assert.deepEqual(ok.context.wallets.map((w) => w.id), ["w-kas", "w-budi", "w-raka"]);

  const ci = resolveFamhubContext({ ...CTX.config, member: " budi " }, FAMILY);
  assert.ok(ci.ok && ci.context.actor.id === "m-budi");

  const unknown = resolveFamhubContext({ ...CTX.config, member: "Joko" }, FAMILY);
  assert.ok(!unknown.ok && /Joko/.test(unknown.reason) && /tidak ditemukan/.test(unknown.reason));
  const child = resolveFamhubContext({ ...CTX.config, member: "Raka" }, FAMILY);
  assert.ok(!child.ok && /admin/.test(child.reason));
  const twins = resolveFamhubContext(CTX.config, { ...FAMILY, members: [...FAMILY.members, { id: "m-budi2", name: "budi", role: "admin" }] });
  assert.ok(!twins.ok && /lebih dari satu/.test(twins.reason));
  const empty = resolveFamhubContext(CTX.config, null);
  assert.ok(!empty.ok);
});

test("endpoints: 404 while the feature is off, 401 without a valid session, open only with both", () => {
  const good = `theme=dark; momo_session=${signSession(authConfig(ENV)!.secret, NOW + 60_000)}`;
  assert.deepEqual(famhubEndpointAccess(good, ENV, NOW), { ok: true, config: { url: "http://127.0.0.1:3110", member: "Budi" } });
  for (const key of Object.keys(ENV) as Array<keyof typeof ENV>) {
    assert.deepEqual(famhubEndpointAccess(good, { ...ENV, [key]: "" }, NOW), { ok: false, status: 404 }, `${key} empty`);
  }
  assert.deepEqual(famhubEndpointAccess(null, ENV, NOW), { ok: false, status: 401 });
  assert.deepEqual(famhubEndpointAccess("momo_session=", ENV, NOW), { ok: false, status: 401 });
  assert.deepEqual(famhubEndpointAccess(`momo_session=${signSession("other-secret", NOW + 60_000)}`, ENV, NOW), { ok: false, status: 401 });
  assert.deepEqual(famhubEndpointAccess(good, ENV, NOW + 120_000), { ok: false, status: 401 }, "expired session");
  assert.deepEqual(famhubEndpointAccess("momo_auth=1", ENV, NOW), { ok: false, status: 401 }, "the hint cookie is not a credential");
});

/* ---------- validation and the exact FamHub payload ---------- */

test("transaction: an expense becomes FamHub's transaction/add with a NEGATIVE whole-rupiah amount on the resolved wallet", () => {
  const r = buildProposal(
    { kind: "transaction", wallet: "kas keluarga", direction: "out", amount: 150000, category: "groceries", note: " Belanja mingguan ", date: "2026-11-20" },
    CTX,
    OPTS,
  );
  assert.ok(r.ok);
  assert.equal(r.proposal.actorId, "m-budi");
  // FamHub: { type: "transaction/add"; id; walletId; amount; category; note; date }
  assert.deepEqual(r.proposal.action, {
    type: "transaction/add",
    id: "id-1",
    walletId: "w-kas",
    amount: -150000,
    category: "groceries",
    note: "Belanja mingguan",
    date: "2026-11-20",
  });
  assert.equal(r.proposal.title, "Catat ke FamHub?");
  const rows = Object.fromEntries(r.proposal.rows.map((x) => [x.label, x.value]));
  assert.equal(rows.Jenis, "Pengeluaran");
  assert.equal(rows.Jumlah, "Rp150.000");
  assert.equal(rows.Dompet, "Kas keluarga");
  assert.equal(rows.Kategori, "Belanja");
  assert.equal(rows.Catatan, "Belanja mingguan");
  assert.equal(rows.Tanggal, "20 Nov 2026");
  assert.equal(rows["Dicatat oleh"], "Budi");
});

test("transaction: income is positive; date defaults to today, category to other, note to the category label", () => {
  const r = buildProposal({ kind: "transaction", wallet: "Dompet Budi", direction: "in", amount: "2500000" }, CTX, OPTS);
  assert.ok(r.ok);
  assert.deepEqual(r.proposal.action, {
    type: "transaction/add",
    id: "id-1",
    walletId: "w-budi",
    amount: 2500000,
    category: "other",
    note: "Lainnya",
    date: "2026-11-22",
  });
  assert.equal(r.proposal.rows.find((x) => x.label === "Jenis")?.value, "Pemasukan");
});

test("transaction: bad input is refused with an error the model can relay, and nothing is built", () => {
  const base = { kind: "transaction", wallet: "Kas keluarga", direction: "out", amount: 1000 };
  const bad = (patch: Record<string, unknown>, re: RegExp) => {
    const r = buildProposal({ ...base, ...patch }, CTX, OPTS);
    assert.ok(!r.ok, JSON.stringify(patch));
    assert.match(r.error, re, JSON.stringify(patch));
  };
  bad({ wallet: "Dompet Joko" }, /Dompet "Dompet Joko" tidak ditemukan.*Kas keluarga.*Dompet Budi/);
  bad({ wallet: "" }, /dompet/i);
  bad({ wallet: undefined }, /dompet/i);
  bad({ amount: 0 }, /amount/);
  bad({ amount: -5000 }, /amount/);
  bad({ amount: 1500.5 }, /amount/);
  bad({ amount: "150 ribu" }, /amount/);
  bad({ amount: "1e5" }, /amount/);
  bad({ amount: Number.MAX_SAFE_INTEGER + 2 }, /amount/);
  bad({ amount: undefined }, /amount/);
  bad({ direction: "sideways" }, /direction/);
  bad({ direction: undefined }, /direction/);
  bad({ category: "crypto" }, /category/);
  bad({ category: "reward" }, /category/);
  bad({ date: "22-11-2026" }, /date/);
  bad({ date: "2026-02-30" }, /date/);
  bad({ note: "x".repeat(201) }, /note/);
  bad({ kind: "transfer" }, /kind/);
  bad({ kind: undefined }, /kind/);
});

test("transaction: two wallets with the same name are ambiguous, not guessed", () => {
  const ctx = { ...CTX, wallets: [...CTX.wallets, { id: "w-kas2", name: "KAS KELUARGA" }] };
  const r = buildProposal({ kind: "transaction", wallet: "Kas keluarga", direction: "out", amount: 1000 }, ctx, OPTS);
  assert.ok(!r.ok && /lebih dari satu/.test(r.error));
});

test("bill: becomes FamHub's bill/add with a RecurringBill; day 1..28 only; category defaults to bills", () => {
  const r = buildProposal({ kind: "bill", name: " Listrik ", amount: 500000, dayOfMonth: 25 }, CTX, OPTS);
  assert.ok(r.ok);
  // FamHub: { type: "bill/add"; bill: { id; name; amount; dayOfMonth; category } }
  assert.deepEqual(r.proposal.action, {
    type: "bill/add",
    bill: { id: "id-1", name: "Listrik", amount: 500000, dayOfMonth: 25, category: "bills" },
  });
  const rows = Object.fromEntries(r.proposal.rows.map((x) => [x.label, x.value]));
  assert.equal(rows["Tagihan rutin"], "Listrik");
  assert.equal(rows.Jumlah, "Rp500.000");
  assert.equal(rows["Jatuh tempo"], "Tiap tanggal 25");
  assert.equal(rows.Kategori, "Tagihan");

  const GOOD_BILL: Record<string, unknown> = { kind: "bill", name: "Listrik", amount: 500000, dayOfMonth: 25 };
  for (const patch of [{ dayOfMonth: 0 }, { dayOfMonth: 29 }, { dayOfMonth: 31 }, { dayOfMonth: 2.5 }, { dayOfMonth: undefined }]) {
    const b = buildProposal({ ...GOOD_BILL, ...patch }, CTX, OPTS);
    assert.ok(!b.ok && /dayOfMonth/.test(b.error), JSON.stringify(patch));
  }
  for (const patch of [{ name: "  " }, { name: undefined }, { name: "x".repeat(81) }]) {
    const b = buildProposal({ ...GOOD_BILL, ...patch }, CTX, OPTS);
    assert.ok(!b.ok && /name/.test(b.error), JSON.stringify(patch));
  }
  const noAmount = buildProposal({ kind: "bill", name: "Listrik", amount: 0, dayOfMonth: 25 }, CTX, OPTS);
  assert.ok(!noAmount.ok && /amount/.test(noAmount.error));
  const cat = buildProposal({ kind: "bill", name: "Listrik", amount: 1, dayOfMonth: 25, category: "nope" }, CTX, OPTS);
  assert.ok(!cat.ok && /category/.test(cat.error));
});

/* ---------- the store ---------- */

const sample = () => {
  const r = buildProposal({ kind: "transaction", wallet: "Kas keluarga", direction: "out", amount: 150000, category: "groceries" }, CTX, OPTS);
  assert.ok(r.ok);
  return r.proposal;
};

test("store: a random id, ten minutes to live, one-shot; unknown and expired ids give nothing", () => {
  const store = new ProposalStore();
  const a = store.put(sample(), NOW);
  const b = store.put(sample(), NOW);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(a.expiresAt, NOW + PROPOSAL_TTL_MS);
  assert.equal(PROPOSAL_TTL_MS, 10 * 60 * 1000);

  assert.equal(store.take("nope", NOW), null);
  assert.equal(store.take("", NOW), null);
  assert.equal(store.take("__proto__", NOW), null);

  const got = store.take(a.id, NOW + PROPOSAL_TTL_MS - 1);
  assert.equal(got?.action.type, "transaction/add");
  assert.equal(store.take(a.id, NOW + PROPOSAL_TTL_MS - 1), null, "already used");

  assert.equal(store.take(b.id, NOW + PROPOSAL_TTL_MS), null, "expired at the deadline");
  assert.equal(store.take(b.id, NOW), null, "an expired proposal is gone for good");
});

test("store: expired entries are swept and the map stays bounded", () => {
  const store = new ProposalStore(3);
  const first = store.put(sample(), NOW);
  store.put(sample(), NOW + 1);
  store.put(sample(), NOW + 2);
  store.put(sample(), NOW + 3);
  assert.equal(store.size, 3);
  assert.equal(store.take(first.id, NOW + 4), null, "the oldest one was dropped");
  store.put(sample(), NOW + PROPOSAL_TTL_MS + 10);
  assert.equal(store.size, 1, "everything that expired is swept on the next put");
});

/* ---------- confirm, against a fake FamHub ---------- */

let server: http.Server;
let base = "";
let requests: Array<{ method: string; url: string; body: unknown }> = [];
let actionStatus = 200;
let actionReply: unknown = { version: 42 };
let familyReply: unknown = { data: { familyName: "Uji", ...FAMILY }, version: 7 };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ method: req.method || "", url: req.url || "", body: raw ? JSON.parse(raw) : null });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/api/family") return send(200, familyReply);
      if (req.method === "POST" && req.url === "/api/family/actions") return send(actionStatus, actionReply);
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests = [];
  actionStatus = 200;
  actionReply = { version: 42 };
  familyReply = { data: { familyName: "Uji", ...FAMILY }, version: 7 };
  resetFamhubContextCache();
});

test("confirm: sends exactly the stored action and actor to POST /api/family/actions, once", async () => {
  const store = new ProposalStore();
  const proposal = sample();
  const { id } = store.put(proposal, NOW);
  const config = { url: base, member: "Budi" };

  const first = await confirmProposal(store, config, id, { now: NOW + 1000 });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, version: 42 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/api/family/actions");
  assert.deepEqual(requests[0].body, {
    action: { type: "transaction/add", id: "id-1", walletId: "w-kas", amount: -150000, category: "groceries", note: "Belanja", date: "2026-11-22" },
    actorId: "m-budi",
  });

  const second = await confirmProposal(store, config, id, { now: NOW + 2000 });
  assert.equal(second.status, 410);
  assert.equal(requests.length, 1, "FamHub is not called a second time");
});

test("confirm: unknown, expired and cancelled ids are 410 and never reach FamHub", async () => {
  const store = new ProposalStore();
  const config = { url: base, member: "Budi" };
  assert.equal((await confirmProposal(store, config, "deadbeef", { now: NOW })).status, 410);
  assert.equal((await confirmProposal(store, config, 12345 as unknown as string, { now: NOW })).status, 410);

  const late = store.put(sample(), NOW);
  assert.equal((await confirmProposal(store, config, late.id, { now: NOW + PROPOSAL_TTL_MS + 1 })).status, 410);

  const dropped = store.put(sample(), NOW);
  assert.equal(cancelProposal(store, dropped.id, NOW), true);
  assert.equal(cancelProposal(store, dropped.id, NOW), false);
  assert.equal((await confirmProposal(store, config, dropped.id, { now: NOW })).status, 410);
  assert.equal(requests.length, 0);
});

test("confirm: FamHub's refusal comes back with its status and message; the proposal is spent either way", async () => {
  const store = new ProposalStore();
  const config = { url: base, member: "Budi" };
  actionStatus = 403;
  actionReply = { error: "Kamu tidak punya akses ke dompet ini." };
  const { id } = store.put(sample(), NOW);
  const refused = await confirmProposal(store, config, id, { now: NOW });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { ok: false, error: "Kamu tidak punya akses ke dompet ini." });
  assert.equal((await confirmProposal(store, config, id, { now: NOW })).status, 410);

  const down = store.put(sample(), NOW);
  const unreachable = await confirmProposal(store, { url: "http://127.0.0.1:9", member: "Budi" }, down.id, { now: NOW });
  assert.equal(unreachable.status, 502);
  assert.equal((unreachable.body as { ok: boolean }).ok, false);
});

/* ---------- context from GET /api/family ---------- */

test("context: read from GET /api/family; an unresolved member or an unreachable FamHub turns it off and logs why once", async () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const ctx = await loadFamhubContext({ url: base, member: "Sari" }, { log });
  assert.deepEqual(ctx?.actor, { id: "m-sari", name: "Sari" });
  assert.equal(ctx?.wallets.length, 3);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /api/family"]);
  assert.equal(logs.length, 0);

  await loadFamhubContext({ url: base, member: "Sari" }, { log });
  assert.equal(requests.length, 1, "cached for a short while");

  resetFamhubContextCache();
  assert.equal(await loadFamhubContext({ url: base, member: "Joko" }, { log }), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[momo\] FamHub write is OFF: .*Joko/);
  resetFamhubContextCache({ keepLogged: true });
  assert.equal(await loadFamhubContext({ url: base, member: "Joko" }, { log }), null);
  assert.equal(logs.length, 1, "the same reason is not logged again");

  resetFamhubContextCache();
  familyReply = { data: null, version: 0 };
  assert.equal(await loadFamhubContext({ url: base, member: "Sari" }, { log }), null);
  assert.equal(await loadFamhubContext({ url: "http://127.0.0.1:9", member: "Sari" }, { log }), null);
  assert.equal(logs.length, 3);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0, "reading the context never writes");
});

/* ---------- what the model and the UI are told ---------- */

test("tool: one declaration with the FamHub categories and the wallet names; the response says nothing was recorded", () => {
  const decl = famhubProposeDeclaration(CTX);
  assert.equal(decl.name, FAMHUB_PROPOSE_TOOL);
  assert.equal(decl.name, "famhub_propose");
  const p = decl.parameters as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(p.properties.kind.enum, ["transaction", "bill"]);
  assert.deepEqual(p.properties.direction.enum, ["out", "in"]);
  assert.deepEqual(p.properties.category.enum, ["groceries", "bills", "transport", "education", "health", "home", "fun", "allowance", "other"]);
  assert.match(decl.description, /Kas keluarga/);
  assert.match(decl.description, /TIDAK menyimpan/);

  const directive = famhubWriteDirective(CTX);
  assert.match(directive, /famhub_propose/);
  assert.match(directive, /Kas keluarga/);
  assert.match(directive, /JANGAN.*tersimpan/i);

  const reminder = famhubTurnReminder();
  assert.match(reminder, /famhub_propose/);
  assert.match(reminder, /only if/);
  assert.match(reminder, /no text in this step/);

  const res = proposalToolResponse(sample());
  assert.equal(res.recorded, false);
  assert.equal(res.status, "awaiting_user_confirmation");
  assert.match(String(res.note), /NOT recorded/);
  assert.match(String(res.shown), /Rp150\.000/);
});

test("card: a pending proposal stops being actionable once it expires; terminal states never are", () => {
  const card = { id: "a", title: "Catat ke FamHub?", rows: [{ label: "Jumlah", value: "Rp150.000" }], expiresAt: NOW + 1000, status: "pending" as const };
  assert.deepEqual(proposalView(card, NOW), { state: "pending", actionable: true, text: "" });
  assert.deepEqual(proposalView(card, NOW + 1000), { state: "expired", actionable: false, text: "Kedaluwarsa, tidak disimpan" });
  assert.deepEqual(proposalView({ ...card, status: "saved" }, NOW + 5000), { state: "saved", actionable: false, text: "Tersimpan ke FamHub" });
  assert.deepEqual(proposalView({ ...card, status: "cancelled" }, NOW), { state: "cancelled", actionable: false, text: "Dibatalkan" });
  assert.deepEqual(proposalView({ ...card, status: "error", error: "FamHub menolak." }, NOW), { state: "error", actionable: false, text: "FamHub menolak." });
  // a stored record with a tampered expiry is still bounded by the server TTL
  assert.equal(proposalView({ ...card, expiresAt: Number.NaN }, NOW).actionable, false);

  assert.equal(proposalHistoryLine({ ...card, status: "saved" }, NOW), "[FamHub: usulan (Jumlah: Rp150.000) — DISIMPAN oleh pengguna]");
  assert.match(proposalHistoryLine(card, NOW), /BELUM dikonfirmasi/);
  assert.match(proposalHistoryLine(card, NOW + 2000), /KEDALUWARSA/);
  assert.match(proposalHistoryLine({ ...card, status: "cancelled" }, NOW), /DIBATALKAN/);
  assert.match(proposalHistoryLine({ ...card, status: "error" }, NOW), /GAGAL/);
});
