import Link from "next/link";
import {notFound} from "next/navigation";

import {getDb} from "@/db/db.ts";
import {extractTranscript} from "@/lib/transcript.ts";

export const dynamic = "force-dynamic";

/** Minimal read-only transcript of one synced session — plain text and
 * tool markers; the desktop app owns the rich renderer. */
export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  const db = getDb();
  const session = db
    .prepare(
      `SELECT s.*, u.username AS owner FROM sessions s
         JOIN users u ON u.id = s.owner_user_id
        WHERE s.opencode_session_id = ? AND s.deleted = 0`,
    )
    .get(id) as
    | {
        opencode_session_id: string;
        title: string;
        directory: string;
        model: string;
        agent: string;
        updated_at: string;
        owner: string;
      }
    | undefined;
  if (!session) notFound();

  const snapshot = db
    .prepare("SELECT payload FROM messages WHERE session_id = ?")
    .get(id) as {payload: string} | undefined;
  const entries = snapshot ? extractTranscript(JSON.parse(snapshot.payload)) : [];

  return (
    <>
      <p>
        <Link href="/sessions">← All sessions</Link>
      </p>
      <h1>{session.title || "untitled session"}</h1>
      <table className="table facts">
        <tbody>
          <tr>
            <th>ID</th>
            <td className="mono">{session.opencode_session_id}</td>
          </tr>
          <tr>
            <th>Directory</th>
            <td className="mono">{session.directory}</td>
          </tr>
          <tr>
            <th>Owner / agent / model</th>
            <td>
              {session.owner} · {session.agent || "build"} · {session.model || "default"}
            </td>
          </tr>
          <tr>
            <th>Last snapshot</th>
            <td>{session.updated_at.slice(0, 19).replace("T", " ")}</td>
          </tr>
        </tbody>
      </table>

      {entries.length === 0 ? (
        <p className="muted">No message snapshot has been pushed for this session yet.</p>
      ) : (
        <div className="transcript">
          {entries.map((e, i) => (
            <div key={i} className={`entry ${e.role}`}>
              <div className="role">{e.role === "user" ? session.owner : "assistant"}</div>
              {e.text ? <pre>{e.text}</pre> : null}
              {e.tools.length > 0 ? (
                <ul className="tools">
                  {e.tools.map((t, j) => (
                    <li key={j} className="mono">
                      {t.name} · {t.status}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
