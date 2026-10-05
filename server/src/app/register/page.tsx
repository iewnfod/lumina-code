import Link from "next/link";

import {registerAction} from "../actions.ts";

export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{error?: string}>;
}) {
  const {error} = await searchParams;
  const disabled = process.env.LUMINA_ALLOW_REGISTRATION === "false";
  return (
    <main className="auth">
      <h1>lumina-server</h1>
      <p className="muted">
        Create an account. The <strong>first</strong> registered user becomes
        the server admin.
      </p>
      {disabled ? (
        <p className="error">Registration is disabled on this server.</p>
      ) : (
        <>
          {error ? <p className="error">{error}</p> : null}
          <form action={registerAction} className="card">
            <label>
              Username
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              Password (6+ characters)
              <input name="password" type="password" autoComplete="new-password" required minLength={6} />
            </label>
            <button type="submit" className="btn primary">
              Create account
            </button>
          </form>
        </>
      )}
      <p className="muted">
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
