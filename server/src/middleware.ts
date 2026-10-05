import {NextResponse, type NextRequest} from "next/server";

/**
 * CORS for the REST API (`/api/*`): the desktop and future mobile
 * clients are webviews on tauri://localhost / http://tauri.localhost
 * origins, fetching this server cross-origin with an Authorization
 * bearer header (never cookies — credentials stay out of the browser
 * path), so a blanket origin allowance is safe here.
 *
 * The web management UI is same-origin and unaffected. Preflight
 * OPTIONS requests are answered directly by this middleware.
 */
export function middleware(req: NextRequest) {
  if (req.method === "OPTIONS") {
    return preflight();
  }
  const res = NextResponse.next();
  applyCors(res);
  return res;
}

function applyCors(res: NextResponse): void {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
}

function preflight(): NextResponse {
  const res = new NextResponse(null, {status: 204});
  applyCors(res);
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
