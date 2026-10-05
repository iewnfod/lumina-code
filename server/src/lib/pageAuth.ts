import {cookies} from "next/headers";

import {getDb} from "../db/db.ts";
import {SESSION_COOKIE, validateToken, type AuthContext} from "./auth.ts";

/** The page-side twin of the API guard: resolves the logged-in user
 * from the httpOnly session cookie (set by the login server action).
 * Returns null when unauthenticated — protected layouts redirect. */
export async function pageAuth(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateToken(getDb(), token);
}
