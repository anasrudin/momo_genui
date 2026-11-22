import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfig, decideAccess } from "@/lib/auth/session";

/**
 * The optional login gate. With MOMO_PASSWORD unset this lets everything through;
 * with it set, pages go to /login and API calls get 401 until there is a valid session.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const decision = decideAccess(authConfig(), { pathname, search, cookie: request.cookies.get(SESSION_COOKIE)?.value });
  if (decision.action === "allow") return NextResponse.next();
  if (decision.action === "unauthorized") {
    return NextResponse.json({ error: "unauthorized", message: "Login diperlukan." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.redirect(new URL(decision.location, request.nextUrl), { headers: { "Cache-Control": "no-store" } });
}

export const config = {
  // build output and optimized images never need a session; everything else is decided above
  matcher: ["/((?!_next/static|_next/image).*)"],
};
