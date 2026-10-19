import fs from "node:fs";
import path from "node:path";

import {redirect} from "next/navigation";

import {dataDir, getDb} from "@/db/db.ts";
import {frpRouteOnline, listFrpRoutes, type FrpRouteRow} from "@/lib/frp.ts";
import {pageAuth} from "@/lib/pageAuth.ts";
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

/** One desktop-route row of the table (shared by both role views). */
function RouteRow({row, withUser}: {row: FrpRouteRow; withUser: boolean}) {
  return (
    <tr>
      {withUser ? <td>{row.username}</td> : null}
      <td>
        <code>/t/{row.routeId}/</code>
      </td>
      <td className="muted">{fmtWhen(row.updatedAt)}</td>
      <td>
        {frpRouteOnline(row.updatedAt) ? (
          <span className="badge">online</span>
        ) : (
          <span className="badge danger">offline</span>
        )}
      </td>
    </tr>
  );
}

/** Overview: server facts + remote-access routes at a glance. Admin sees
 * every user's routes + server-level facts; a regular user only ever
 * sees their OWN desktop's route — route ids are other people's
 * doorbells, and counts/paths are the operator's business. */
export default async function DashboardPage() {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  const admin = ctx.user.role === "admin";
  const db = getDb();
  const routes = admin ? listFrpRoutes(db) : listFrpRoutes(db, ctx.user.id);

  return (
    <>
      <h1>Overview</h1>

      {admin ? (
        <div className="cards">
          <AdminSummaryCards />
        </div>
      ) : (
        <div className="cards">
          <OwnDesktopCard route={routes[0] ?? null} />
        </div>
      )}

      <table className="table facts">
        <tbody>
          <tr>
            <th>lumina-server</th>
            <td>v{SERVER_VERSION}</td>
          </tr>
          <tr>
            <th>frp remote access</th>
            <td>
              {process.env.LUMINA_FRPS_TOKEN ? "enabled" : "not configured"}
            </td>
          </tr>
          {admin ? <AdminFactsRows /> : null}
        </tbody>
      </table>

      <h2>{admin ? "Connected desktops" : "Your desktop"}</h2>
      <p className="muted">
        {admin
          ? "Desktops registered for remote access (frp routes), newest heartbeat first. Online = heartbeat received within the last ~11 minutes."
          : "Your desktop's remote-access registration (frp route). Online = heartbeat received within the last ~11 minutes."}
      </p>
      {routes.length === 0 ? (
        <p className="muted">
          {admin
            ? "No desktop has registered a route yet."
            : "Your desktop has not registered a route yet."}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              {admin ? <th>User</th> : null}
              <th>Route</th>
              <th>Last heartbeat</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <RouteRow key={r.routeId} row={r} withUser={admin} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Admin-only summary cards: whole-server counts. */
function AdminSummaryCards() {
  const db = getDb();
  const count = (sql: string) => (db.prepare(sql).get() as {c: number}).c;
  const users = count("SELECT COUNT(*) c FROM users");
  const tokens = count("SELECT COUNT(*) c FROM tokens");
  const routes = count("SELECT COUNT(*) c FROM frp_routes");
  return (
    <>
      <div className="card">
        <h2>{users}</h2>
        <p className="muted">users</p>
      </div>
      <div className="card">
        <h2>{routes}</h2>
        <p className="muted">remote-access routes</p>
      </div>
      <div className="card">
        <h2>{tokens}</h2>
        <p className="muted">device tokens</p>
      </div>
    </>
  );
}

/** The regular user's single card: their own desktop's state. */
function OwnDesktopCard({route}: {route: FrpRouteRow | null}) {
  const state = route
    ? frpRouteOnline(route.updatedAt)
      ? "online"
      : "offline"
    : "not registered";
  return (
    <div className="card">
      <h2>{state}</h2>
      <p className="muted">your desktop</p>
    </div>
  );
}

/** Admin-only facts: registration gate, data directory, global heartbeat. */
function AdminFactsRows() {
  const db = getDb();
  const lastHeartbeat = (
    db.prepare("SELECT MAX(updated_at) m FROM frp_routes").get() as {m: string | null}
  ).m;
  let dbSize = "—";
  try {
    dbSize = fileSize(fs.statSync(path.join(dataDir(), "lumina.db")).size);
  } catch {
    // not created on disk (in-memory) — leave the placeholder
  }
  return (
    <>
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
        <th>Last route heartbeat</th>
        <td>{fmtWhen(lastHeartbeat)}</td>
      </tr>
    </>
  );
}
