import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {getSyncedSettings, putSyncedSettings} from "@/lib/settings.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings — every synced setting of the authenticated user
 * ({settings: {key: value}}). Clients poll this on startup, on regaining
 * visibility and on a slow timer; each key is reconciled independently
 * (last write wins by server write order — see lib/settings.ts).
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    return Response.json({settings: getSyncedSettings(getDb(), guard.user.id)});
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PUT /api/settings {entries: {key: value}} — publish local edits. The
 * whole batch is validated first (whitelist + size ceiling) and then
 * upserted under one server timestamp; a bad key rejects the batch
 * without writing anything.
 */
export async function PUT(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<{entries?: unknown}>(req);
    return Response.json(putSyncedSettings(getDb(), guard.user.id, body?.entries));
  } catch (e) {
    return errorResponse(e);
  }
}
