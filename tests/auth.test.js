import { createRequire } from "node:module";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";

const require = createRequire(import.meta.url);
const { createTestApp, signToken } = require("./helpers/test-app");
const LOOPBACK = encodeURIComponent("http://127.0.0.1:53682/callback");

describe("authentication", () => {
  let t;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  describe("startup", () => {
    it("refuses to start without JWT_SECRET", () => {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: "http://localhost", SUPABASE_ANON_KEY: "key", DOTENV_CONFIG_QUIET: "true" };
      const result = spawnSync(process.execPath, ["index.js"], { cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 15000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("JWT_SECRET is required");
    });
  });

  describe("web OAuth", () => {
    it("starts with an S256 PKCE challenge matching the HTTP-only verifier cookie", async () => {
      const response = await request(t.app).get("/auth/github/start?interface=web");
      const location = new URL(response.headers.location);
      const verifierCookie = response.headers["set-cookie"].find((value) => value.startsWith("insighta_pkce_verifier="));
      const verifier = verifierCookie.split(";")[0].split("=")[1];

      expect(response.status).toBe(302);
      expect(location.origin).toBe("https://github.com");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"));
      expect(verifierCookie).toContain("HttpOnly");
    });

    it("ignores a redirect_uri supplied by the caller", async () => {
      const response = await request(t.app).get(`/auth/github/start?interface=web&redirect_uri=${encodeURIComponent("https://evil.example/steal")}`);
      expect(new URL(response.headers.location).searchParams.get("redirect_uri")).toBe("https://api.example/auth/github/callback");
    });

    it("issues HTTP-only cookies with a 3 minute access token and a 5 minute refresh token", async () => {
      const { callback, access } = await t.webLogin();
      const cookies = callback.headers["set-cookie"];
      const claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString());

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe("https://portal.example");
      expect(claims.exp - claims.iat).toBe(180);
      expect(cookies.find((value) => value.startsWith("insighta_access="))).toContain("Max-Age=180");
      expect(cookies.find((value) => value.startsWith("insighta_refresh="))).toContain("Max-Age=300");
      for (const cookie of cookies) expect(cookie).toMatch(/HttpOnly; Secure; SameSite=None/);
    });

    it("rejects an unknown state and a replayed state", async () => {
      expect((await request(t.app).get("/auth/github/callback?code=gh-admin&state=unknown")).status).toBe(400);

      const start = await request(t.app).get("/auth/github/start?interface=web");
      const state = new URL(start.headers.location).searchParams.get("state");
      const url = `/auth/github/callback?code=gh-admin&state=${state}`;
      const cookie = `insighta_pkce_state=${state}`;
      expect((await request(t.app).get(url).set("Cookie", cookie)).status).toBe(302);
      expect((await request(t.app).get(url).set("Cookie", cookie)).status).toBe(400);
    });

    it("rejects a callback from a browser that did not start the login", async () => {
      const attacker = await request(t.app).get("/auth/github/start?interface=web");
      const state = new URL(attacker.headers.location).searchParams.get("state");
      const url = `/auth/github/callback?code=gh-admin&state=${state}`;

      for (const victimCookie of [null, "insighta_pkce_state=another-state"]) {
        const attempt = request(t.app).get(url);
        if (victimCookie) attempt.set("Cookie", victimCookie);
        const response = await attempt;
        expect(response.status).toBe(400);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("does not fall back to the state cookie when the state parameter is missing", async () => {
      const victim = await request(t.app).get("/auth/github/start?interface=web");
      const state = new URL(victim.headers.location).searchParams.get("state");
      const response = await request(t.app).get("/auth/github/callback?code=gh-admin").set("Cookie", `insighta_pkce_state=${state}`);
      expect(response.status).toBe(400);
    });

    it("assigns the role from the admin list", async () => {
      const admin = await t.webLogin("gh-admin");
      const analyst = await t.webLogin("gh-analyst");
      const roleOf = async (session) => (await t.api("get", "/api/v1/session/me").set("Cookie", session.cookie)).body.data.user.role;
      expect(await roleOf(admin)).toBe("admin");
      expect(await roleOf(analyst)).toBe("analyst");
    });
  });

  describe("CLI OAuth", () => {
    it("requires a code_challenge and never returns a verifier", async () => {
      expect((await request(t.app).get(`/auth/github/start?interface=cli&redirect_uri=${LOOPBACK}`)).status).toBe(400);

      const response = await request(t.app).get(`/auth/github/start?interface=cli&redirect_uri=${LOOPBACK}&code_challenge=challenge`);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.data).sort()).toEqual(["authorize_url", "redirect_uri", "state"]);
      expect(new URL(response.body.data.authorize_url).searchParams.get("code_challenge")).toBe("challenge");
    });

    it.each([
      ["https://evil.example/steal", 400],
      ["http://127.0.0.1.evil.example:80/x", 400],
      ["http://127.0.0.1:1@evil.example:80/x", 400],
      ["https://127.0.0.1:3000/x", 400],
      ["http://127.0.0.1/no-port", 400],
      ["http://127.0.0.1:53682/callback", 200],
      ["http://localhost:9000/callback", 200],
    ])("answers %s with %i", async (uri, status) => {
      const response = await request(t.app).get(`/auth/github/start?interface=cli&code_challenge=c&redirect_uri=${encodeURIComponent(uri)}`);
      expect(response.status).toBe(status);
    });

    it("forwards the CLI verifier to GitHub and requires it", async () => {
      const start = () => request(t.app).get(`/auth/github/start?interface=cli&redirect_uri=${LOOPBACK}&code_challenge=c`);
      const missing = await request(t.app).post("/auth/github/callback").send({ code: "gh-analyst", state: (await start()).body.data.state });
      expect(missing.status).toBe(400);

      const success = await request(t.app).post("/auth/github/callback").send({ code: "gh-analyst", state: (await start()).body.data.state, code_verifier: "cli-verifier" });
      expect(success.status).toBe(200);
      expect(success.body.expires_in).toBe(180);
      expect(t.github.exchanges.at(-1).code_verifier).toBe("cli-verifier");
    });
  });

  describe("access tokens", () => {
    it("rejects missing, forged, expired, and unsigned tokens", async () => {
      t.addUser("token-user", "admin");
      const claims = { sub: "token-user", role: "admin" };
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "none" })}.${encode({ ...claims, exp: 9999999999 })}.`;

      expect((await t.api("get", "/api/v1/profiles")).status).toBe(401);
      for (const token of [signToken(claims, { secret: "wrong" }), signToken(claims, { ttl: -10 }), unsigned]) {
        expect((await t.api("get", "/api/v1/profiles").set("Authorization", `Bearer ${token}`)).status).toBe(401);
      }
    });

    it("rejects a valid token whose user does not exist", async () => {
      const token = signToken({ sub: "ghost", role: "admin" });
      expect((await t.api("get", "/api/v1/session/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    });

    it("requires the API version header", async () => {
      const token = t.addUser("version-user", "analyst");
      expect((await request(t.app).get("/api/v1/profiles").set("Authorization", `Bearer ${token}`)).status).toBe(400);
    });
  });

  describe("removed test access", () => {
    it("no longer offers test tokens or test login codes", async () => {
      expect((await request(t.app).get("/api/test-tokens")).status).toBe(400);
      expect((await t.api("get", "/api/test-tokens")).status).toBe(401);
      expect((await request(t.app).post("/seed-test-users")).status).toBe(404);
      for (const code of ["admin_test_code", "test_code"]) {
        expect((await request(t.app).post(`/auth/github/callback?code=${code}`)).status).toBe(400);
      }
    });
  });
});
