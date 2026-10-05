import {redirect} from "next/navigation";

import {resetPasswordAction, setDisabledAction} from "../../actions.ts";
import {getDb} from "@/db/db.ts";
import {pageAuth} from "@/lib/pageAuth.ts";

export const dynamic = "force-dynamic";

/** Admin-only user management: list, disable/enable, reset password. */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{error?: string; ok?: string}>;
}) {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  if (ctx.user.role !== "admin") redirect("/");
  const {error, ok} = await searchParams;

  interface UserListRow {
    id: number;
    username: string;
    role: string;
    disabled: number;
    created_at: string;
    tokens: number;
  }
  const users = getDb()
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled, u.created_at,
              (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id) AS tokens
         FROM users u ORDER BY u.id`,
    )
    .all() as UserListRow[];

  return (
    <>
      <h1>Users</h1>
      {error ? <p className="error">{error}</p> : null}
      {ok ? <p className="ok">{ok}</p> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.role === "admin" ? <span className="badge">admin</span> : "user"}</td>
              <td>{u.disabled === 1 ? <span className="badge danger">disabled</span> : "active"}</td>
              <td>{u.tokens}</td>
              <td className="muted">{u.created_at.slice(0, 19).replace("T", " ")}</td>
              <td className="actions">
                {u.id === ctx.user.id ? (
                  <span className="muted">(you)</span>
                ) : (
                  <>
                    <form action={setDisabledAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="disabled" value={u.disabled === 1 ? "0" : "1"} />
                      <button type="submit" className="btn small">
                        {u.disabled === 1 ? "Enable" : "Disable"}
                      </button>
                    </form>
                    <form action={resetPasswordAction} className="inline-reset">
                      <input type="hidden" name="userId" value={u.id} />
                      <input
                        name="password"
                        placeholder="new password"
                        minLength={6}
                        required
                      />
                      <button type="submit" className="btn small">
                        Reset password
                      </button>
                    </form>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
