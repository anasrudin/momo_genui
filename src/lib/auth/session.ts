/**
 * The optional shared-password login (MOMO_PASSWORD). Everything here is pure
 * and synchronous: the request interceptor (`src/proxy.ts`) and the login
 * route both decide from these functions, so there is one place that signs,
 * verifies and says which paths are open.
 *
 * No password configured means no login at all: every request is allowed.
 * Uses `node:crypto`; Proxy runs on the Node.js runtime in this Next version.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "momo_session";
/** Not a credential: tells the client UI that a login exists, so it can offer "Keluar". */
export const SESSION_HINT_COOKIE = "momo_auth";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

type Env = Record<string, string | undefined>;

export interface AuthConfig {
  password: string;
  /** HMAC key for session cookies. */
  secret: string;
}

/** Null when no password is set: the app then behaves as it does without this module. */
export function authConfig(env: Env = process.env): AuthConfig | null {
  const password = env.MOMO_PASSWORD ?? "";
  if (!password) return null;
  // derived from the password by default, so changing the password signs everyone out
  const secret = env.MOMO_SESSION_SECRET || createHash("sha256").update(`momo-session-key:${password}`).digest("hex");
  return { password, secret };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Compares two strings without leaking where they differ (or how long they are). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("hex");

/** Cookie value: `<expiry in ms>.<HMAC-SHA256 of the expiry>`. */
export function signSession(secret: string, expiresAt: number): string {
  const payload = String(Math.floor(expiresAt));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret: string, value: string | undefined | null, now: number = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  if (!/^\d{1,16}$/.test(payload)) return false;
  if (!safeEqual(value.slice(dot + 1), sign(secret, payload))) return false;
  return Number(payload) > now;
}

/** Where to go after login: a path on this site, or `/`. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || next[0] !== "/" || next[1] === "/" || next[1] === "\\") return "/";
  // a browser treats `\` like `/` and drops tabs and newlines, so none of them may appear
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/api/")) return "/";
  return next;
}

/** Open without a session: health, the login page and its endpoints, and the assets that page needs. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/api/logout" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.svg" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/fonts/")
  );
}

export type AccessDecision =
  | { action: "allow" }
  | { action: "unauthorized" }
  | { action: "redirect"; location: string };

/** What the interceptor does with one request. */
export function decideAccess(
  config: AuthConfig | null,
  req: { pathname: string; search?: string; cookie?: string | null },
  now: number = Date.now(),
): AccessDecision {
  if (!config) return { action: "allow" };
  const signedIn = verifySession(config.secret, req.cookie, now);
  if (req.pathname === "/login" && signedIn) {
    return { action: "redirect", location: safeNextPath(new URLSearchParams(req.search ?? "").get("next")) };
  }
  if (signedIn || isPublicPath(req.pathname)) return { action: "allow" };
  if (req.pathname === "/api" || req.pathname.startsWith("/api/")) return { action: "unauthorized" };
  const next = safeNextPath(`${req.pathname}${req.search ?? ""}`);
  return { action: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
}

/** Failed attempts per key inside a sliding window; in memory, so a restart forgets them. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max = 5, private windowMs = 60_000) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** True when this key has used up its failures and must wait. */
  blocked(key: string, now: number = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now: number = Date.now()): void {
    if (this.hits.size > 5000) for (const k of [...this.hits.keys()]) this.recent(k, now);
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

/** The client address as the reverse proxy reports it; one shared bucket when there is none. */
export function clientKey(forwardedFor: string | null | undefined): string {
  return (forwardedFor ?? "").split(",")[0].trim() || "local";
}

/** `Set-Cookie` values for a new session (or, with `value` null, for signing out). */
export function sessionCookies(value: string | null, secure: boolean): string[] {
  const tail = `Path=/; Max-Age=${value ? SESSION_MAX_AGE_S : 0}; SameSite=Lax${secure ? "; Secure" : ""}`;
  return [`${SESSION_COOKIE}=${value ?? ""}; ${tail}; HttpOnly`, `${SESSION_HINT_COOKIE}=${value ? "1" : ""}; ${tail}`];
}
