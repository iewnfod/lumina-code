import fs from "node:fs";
import path from "node:path";

import {dataDir, getDb} from "@/db/db.ts";
import {SERVER_VERSION} from "@/lib/version.ts";

export const dynamic = "force-dynamic";

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 19).replace("T", " ");
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Overview: server facts + mirror freshness at a glance. */
export default async function DashboardPage() {
  const db = getDb();
  const count = (sql: string) => (db.prepare(sql).get() as {c: number}).c;
  const users = count("SELECT COUNT(*) c FROM users");
  const tokens = count("SELECT COUNT(*) c FROM tokens");
  const sessions = count("SELECT COUNT(*) c FROM sessions WHERE deleted = 0");
  const snapshots = count("SELECT COUNT(*) c FROM messages");
  const payloadBytes = (
    db.prepare("SELECT COALESCE(SUM(LENGTH(payload)), 0) b FROM messages").get() as {b: number}
  ).b;
  const lastMirror = (
    db
      .prepare("SELECT MAX(updated_at) m FROM sessions")
      .get() as {m: string | null}
  ).m;

  let dbSize = "—";
  try {
    dbSize = fileSize(fs.statSync(path.join(dataDir(), "lumina.db")).size);
  } catch {
    // not created on disk (in-memory) — leave the placeholder
  }

  return (
    <>
      <h1>Overview</h1>
      <div className="cards">
        <div className="card">
          <h2>{users}</h2>
          <p className="muted">users</p>
        </div>
        <div className="card">
          <h2>{sessions}</h2>
          <p className="muted">synced sessions</p>
        </div>
        <div className="card">
          <h2>{snapshots}</h2>
          <p className="muted">message snapshots ({fileSize(payloadBytes)})</p>
        </div>
        <div className="card">
          <h2>{tokens}</h2>
          <p className="muted">device tokens</p>
        </div>
      </div>

      <table className="table facts">
        <tbody>
          <tr>
            <th>lumina-server</th>
            <td>v{SERVER_VERSION}</td>
          </tr>
          <tr>
            <th>Registration</th>
            <td>
              {process.env.LUMINA_ALLOW_REGISTRATION === "false" ? "disabled" : "open"}
            </td>
          </tr>
          <tr>
            <th>Data directory</th>
            <td>
              <code>{dataDir()}</code> (SQLite: {dbSize})
            </td>
          </tr>
          <tr>
            <th>Last mirror push</th>
            <td>{fmtWhen(lastMirror)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
