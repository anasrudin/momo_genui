import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authConfig, safeNextPath } from "@/lib/auth/session";
import "@/styles/login.css";

export const metadata: Metadata = { title: "Masuk — Momo" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  password: "Kata sandinya salah. Coba lagi.",
  limit: "Terlalu banyak percobaan. Tunggu satu menit, lalu coba lagi.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(one(params.next));
  // no password configured: there is nothing to sign in to
  if (!authConfig()) redirect("/");
  const error = ERRORS[one(params.error) ?? ""];

  return (
    <main className="login-page">
      {/* a plain form post: works before, and without, any client script */}
      <form className="pop open bot-form login-card" method="post" action="/api/login">
        <div className="bot-form-head">
          <img className="login-mark" src="/favicon.svg" alt="" width={44} height={44} />
          <div>
            <h1>Masuk ke Momo</h1>
            <p>Momo ini dikunci. Masukkan kata sandinya.</p>
          </div>
        </div>
        <input type="hidden" name="next" value={next} />
        <label className="login-label" htmlFor="loginPassword">Kata sandi</label>
        <input
          id="loginPassword"
          className="field"
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "loginError" : undefined}
        />
        {error ? <p id="loginError" className="login-error" role="alert">{error}</p> : null}
        <div className="bot-form-actions">
          <button type="submit" className="keybtn primary">Masuk</button>
        </div>
      </form>
    </main>
  );
}
