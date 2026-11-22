import { confirmProposal, famhubEndpointAccess, proposalStore } from "@/lib/famhub/writeProposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * `POST /api/famhub/confirm { id }`: the user pressed "Simpan" on a proposal card.
 * Only the id comes from the browser; the action sent to FamHub is the one stored
 * when the proposal was shown. An id works once.
 */
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
  const result = await confirmProposal(proposalStore(), access.config, id);
  return json(result.body, result.status);
}
