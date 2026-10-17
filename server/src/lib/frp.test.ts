import {createDatabase} from "../db/db.ts";
import {AuthError, createUser} from "./auth.ts";
import {
  frpServerConfig,
  getFrpConnect,
  mintRouteId,
  parsePassword,
  registerFrpRoute,
} from "./frp.ts";

import {describe, expect, it} from "vitest";

async function setup() {
  const db = createDatabase(":memory:");
  const u1 = await createUser(db, "desktop1", "password1");
  const u2 = await createUser(db, "desktop2", "password2");
  return {db, u1, u2};
}

describe("frpServerConfig", () => {
  it("disabled without a token", () => {
    expect(frpServerConfig({})).toEqual({enabled: false, bindPort: 7000, token: ""});
    expect(frpServerConfig({LUMINA_FRPS_TOKEN: "  "}).enabled).toBe(false);
  });

  it("reads port and token, falling back on junk ports", () => {
    expect(frpServerConfig({LUMINA_FRPS_TOKEN: "t", LUMINA_FRPS_BIND_PORT: "8123"})).toEqual({
      enabled: true,
      bindPort: 8123,
      token: "t",
    });
    expect(frpServerConfig({LUMINA_FRPS_TOKEN: "t", LUMINA_FRPS_BIND_PORT: "nope"}).bindPort).toBe(7000);
    expect(frpServerConfig({LUMINA_FRPS_TOKEN: "t", LUMINA_FRPS_BIND_PORT: "-5"}).bindPort).toBe(7000);
  });
});

describe("parsePassword", () => {
  it("accepts a plain string", () => {
    expect(parsePassword({password: "abc"})).toBe("abc");
  });
  it("rejects malformed shapes", () => {
    expect(() => parsePassword({})).toThrow(AuthError);
    expect(() => parsePassword({password: ""})).toThrow(AuthError);
    expect(() => parsePassword({password: 5})).toThrow(AuthError);
    expect(() => parsePassword({password: "x".repeat(257)})).toThrow(AuthError);
  });
});

describe("registerFrpRoute / getFrpConnect", () => {
  it("mints a route id on first contact and reuses it", async () => {
    const {db, u1} = await setup();
    const first = registerFrpRoute(db, u1.id, "pw1");
    expect(first.routeId).toMatch(/^u\d+-[0-9a-f]{8}$/);
    const again = registerFrpRoute(db, u1.id, "pw2", first.routeId);
    expect(again.routeId).toBe(first.routeId);
    const info = getFrpConnect(db, u1.id);
    expect(info).toMatchObject({routeId: first.routeId, password: "pw2"});
    expect(info!.updatedAt).toBeTruthy();
  });

  it("a foreign or stale routeId mints a fresh one (takeover)", async () => {
    const {db, u1} = await setup();
    const first = registerFrpRoute(db, u1.id, "pw1");
    const takeover = registerFrpRoute(db, u1.id, "pw2", "someone-elses-id");
    expect(takeover.routeId).not.toBe("someone-elses-id");
    expect(takeover.routeId).not.toBe(first.routeId);
    // even re-sending the OLD id after a takeover must not resurrect it
    const stale = registerFrpRoute(db, u1.id, "pw3", first.routeId);
    expect(stale.routeId).not.toBe(first.routeId);
    expect(getFrpConnect(db, u1.id)).toMatchObject({password: "pw3"});
  });

  it("per-user isolation", async () => {
    const {db, u1, u2} = await setup();
    const a = registerFrpRoute(db, u1.id, "pw-a");
    const b = registerFrpRoute(db, u2.id, "pw-b");
    expect(a.routeId).not.toBe(b.routeId);
    expect(getFrpConnect(db, u2.id)).toMatchObject({password: "pw-b"});
  });

  it("null when never registered", async () => {
    const {db, u1} = await setup();
    expect(getFrpConnect(db, u1.id)).toBeNull();
  });
});

describe("mintRouteId", () => {
  it("charset stays inside the nginx capture class", () => {
    for (let i = 0; i < 20; i++) {
      expect(mintRouteId(7)).toMatch(/^u7-[0-9a-f]{8}$/);
    }
  });
});
