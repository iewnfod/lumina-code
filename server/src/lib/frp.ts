import {randomBytes} from "node:crypto";
import {AuthError} from "./auth.ts";
import type {Db} from "../db/db.ts";

/**
 * The frp direct-access core (the tunnel's replacement).
 *
 * Desktops no longer relay anything through this server: each desktop's
 * frpc opens its own outbound pipe to frps, and mobile clients connect
 * STRAIGHT to the desktop's opencode via `https://<server>/t/<routeId>/`
 * (nginx rewrites the path prefix away and sets Host to
 * `<routeId>.frp.internal`, which frps routes on). The server's whole
 * job on this path is the CREDENTIAL EXCHANGE:
 *
 *  - frpServerConfig: what a desktop needs to point frpc at frps
 *    (bind port + shared token, from env);
 *  - registerFrpRoute: the desktop's heartbeat — publishes its CURRENT
 *    opencode password under a route id, minting the id on first
 *    contact. One row per user: a second desktop registering with a
 *    fresh id REPLACES the row wholesale, so /connect always hands out
 *    the newest desktop (the superseded frpc proxy simply starves —
 *    nothing routes to it anymore);
 *  - getFrpConnect: the mobile's read side (route id + password +
 *    freshness).
 *
 * Trust model (deliberate change from the relay era): the opencode
 * basic-auth password now LIVES on this server and is served to any
 * authenticated device token. The frps auth token is likewise shared
 * by every account on this server — a hostile co-tenant could register
 * foreign proxies. Both are accepted for the self-hosted
 * single-operator deployment this server targets; documented in
 * server/README.md.
 */

/** Env-served frps coordinates for the desktop's frpc. */
export interface FrpServerConfig {
  enabled: boolean;
  bindPort: number;
  token: string;
  /** How frpc reaches the frps CONTROL channel over WebSocket instead
   * of raw TCP (null = legacy direct `host:bindPort`). See
   * parseControlUrl. */
  control: FrpControlConfig | null;
}

/** The WebSocket ride for frps's control channel. Needed when the
 * server is fronted by an HTTP-only reverse proxy (Cloudflare's free
 * tier passes just HTTP(S) ports and speaks HTTP, so frp's raw TCP
 * frame gets cut at the edge — live-observed as `session shutdown`).
 * frpc then dials `wss://host:port/~!frp` (the path is FIXED in frp
 * 0.71.x, spike-verified) and nginx routes that exact location to
 * frps's bind port — frps accepts WebSocket on it natively, zero
 * config. TLS is the wss layer itself. */
export interface FrpControlConfig {
  host: string;
  port: number;
  secure: boolean;
}

/** Parse LUMINA_FRPS_CONTROL (`wss://lumina.example.com`,
 * `ws://frps.example.com:7000`). Strict: ws/wss only, no path/query/
 * credentials, explicit or scheme-default port. Null when unset or
 * junk — the operator's typo must degrade to the documented legacy
 * mode, not a half-parsed host. Pure. */
export function parseControlUrl(raw: string | undefined): FrpControlConfig | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const secure = url.protocol === "wss:";
  if (!secure && url.protocol !== "ws:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : secure
      ? 443
      : 80;
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return {host: url.hostname, port, secure};
}

/** Read LUMINA_FRPS_* (compose wires them next to the frps service). */
export function frpServerConfig(
  env: Record<string, string | undefined> = process.env,
): FrpServerConfig {
  const token = (env.LUMINA_FRPS_TOKEN ?? "").trim();
  const bindPort = Number.parseInt(env.LUMINA_FRPS_BIND_PORT ?? "7000", 10);
  return {
    enabled: token !== "",
    bindPort: Number.isFinite(bindPort) && bindPort > 0 && bindPort < 65536 ? bindPort : 7000,
    token,
    control: parseControlUrl(env.LUMINA_FRPS_CONTROL),
  };
}

/** Mint a route id: hex only, so nginx's `[A-Za-z0-9_-]+` capture and
 * frp's proxy-name rules never see a character to escape. */
