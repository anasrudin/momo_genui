import { cancelProposal, famhubEndpointAccess, proposalStore } from "@/lib/famhub/writeProposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** `POST /api/famhub/cancel { id }`: the user pressed "Batal". Drops the stored proposal; nothing is sent to FamHub. */
export async function POST(request: Request) {
  const access = famhubEndpointAccess(request.headers.get("cookie"));
  if (!access.ok) {
    return access.status === 404
      ? json({ error: "not_found" }, 404)
      : json({ error: "unauthorized", message: "Login diperlukan." }, 401);
  }
  let id: unknown;
  try {
    id = ((await request.json()) as { id?: unknown } | null)?.id;
  } catch {
    return json({ ok: false, error: "Permintaan tidak valid." }, 400);
  }
  if (!cancelProposal(proposalStore(), id)) {
    return json({ ok: false, error: "Usulan ini sudah tidak berlaku (kedaluwarsa, dibatalkan, atau sudah diproses)." }, 410);
  }
  return json({ ok: true }, 200);
}
