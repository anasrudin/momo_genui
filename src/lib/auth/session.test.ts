import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttemptLimiter,
  SESSION_MAX_AGE_S,
  authConfig,
  clientKey,
  decideAccess,
  isPublicPath,
  safeEqual,
  safeNextPath,
  sessionCookies,
  signSession,
  verifySession,
} from "./session";

const NOW = 1_800_000_000_000;
const CONFIG = authConfig({ MOMO_PASSWORD: "rahasia" })!;

test("config: no password (unset or empty) means no login; the key comes from the password unless a secret is set", () => {
  assert.equal(authConfig({}), null);
  assert.equal(authConfig({ MOMO_PASSWORD: "" }), null);
  assert.equal(authConfig({ MOMO_PASSWORD: "", MOMO_SESSION_SECRET: "s" }), null);
  assert.equal(CONFIG.secret, authConfig({ MOMO_PASSWORD: "rahasia" })!.secret);
  assert.notEqual(CONFIG.secret, authConfig({ MOMO_PASSWORD: "rahasia2" })!.secret);
  assert.ok(!CONFIG.secret.includes("rahasia"));
  assert.equal(authConfig({ MOMO_PASSWORD: "rahasia", MOMO_SESSION_SECRET: "kunci" })!.secret, "kunci");
});

test("session: a signed value verifies; tampered, expired, wrong-secret and malformed values do not", () => {
  const value = signSession(CONFIG.secret, NOW + 1000);
  assert.match(value, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(verifySession(CONFIG.secret, value, NOW), true);

  // a later expiry with the old signature, and a flipped signature character
  assert.equal(verifySession(CONFIG.secret, `${NOW + 9_999_999}.${value.split(".")[1]}`, NOW), false);
  assert.equal(verifySession(CONFIG.secret, value.slice(0, -1) + (value.endsWith("0") ? "1" : "0"), NOW), false);

  assert.equal(verifySession(CONFIG.secret, value, NOW + 1000), false, "expired exactly at its expiry");
  assert.equal(verifySession(CONFIG.secret, signSession(CONFIG.secret, NOW - 1), NOW), false);

  assert.equal(verifySession("kunci-lain", value, NOW), false);
  // changing the password changes the derived key, which signs everyone out
  assert.equal(verifySession(authConfig({ MOMO_PASSWORD: "baru" })!.secret, value, NOW), false);

  for (const bad of [undefined, null, "", "abc", ".", `${NOW + 1000}`, `${NOW + 1000}.`, `x.${value.split(".")[1]}`, `1e99.${value.split(".")[1]}`]) {
    assert.equal(verifySession(CONFIG.secret, bad, NOW), false, String(bad));
  }
});

test("compare: equal strings match, anything else does not, whatever the lengths", () => {
  assert.equal(safeEqual("rahasia", "rahasia"), true);
  assert.equal(safeEqual("rahasia", "rahasiA"), false);
  assert.equal(safeEqual("rahasia", "rahasia "), false);
  assert.equal(safeEqual("", "rahasia"), false);
  assert.equal(safeEqual("a".repeat(5000), "rahasia"), false);
});

test("rate limit: five failures in a minute block the sixth try, per client, until the window moves on", () => {
  const l = new AttemptLimiter(5, 60_000);
  for (let i = 0; i < 5; i++) {
    assert.equal(l.blocked("1.2.3.4", NOW + i), false);
    l.fail("1.2.3.4", NOW + i);
  }
  assert.equal(l.blocked("1.2.3.4", NOW + 10), true);
  assert.equal(l.blocked("5.6.7.8", NOW + 10), false, "another client is not affected");
  assert.equal(l.blocked("1.2.3.4", NOW + 59_999), true);
  assert.equal(l.blocked("1.2.3.4", NOW + 60_000), false, "the oldest failure has left the window");
  l.fail("1.2.3.4", NOW + 60_000);
  assert.equal(l.blocked("1.2.3.4", NOW + 60_000), true);
  l.clear("1.2.3.4");
  assert.equal(l.blocked("1.2.3.4", NOW + 60_000), false);
});

test("client key: the first forwarded hop, or one shared bucket", () => {
  assert.equal(clientKey("192.168.1.20, 10.0.0.1"), "192.168.1.20");
  assert.equal(clientKey(" 192.168.1.20 "), "192.168.1.20");
  assert.equal(clientKey(null), "local");
  assert.equal(clientKey(""), "local");
});

test("next: only a path on this site survives", () => {
  for (const ok of ["/", "/playground", "/playground?x=1&y=2", "/a/b#c"]) assert.equal(safeNextPath(ok), ok);
  for (const bad of [
    undefined, null, "", "playground", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)",
    "/\t/evil.example", "/a\\b", "/a\nb", "/login", "/login?next=/x", "/api/brain",
  ]) {
    assert.equal(safeNextPath(bad), "/", String(bad));
  }
});