export function mintRouteId(userId: number): string {
  return `u${userId}-${randomBytes(4).toString("hex")}`;
}

/** The mobile-facing connection record. */
export interface FrpConnectInfo {
  routeId: string;
  password: string;
  updatedAt: string;
}

const MAX_PASSWORD_CHARS = 256;

/** Validate + normalize a registration body's password field. Throws
 * AuthError(400) on a malformed one (same leniency as the sync pushes:
 * junk shapes fail loudly, this credential must be exactly right). */
export function parsePassword(body: unknown): string {
  const password = (body as {password?: unknown})?.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new AuthError("password must be a non-empty string", 400);
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    throw new AuthError("password too long", 400);
  }
  return password;
}

/** The desktop's registration/heartbeat: publish the CURRENT opencode
 * password. Keeps the row's route id when the caller re-uses its own;
 * a fresh/foreign id replaces the row (second-desktop takeover). */
export function registerFrpRoute(
  db: Db,
  userId: number,
  password: string,
  routeIdIn?: unknown,
): {routeId: string} {
  const existing = db
    .prepare("SELECT route_id FROM frp_routes WHERE user_id = ?")
    .get(userId) as {route_id: string} | undefined;
  let routeId: string;
  if (
    typeof routeIdIn === "string" &&
    routeIdIn.length > 0 &&
    routeIdIn.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(routeIdIn) &&
    existing?.route_id === routeIdIn
  ) {
    routeId = routeIdIn; // our own id: refresh in place
  } else {
    routeId = mintRouteId(userId);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO frp_routes (user_id, route_id, password, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       route_id   = excluded.route_id,
       password   = excluded.password,
       updated_at = excluded.updated_at`,
  ).run(userId, routeId, password, now);
  return {routeId};
}

/** The mobile's read side: the user's CURRENT desktop route + password.
 * Null when this account never registered a desktop. */
export function getFrpConnect(db: Db, userId: number): FrpConnectInfo | null {
  const row = db
    .prepare("SELECT route_id, password, updated_at FROM frp_routes WHERE user_id = ?")
    .get(userId) as {route_id: string; password: string; updated_at: string} | undefined;
  if (!row) return null;
  return {routeId: row.route_id, password: row.password, updatedAt: row.updated_at};
}

/** One console row: a registered desktop route. Deliberately carries NO
 * password — the web console only DISPLAYS routes; /api/frp/connect is
 * the single place the credential ever leaves the server (and it is
 * per-owner). */
export interface FrpRouteRow {
  userId: number;
  username: string;
  routeId: string;
  updatedAt: string;
}

/** All registered desktop routes, newest heartbeat first, joined with
 * their owners — the console's "connected desktops" list. */
export function listFrpRoutes(db: Db): FrpRouteRow[] {
  return db
    .prepare(
      `SELECT r.user_id AS "userId", u.username, r.route_id AS "routeId",
              r.updated_at AS "updatedAt"
         FROM frp_routes r JOIN users u ON u.id = r.user_id
        ORDER BY r.updated_at DESC`,
    )
    .all() as FrpRouteRow[];
}

/** The heartbeat cadence the desktop runs (src/hooks/useServerFrp.ts
 * registers every 5 minutes) — the freshness budget below is derived
 * from it. */
export const FRP_HEARTBEAT_MS = 5 * 60_000;

/** A route counts as online while its heartbeat is fresher than two
 * cadences + slack. Routes have no explicit disconnect: a desktop going
 * away (frpc down, app closed) simply lets its row go stale until the
 * next registration replaces it, so AGE is the only online signal. The
 * timestamp is written by THIS server (registerFrpRoute), so the
 * comparison is not subject to desktop clock skew. */
export const FRP_ONLINE_AFTER_MS = 2 * FRP_HEARTBEAT_MS + 60_000;

/** Console freshness predicate: was this route's heartbeat recent? */
export function frpRouteOnline(updatedAt: string, now = Date.now()): boolean {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && now - t <= FRP_ONLINE_AFTER_MS;
}
