import {createDatabase} from "../db/db.ts";
import {
  AuthError,
  MAX_TOKEN_LABEL_LENGTH,
  authenticate,
  createTokenForUser,
  createUser,
  hashToken,
  login,
  sanitizeTokenLabel,
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

describe("sanitizeTokenLabel", () => {
  it("passes good labels through untouched", () => {
    expect(sanitizeTokenLabel("desktop (myhost)", "login")).toBe("desktop (myhost)");
    expect(sanitizeTokenLabel("mobile (Pixel 9)", "login")).toBe("mobile (Pixel 9)");
  });

  it("falls back on non-strings and blanks", () => {
    expect(sanitizeTokenLabel(undefined, "login")).toBe("login");
    expect(sanitizeTokenLabel(42, "register")).toBe("register");
    expect(sanitizeTokenLabel("   ", "login")).toBe("login");
    expect(sanitizeTokenLabel("", "login")).toBe("login");
  });

  it("trims, strips control characters, truncates to the cap", () => {
    expect(sanitizeTokenLabel("  web  ", "login")).toBe("web");
    expect(sanitizeTokenLabel("desk\u0000top\u007f", "login")).toBe("desktop");
    const long = "x".repeat(MAX_TOKEN_LABEL_LENGTH + 10);
    expect(sanitizeTokenLabel(long, "login")).toHaveLength(MAX_TOKEN_LABEL_LENGTH);
    // trailing whitespace exposed by the truncation does not survive
    expect(sanitizeTokenLabel(`${"x".repeat(MAX_TOKEN_LABEL_LENGTH)}   tail`, "login")).toHaveLength(
      MAX_TOKEN_LABEL_LENGTH,
    );
  });

  it("a label of ONLY control characters falls back", () => {
    expect(sanitizeTokenLabel("\u0001\u0002", "login")).toBe("login");
  });
});

describe("login", () => {
  it("issues a working token and returns the user", async () => {
    const {db} = await seeded();
    const {user, token} = await login(db, "alice", "password1");
    expect(user.username).toBe("alice");
    expect(validateToken(db, token)?.user.id).toBe(user.id);
  });

  it("labels the token (default 'login', custom passes through)", async () => {
    const {db} = await seeded();
    const labeled = await login(db, "alice", "password1", "desktop (myhost)");
    const row = db
      .prepare("SELECT label FROM tokens WHERE token_hash = ?")
      .get(hashToken(labeled.token)) as {label: string};
    expect(row.label).toBe("desktop (myhost)");

    const plain = await login(db, "bob", "password2");
    const row2 = db
      .prepare("SELECT label FROM tokens WHERE token_hash = ?")
      .get(hashToken(plain.token)) as {label: string};
    expect(row2.label).toBe("login");
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
