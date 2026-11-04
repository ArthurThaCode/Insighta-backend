import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";

const require = createRequire(import.meta.url);
const { createTestApp, readCookie } = require("./helpers/test-app");

let t;
beforeAll(async () => { t = await createTestApp(); });
afterAll(() => t.close());

describe("refresh and logout", () => {
  const refresh = (token) => request(t.app).post("/auth/refresh").send({ refresh_token: token });

  it("rotates the refresh token and returns expires_in", async () => {
    const { refresh: first } = await t.webLogin();
    const response = await refresh(first);

    expect(response.status).toBe(200);
    expect(response.body.refresh_token).not.toBe(first);
    expect(response.body.expires_in).toBe(180);
    expect((await refresh(first)).status).toBe(401);
    expect((await refresh(response.body.refresh_token)).status).toBe(200);
  });

  it("returns a new CSRF token matching the cookie on a cookie-based refresh", async () => {
    const session = await t.webLogin();
    const response = await request(t.app).post("/auth/refresh").set("Cookie", session.cookie);
    expect(response.status).toBe(200);
    expect(response.body.csrf_token).toBe(readCookie(response, "insighta_csrf"));
  });

  it("rejects a missing token and other methods", async () => {
    expect((await request(t.app).post("/auth/refresh")).status).toBe(400);
    expect((await request(t.app).get("/auth/refresh")).status).toBe(405);
  });

  it("revokes the refresh token on logout", async () => {
    const { refresh: token } = await t.webLogin();
    expect((await request(t.app).post("/auth/logout").send({ refresh_token: token })).status).toBe(204);
    expect((await refresh(token)).status).toBe(401);
  });

  it("clears cookies with the attributes they were set with", async () => {
    const session = await t.webLogin();
    const response = await request(t.app).post("/auth/logout").set("Cookie", session.cookie).set("X-CSRF-Token", session.csrf);
    expect(response.status).toBe(204);
    for (const cookie of response.headers["set-cookie"]) {
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=None/);
    }
  });
});

describe("CSRF", () => {
  const createProfile = (session) => t.api("post", "/api/v1/profiles").set("Cookie", session.cookie).send({ name: "Csrf Test" });

  it("exposes the token through session/me only for cookie sessions", async () => {
    const session = await t.webLogin();
    const byCookie = await t.api("get", "/api/v1/session/me").set("Cookie", session.cookie);
    expect(byCookie.body.data.csrf_token).toBe(session.csrf);

    const byBearer = await t.api("get", "/api/v1/session/me").set("Authorization", `Bearer ${session.access}`);
    expect(byBearer.body.data.csrf_token).toBeNull();
  });

  it("answers 403 to a cross-site write without a token", async () => {
    const session = await t.webLogin();
    const response = await createProfile(session).set("Origin", "https://evil.example");
    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(t.db.profiles.some((profile) => profile.name === "Csrf Test")).toBe(false);
  });

  it("answers 403 to a wrong token and to a delete without a token", async () => {
    const session = await t.webLogin();
    expect((await createProfile(session).set("X-CSRF-Token", "x".repeat(session.csrf.length))).status).toBe(403);
    expect((await createProfile(session).set("X-CSRF-Token", "short")).status).toBe(403);
    expect((await t.api("delete", `/api/v1/profiles/${t.db.profiles[0].id}`).set("Cookie", session.cookie)).status).toBe(403);
  });

  it("accepts a portal write with the token", async () => {
    const session = await t.webLogin();
    const response = await createProfile(session).set("Origin", "https://portal.example").set("X-CSRF-Token", session.csrf);
    expect(response.status).toBe(201);
    expect(response.headers["access-control-allow-origin"]).toBe("https://portal.example");
  });

  it("does not require a token for reads or Bearer requests", async () => {
    const session = await t.webLogin();
    expect((await t.api("get", "/api/v1/profiles?limit=1").set("Cookie", session.cookie)).status).toBe(200);
    expect((await t.api("post", "/api/v1/profiles").set("Authorization", `Bearer ${session.access}`).send({ name: "Bearer Test" })).status).toBe(201);
  });

  it("protects cookie logout but not logout with an explicit refresh token", async () => {
    const session = await t.webLogin();
    expect((await request(t.app).post("/auth/logout").set("Cookie", session.cookie)).status).toBe(403);
    expect((await request(t.app).post("/auth/refresh").send({ refresh_token: session.refresh })).status).toBe(200);

    const cli = await t.webLogin();
    expect((await request(t.app).post("/auth/logout").send({ refresh_token: cli.refresh })).status).toBe(204);
  });

  it.each([
    ["https://portal.example", true],
    ["https://second-portal.example", true],
    ["https://evil.example", false],
  ])("CORS for %s allowed: %s", async (origin, allowed) => {
    const response = await request(t.app).get("/health").set("Origin", origin);
    expect(response.headers["access-control-allow-origin"]).toBe(allowed ? origin : undefined);
    expect(response.headers["access-control-allow-credentials"]).toBe(allowed ? "true" : undefined);
  });
});
