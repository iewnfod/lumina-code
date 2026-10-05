import {redirect} from "next/navigation";

import {changePasswordAction, logoutAction, revokeTokenAction} from "../../actions.ts";
import {getDb} from "@/db/db.ts";
import {pageAuth} from "@/lib/pageAuth.ts";

export const dynamic = "force-dynamic";

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  return iso.slice(0, 19).replace("T", " ");
}

/** Self-service: change password, review/revoke device logins, sign out. */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{error?: string; ok?: string}>;
}) {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  const {error, ok} = await searchParams;

  const tokens = getDb()
    .prepare(
      "SELECT id, label, created_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY id DESC",
    )
    .all(ctx.user.id) as {
    id: number;
    label: string;
    created_at: string;
    last_used_at: string | null;
  }[];

  return (
    <>
      <h1>Account</h1>
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p className="ok">{ok}</p> : null}

      <h2>Change password</h2>
      <form action={changePasswordAction} className="card">
        <label>
          Current password
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label>
          New password (6+ characters)
          <input name="next" type="password" autoComplete="new-password" required minLength={6} />
        </label>
        <button type="submit" className="btn primary">
          Update password
        </button>
      </form>

      <h2>Device tokens ({tokens.length})</h2>
      <p className="muted">
        Each desktop/mobile login creates a token. Revoke any you do not
        recognize. The desktop app&apos;s token appears as <code>login</code>.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>
                {t.label}
                {t.id === ctx.tokenId ? <span className="badge">this session</span> : null}
              </td>
              <td className="muted">{fmtWhen(t.created_at)}</td>
              <td className="muted">{fmtWhen(t.last_used_at)}</td>
              <td>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="tokenId" value={t.id} />
                  <button type="submit" className="btn small danger">
                    Revoke
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Sign out</h2>
      <form action={logoutAction}>
        <button type="submit" className="btn">
          Sign out of the web console
        </button>
      </form>
    </>
  );
}
