import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {applyDiffPush, getDiff, parseDiffPush} from "@/lib/sync.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/diffs?directory=<dir> — a directory's mirrored
 * working-copy diff (mobile's Changes view).
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const directory = new URL(req.url).searchParams.get("directory") ?? "";
    const result = getDiff(getDb(), directory);
    if (!result) return Response.json({entries: [], updatedAt: null});
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /api/sync/diffs {directory, entries} — replace the directory's
 * diff snapshot (the desktop's sync engine pushes whatever its stats
 * card's diff cache holds, after every session-list push).
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<unknown>(req);
    const {directory, entries} = parseDiffPush(body);
    applyDiffPush(getDb(), guard.user.id, directory, entries);
    return Response.json({ok: true, files: entries.length});
  } catch (e) {
    return errorResponse(e);
  }
}
