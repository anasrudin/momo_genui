import { sessionCookies } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/logout` clears the session; a form post is sent back to the login page. */
export async function POST(request: Request) {
  const secure = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const c of sessionCookies(null, secure)) headers.append("Set-Cookie", c);
  if ((request.headers.get("content-type") || "").includes("application/json") || request.headers.get("accept")?.includes("application/json")) {
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  headers.set("Location", "/login");
  return new Response(null, { status: 303, headers });
}
