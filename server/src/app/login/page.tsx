import Link from "next/link";

import {loginAction} from "../actions.ts";

export const dynamic = "force-dynamic";

/** Plain server-rendered login — errors come back via ?error= (no-JS
 * forms throughout the admin UI). */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{error?: string}>;
}) {
  const {error} = await searchParams;
  return (
    <main className="auth">
      <h1>lumina-server</h1>
      <p className="muted">Sign in to the management console.</p>
      {error ? <p className="error">{error}</p> : null}
      <form action={loginAction} className="card">
        <label>
          Username
          <input name="username" autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className="btn primary">
          Sign in
        </button>
      </form>
      <p className="muted">
        No account yet?{" "}
        <Link href="/register">Register</Link>
      </p>
    </main>
  );
}
