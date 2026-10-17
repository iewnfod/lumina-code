import fs from "node:fs";
import path from "node:path";

import {dataDir, getDb} from "@/db/db.ts";
import {frpRouteOnline, listFrpRoutes} from "@/lib/frp.ts";
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

/** Overview: server facts + remote-access routes at a glance. */
export default async function DashboardPage() {
  const db = getDb();
  const count = (sql: string) => (db.prepare(sql).get() as {c: number}).c;
  const users = count("SELECT COUNT(*) c FROM users");
  const tokens = count("SELECT COUNT(*) c FROM tokens");
  const lastHeartbeat = (
    db
      .prepare("SELECT MAX(updated_at) m FROM frp_routes")
      .get() as {m: string | null}
  ).m;

  let dbSize = "—";
  try {
    dbSize = fileSize(fs.statSync(path.join(dataDir(), "lumina.db")).size);
  } catch {
    // not created on disk (in-memory) — leave the placeholder
  }

  const routes = listFrpRoutes(db);

  return (
    <>
      <h1>Overview</h1>
      <div className="cards">
        <div className="card">
          <h2>{users}</h2>
          <p className="muted">users</p>
        </div>
        <div className="card">
          <h2>{routes.length}</h2>
          <p className="muted">remote-access routes</p>
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
            <th>frp remote access</th>
            <td>
              {process.env.LUMINA_FRPS_TOKEN ? "enabled" : "not configured"}
            </td>
          </tr>
          <tr>
            <th>Data directory</th>
            <td>
              <code>{dataDir()}</code> (SQLite: {dbSize})
            </td>
          </tr>
          <tr>
            <th>Last route heartbeat</th>
            <td>{fmtWhen(lastHeartbeat)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Connected desktops</h2>
      <p className="muted">
        Desktops registered for remote access (frp routes), newest heartbeat
        first. Online = heartbeat received within the last ~11 minutes.
      </p>
      {routes.length === 0 ? (
        <p className="muted">No desktop has registered a route yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Route</th>
              <th>Last heartbeat</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.routeId}>
                <td>{r.username}</td>
                <td>
                  <code>/t/{r.routeId}/</code>
                </td>
                <td className="muted">{fmtWhen(r.updatedAt)}</td>
                <td>
                  {frpRouteOnline(r.updatedAt) ? (
                    <span className="badge">online</span>
                  ) : (
                    <span className="badge danger">offline</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
