"use server";

import {cookies, headers} from "next/headers";
import {redirect} from "next/navigation";

import {getDb} from "@/db/db.ts";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  assertCredentialsShape,
  createTokenForUser,
  createUser,
  login,
  revokeToken,
  verifyPassword,
  hashPassword,
} from "@/lib/auth.ts";
import {pageAuth} from "@/lib/pageAuth.ts";
import {clientIp, rateLimit} from "@/lib/rateLimit.ts";

/**
 * The web UI's form actions (plain <form action={…}> posts — no client
 * JS). Success redirects; failures redirect back with ?error=… so the
 * pages stay fully server-rendered.
 */

function back(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Not `secure` by default: the documented deployment terminates TLS
    // at a reverse proxy, so the app itself sees plain HTTP. Flip
    // LUMINA_COOKIE_SECURE=1 when it is exposed directly over TLS.
    secure: process.env.LUMINA_COOKIE_SECURE === "1",
  });
}

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const hdrs = await headers();
  const ip = clientIp(new Request("http://x", {headers: hdrs}));
  if (!rateLimit(`web|${ip}|${username}`, 10, 10 * 60_000)) {
    back("/login", "too many attempts, try again later");
  }
  try {
    const {token} = await login(getDb(), username, password);
    await setSessionCookie(token);
  } catch (e) {
    back("/login", e instanceof Error ? e.message : "login failed");
  }
  redirect("/");
}

export async function registerAction(formData: FormData): Promise<void> {
  if (process.env.LUMINA_ALLOW_REGISTRATION === "false") {
    back("/register", "registration is disabled on this server");
  }
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  let token: string;
  try {
    const user = await createUser(getDb(), username, password);
    token = createTokenForUser(getDb(), user.id, "web");
  } catch (e) {
    back("/register", e instanceof Error ? e.message : "registration failed");
  }
  await setSessionCookie(token);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const ctx = await pageAuth();
  if (ctx) revokeToken(getDb(), ctx.tokenId);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  if (!(await verifyPassword(ctx.user.password_hash, current))) {
    back("/account", "current password is incorrect");
  }
  try {
    assertCredentialsShape(ctx.user.username, next);
  } catch (e) {
    back("/account", e instanceof Error ? e.message : "invalid password");
  }
  getDb()
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(await hashPassword(next), ctx.user.id);
  redirect("/account?ok=password+changed");
}

export async function setDisabledAction(formData: FormData): Promise<void> {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  if (ctx.user.role !== "admin") back("/users", "admin only");
  const userId = Number(formData.get("userId"));
  const disabled = formData.get("disabled") === "1" ? 1 : 0;
  if (!Number.isInteger(userId)) back("/users", "invalid user");
  if (userId === ctx.user.id) back("/users", "cannot disable your own account");
  getDb().prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled, userId);
  redirect("/users");
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  if (ctx.user.role !== "admin") back("/users", "admin only");
  const userId = Number(formData.get("userId"));
  const password = String(formData.get("password") ?? "");
  if (!Number.isInteger(userId)) back("/users", "invalid user");
  if (password.length < MIN_PASSWORD_LENGTH) {
    back("/users", `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  getDb()
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(await hashPassword(password), userId);
  redirect("/users?ok=password+reset");
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  const tokenId = Number(formData.get("tokenId"));
  if (!Number.isInteger(tokenId)) back("/account", "invalid token");
  const db = getDb();
  const row = db
    .prepare("SELECT user_id FROM tokens WHERE id = ?")
    .get(tokenId) as {user_id: number} | undefined;
  if (!row) back("/account", "no such token");
  if (row.user_id !== ctx.user.id && ctx.user.role !== "admin") {
    back("/account", "admin only");
  }
  revokeToken(db, tokenId);
  redirect("/account?ok=token+revoked");
}
