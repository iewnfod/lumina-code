import Link from "next/link";

import {getDb} from "@/db/db.ts";

export const dynamic = "force-dynamic";

/** The session mirror pushed by connected desktops (relay model: the
 * agent itself stays on the desktop — this is the replica). */
export default async function SessionsPage() {
  const rows = getDb()
    .prepare(
      `SELECT s.opencode_session_id, s.title, s.directory, s.model, s.agent,
              s.updated_at, u.username AS owner,
              EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.opencode_session_id) AS has_snapshot
         FROM sessions s JOIN users u ON u.id = s.owner_user_id
        WHERE s.deleted = 0
        ORDER BY s.updated_at DESC`,
    )
    .all() as {
    opencode_session_id: string;
    title: string;
    directory: string;
    model: string;
    agent: string;
    updated_at: string;
    owner: string;
    has_snapshot: number;
  }[];

  return (
    <>
      <h1>Sessions</h1>
      <p className="muted">
        {rows.length} synced session{rows.length === 1 ? "" : "s"}. Snapshots arrive from
        connected desktops; a session without a snapshot has only just been created.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Directory</th>
            <th>Owner</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.opencode_session_id}>
              <td>
                {s.title || <span className="muted">untitled</span>}
                {s.has_snapshot === 0 ? <span className="badge">no snapshot</span> : null}
              </td>
              <td className="mono">{s.directory}</td>
              <td>{s.owner}</td>
              <td className="muted">{s.updated_at.slice(0, 19).replace("T", " ")}</td>
              <td>
                <Link href={`/sessions/${s.opencode_session_id}`} className="btn small">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
