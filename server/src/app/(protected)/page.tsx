import fs from "node:fs";
import path from "node:path";

import {redirect} from "next/navigation";

import {dataDir, getDb} from "@/db/db.ts";
import {frpRouteOnline, listFrpRoutes, type FrpRouteRow} from "@/lib/frp.ts";
import {listSyncedSettings, type SyncedSettingRow} from "@/lib/settings.ts";
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

/** One synced setting's human-readable digest (the value column of the
 * console table; the raw JSON stays one <details> away). */
function summarizeSetting(row: SyncedSettingRow): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return row.value.slice(0, 80);
  }
  if (row.key === "systemPrompt") {
    const text = typeof parsed === "string" ? parsed : "";
    if (text === "") return "(off)";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
  if (row.key === "visionModel") {
    return typeof parsed === "string" && parsed !== "" ? parsed : "(off)";
  }
  if (row.key === "modelVisibility") {
    const v = parsed as {disabled?: unknown; providers?: unknown};
    const hidden = Array.isArray(v.disabled) ? v.disabled.length : 0;
    const providers = Array.isArray(v.providers) ? v.providers.length : 0;
    if (hidden === 0 && providers === 0) return "default";
    return `${hidden} hidden model${hidden === 1 ? "" : "s"}, ${providers} provider${providers === 1 ? "" : "s"} off`;
  }
  return row.value.slice(0, 80);
}

/** The user's own synced settings (Lumina Code clients' multi-device
 * sync). Read-only — the clients own the writes; this is the "what is
 * on the server" view. */
function SyncedSettingsSection({rows}: {rows: SyncedSettingRow[]}) {
  return (
    <>
      <h2>Synced settings</h2>
      <p className="muted">
        Settings your Lumina Code clients keep in sync across devices
        (last write wins). Read-only here — edit them in the app.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No settings synced yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <code>{row.key}</code>
                </td>
                <td>
                  {summarizeSetting(row)}{" "}
                  <details>
                    <summary>raw</summary>
                    <pre>{row.value}</pre>
                  </details>
                </td>
                <td className="muted">{fmtWhen(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
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
            <th>lumina-code-server</th>
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

      <SyncedSettingsSection rows={listSyncedSettings(db, ctx.user.id)} />
    </>
  );
}

/** One SQL COUNT — the summary cards and facts rows share it. */
function count(db: ReturnType<typeof getDb>, sql: string): number {
  return (db.prepare(sql).get() as {c: number}).c;
}

/** Admin-only summary cards: whole-server counts. */
function AdminSummaryCards() {
  const db = getDb();
  const users = count(db, "SELECT COUNT(*) c FROM users");
  const tokens = count(db, "SELECT COUNT(*) c FROM tokens");
  const routes = count(db, "SELECT COUNT(*) c FROM frp_routes");
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
      <tr>
        <th>Synced settings</th>
        <td>
          {count(db, "SELECT COUNT(*) c FROM synced_settings")} keys across{" "}
          {count(db, "SELECT COUNT(DISTINCT user_id) c FROM synced_settings")} users
        </td>
      </tr>
    </>
  );
}
