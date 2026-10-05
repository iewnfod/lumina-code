import {createDatabase} from "../db/db.ts";
import {
  AuthError,
  authenticate,
  createTokenForUser,
  createUser,
  hashToken,
  login,
  validateToken,
} from "./auth.ts";

import {describe, expect, it} from "vitest";

function freshDb() {
  return createDatabase(":memory:");
}

async function seeded() {
  const db = freshDb();
  const admin = await createUser(db, "alice", "password1");
  const user = await createUser(db, "bob", "password2");
  return {db, admin, user};
}

describe("createUser", () => {
  it("makes the first user admin, later users plain", async () => {
    const {db, admin, user} = await seeded();
    expect(admin.role).toBe("admin");
    expect(user.role).toBe("user");
    expect(db.prepare("SELECT COUNT(*) c FROM users").get()).toEqual({c: 2});
  });

  it("rejects duplicate usernames with 409", async () => {
    const db = freshDb();
    await createUser(db, "alice", "password1");
    await expect(createUser(db, "alice", "password2")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects bad shapes", async () => {
    const db = freshDb();
    await expect(createUser(db, "bad name!", "password1")).rejects.toBeInstanceOf(AuthError);
    await expect(createUser(db, "alice", "12345")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("tokens", () => {
  it("roundtrips: issue → validate → revoke", async () => {
    const {db, admin} = await seeded();
    const token = createTokenForUser(db, admin.id, "desktop");
    const ctx = validateToken(db, token);
    expect(ctx?.user.username).toBe("alice");
    // revoke via authenticate path
    const req = new Request("https://x/", {
      headers: {authorization: `Bearer ${token}`},
    });
    expect(authenticate(db, req)?.user.id).toBe(admin.id);
    db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(hashToken(token));
    expect(authenticate(db, req)).toBeNull();
  });

  it("reads the token from the session cookie too", async () => {
    const {db, admin} = await seeded();
    const token = createTokenForUser(db, admin.id, "web");
    const req = new Request("https://x/", {
      headers: {cookie: `lumina_session=${encodeURIComponent(token)}; other=1`},
    });
    expect(authenticate(db, req)?.user.id).toBe(admin.id);
  });
});

describe("login", () => {
  it("issues a working token and returns the user", async () => {
    const {db} = await seeded();
    const {user, token} = await login(db, "alice", "password1");
    expect(user.username).toBe("alice");
    expect(validateToken(db, token)?.user.id).toBe(user.id);
  });

  it("rejects wrong password and unknown user alike (401)", async () => {
    const {db} = await seeded();
    await expect(login(db, "alice", "wrongpw1")).rejects.toMatchObject({status: 401});
    await expect(login(db, "nobody", "whatever1")).rejects.toMatchObject({status: 401});
  });

  it("refuses disabled accounts with 403", async () => {
    const {db} = await seeded();
    db.prepare("UPDATE users SET disabled = 1 WHERE username = 'bob'").run();
    await expect(login(db, "bob", "password2")).rejects.toMatchObject({status: 403});
    // existing tokens of a disabled user fail closed as well
    const token = createTokenForUser(
      db,
      (db.prepare("SELECT id FROM users WHERE username='bob'").get() as {id: number}).id,
      "x",
    );
    expect(validateToken(db, token)).toBeNull();
  });
});
