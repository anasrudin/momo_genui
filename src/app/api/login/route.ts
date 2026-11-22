import { AttemptLimiter, authConfig, clientKey, safeEqual, safeNextPath, sessionCookies, signSession, SESSION_MAX_AGE_S } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new AttemptLimiter(5, 60_000);

/**
 * `POST /api/login` with `{ password }` as JSON, or as a form post from /login
 * (then `next` says where to go and the answer is a redirect instead of JSON).
 */
export async function POST(request: Request) {
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  let password = "";
  let next = "/";
  try {
    if (isJson) {
      const body = (await request.json()) as { password?: unknown; next?: unknown };
      password = typeof body?.password === "string" ? body.password : "";
      next = safeNextPath(typeof body?.next === "string" ? body.next : null);
    } else {
      const form = await request.formData();
      password = String(form.get("password") ?? "");
      next = safeNextPath(String(form.get("next") ?? ""));
    }
  } catch {
    // an unreadable body is a wrong password
  }

  const reply = (status: number, error: string | null, cookies: string[] = []) => {
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const c of cookies) headers.append("Set-Cookie", c);
    if (isJson) {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(error ? { ok: false, error } : { ok: true, next }), { status, headers });
    }
    // a relative Location: the browser resolves it against the address it used, whatever sits in front of us
    const back = `/login?error=${error}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`;
    headers.set("Location", error ? back : next);
    return new Response(null, { status: 303, headers });
  };

  const config = authConfig();
  if (!config) return reply(200, null); // no login configured: nothing to sign in to

  const who = clientKey(request.headers.get("x-forwarded-for"));
  if (limiter.blocked(who)) {
    const res = reply(429, "limit");
    res.headers.set("Retry-After", "60");
    return res;
  }
  if (!safeEqual(password, config.password)) {
    limiter.fail(who);
    return reply(401, "password");
  }
  limiter.clear(who);
  const secure = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  return reply(200, null, sessionCookies(signSession(config.secret, Date.now() + SESSION_MAX_AGE_S * 1000), secure));
}