test("access: with no password configured everything is allowed", () => {
  for (const pathname of ["/", "/playground", "/api/brain", "/api/health", "/login", "/apa-saja"]) {
    assert.deepEqual(decideAccess(null, { pathname }), { action: "allow" });
    assert.deepEqual(decideAccess(authConfig({ MOMO_PASSWORD: "" }), { pathname, cookie: "palsu" }), { action: "allow" });
  }
});

test("access: with a password, pages redirect to the login, API calls get 401, and the open paths stay open", () => {
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/" }, NOW), { action: "redirect", location: "/login?next=%2F" });
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/playground", search: "?x=1" }, NOW), { action: "redirect", location: "/login?next=%2Fplayground%3Fx%3D1" });
  assert.deepEqual(decideAccess(CONFIG, { pathname: "//evil.example" }, NOW), { action: "redirect", location: "/login?next=%2F" });
  for (const pathname of ["/api/brain", "/api/image", "/api/weather", "/api", "/api/healthz", "/api/login/x"]) {
    assert.deepEqual(decideAccess(CONFIG, { pathname }, NOW), { action: "unauthorized" }, pathname);
  }
  for (const pathname of ["/api/health", "/login", "/api/login", "/api/logout", "/_next/static/chunks/a.js", "/favicon.svg", "/fonts/x.woff2"]) {
    assert.equal(isPublicPath(pathname), true, pathname);
    assert.deepEqual(decideAccess(CONFIG, { pathname }, NOW), { action: "allow" }, pathname);
  }
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/api/brain", cookie: "1.abc" }, NOW), { action: "unauthorized" });
});

test("access: a valid session opens everything, and sends the login page on to where it was headed", () => {
  const cookie = signSession(CONFIG.secret, NOW + SESSION_MAX_AGE_S * 1000);
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/", cookie }, NOW), { action: "allow" });
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/api/brain", cookie }, NOW), { action: "allow" });
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/login", search: "?next=%2Fplayground", cookie }, NOW), { action: "redirect", location: "/playground" });
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/login", search: "?next=https://evil.example", cookie }, NOW), { action: "redirect", location: "/" });
  // 30 days later it has run out
  assert.deepEqual(decideAccess(CONFIG, { pathname: "/api/brain", cookie }, NOW + SESSION_MAX_AGE_S * 1000), { action: "unauthorized" });
});

test("cookies: HttpOnly, Lax, whole site, 30 days; Secure only on https; signing out empties them", () => {
  const [session, hint] = sessionCookies("123.abc", false);
  assert.equal(session, "momo_session=123.abc; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly");
  assert.equal(hint, "momo_auth=1; Path=/; Max-Age=2592000; SameSite=Lax");
  assert.ok(!hint.includes("HttpOnly"), "the marker is read by the page; it grants nothing");
  assert.match(sessionCookies("123.abc", true)[0], /; Secure; HttpOnly$/);
  assert.deepEqual(sessionCookies(null, false), ["momo_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly", "momo_auth=; Path=/; Max-Age=0; SameSite=Lax"]);
});
