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
