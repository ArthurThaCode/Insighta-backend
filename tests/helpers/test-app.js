// Starts the real Express app against the fake Supabase and GitHub. Vitest runs each test file in its own process.
const crypto = require("crypto");
const request = require("supertest");
const { start } = require("../fixtures/mock-supabase");
const { installFakeGithub } = require("../fixtures/mock-github");

const JWT_SECRET = "test-secret-not-used-anywhere-else";
const WEB_ORIGIN = "https://portal.example";

function signToken(payload, { ttl = 600, secret = JWT_SECRET } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ ...payload, iat: now, exp: now + ttl });
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

function readCookie(response, name) {
  const cookie = (response.headers["set-cookie"] || []).find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(";")[0].slice(name.length + 1) : undefined;
}

async function createTestApp(env = {}) {
  const supabase = await start(0);
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${supabase.server.address().port}`,
    SUPABASE_ANON_KEY: "test-anon-key",
    JWT_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_REDIRECT_URI: "https://api.example/auth/github/callback",
    WEB_ORIGIN,
    CORS_ORIGIN: `${WEB_ORIGIN},https://second-portal.example`,
    INSIGHTA_ADMIN_LOGINS: "test-admin",
    RATE_LIMIT_MAX: "100000",
    RATE_LIMIT_AUTH_MAX: "100000",
    ...env,
  });
  const github = installFakeGithub();
  const app = require("../../index");

  const addUser = (id, role) => {
    supabase.db.users.push({ id, github_id: `github-${id}`, username: id, email: "", avatar_url: "", role, is_active: true });
    return signToken({ sub: id });
  };

  const api = (method, path) => request(app)[method](path).set("X-API-Version", "1");

  // Signs in through the browser flow and returns the session cookies.
  async function webLogin(code = "gh-admin") {
    const start = await request(app).get("/auth/github/start?interface=web");
    const state = new URL(start.headers.location).searchParams.get("state");
    const callback = await request(app)
      .get(`/auth/github/callback?code=${code}&state=${state}`)
      .set("Cookie", start.headers["set-cookie"].map((value) => value.split(";")[0]).join("; "));
    const access = readCookie(callback, "insighta_access");
    const refresh = readCookie(callback, "insighta_refresh");
    const csrf = readCookie(callback, "insighta_csrf");
    return { start, callback, access, refresh, csrf, cookie: `insighta_access=${access}; insighta_refresh=${refresh}; insighta_csrf=${csrf}` };
  }

  return { app, db: supabase.db, github, addUser, api, webLogin, close: () => supabase.server.close() };
}

module.exports = { createTestApp, signToken, readCookie, WEB_ORIGIN };
