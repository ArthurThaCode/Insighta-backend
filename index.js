require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { v7: uuidv7 } = require("uuid");
const { parseNaturalLanguageQuery } = require("./src/services/nlpParser");
const { countryCodeToName } = require("./src/utils/countries");

const app = express();

const PORT = process.env.PORT || 3000;
const WEB_ORIGIN = process.env.WEB_ORIGIN || `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3 * 60);
const REFRESH_TOKEN_TTL_SECONDS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 5 * 60);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me-before-deploying";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const DEFAULT_ROLE = process.env.DEFAULT_ROLE || "analyst";
const ADMIN_LOGINS = new Set(
  (process.env.INSIGHTA_ADMIN_LOGINS || process.env.GITHUB_ADMIN_LOGINS || "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
);

if (JWT_SECRET === "dev-only-change-me-before-deploying") {
  console.warn("JWT_SECRET is not set. Development tokens are not safe for production.");
}

app.set("trust proxy", 1);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const PROFILE_COLUMNS =
  "id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at";
const USER_COLUMNS = "id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at";

const oauthStates = new Map();
const refreshSessions = new Map();
const rateBuckets = new Map();

const VALID_GENDERS = ["male", "female"];
const VALID_AGE_GROUPS = ["child", "teenager", "adult", "senior"];
const VALID_SORT_BY = ["age", "created_at", "gender_probability"];
const VALID_ORDER = ["asc", "desc"];
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload, expiresInSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

function verifyJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid token");
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid token");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }
  return payload;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function cookieOptions({ httpOnly = true, maxAgeSeconds = 900 } = {}) {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly,
    secure,
    sameSite: secure ? "none" : "lax",
    maxAge: maxAgeSeconds * 1000,
    path: "/",
  };
}

function determineRole(githubUser) {
  const login = String(githubUser.login || "").toLowerCase();
  if (ADMIN_LOGINS.has(login)) return "admin";
  return DEFAULT_ROLE === "admin" ? "admin" : "analyst";
}

function mapDbUser(row) {
  return {
    id: row.id,
    github_id: row.github_id,
    login: row.username,
    username: row.username,
    name: row.username,
    email: row.email,
    avatar_url: row.avatar_url,
    role: row.role,
    is_active: row.is_active,
  };
}

async function findUserById(id) {
  const { data, error } = await supabase.from("users").select(USER_COLUMNS).eq("id", id).single();
  if (error) return null;
  return data;
}

async function createOrUpdateUserFromGithub(githubUser, githubToken) {
  let email = githubUser.email || null;
  if (!email && githubToken) {
    try {
      const emailRes = await axios.get("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
      });
      const primary = (emailRes.data || []).find((item) => item.primary) || (emailRes.data || [])[0];
      email = primary ? primary.email : null;
    } catch (error) {
      email = null;
    }
  }

  const githubId = String(githubUser.id);
  const desiredRole = determineRole(githubUser);
  const now = new Date().toISOString();
  const { data: existing, error: selectError } = await supabase
    .from("users")
    .select(USER_COLUMNS)
    .eq("github_id", githubId)
    .single();

  if (selectError && selectError.code !== "PGRST116") throw selectError;

  if (existing) {
    const update = {
      username: githubUser.login,
      email,
      avatar_url: githubUser.avatar_url,
      role: ADMIN_LOGINS.has(String(githubUser.login || "").toLowerCase()) ? "admin" : existing.role || desiredRole,
      last_login_at: now,
    };
    const { data, error } = await supabase.from("users").update(update).eq("id", existing.id).select(USER_COLUMNS).single();
    if (error) throw error;
    return mapDbUser(data);
  }

  const user = {
    id: uuidv7(),
    github_id: githubId,
    username: githubUser.login,
    email,
    avatar_url: githubUser.avatar_url,
    role: desiredRole,
    is_active: true,
    last_login_at: now,
    created_at: now,
  };
  const { data, error } = await supabase.from("users").insert([user]).select(USER_COLUMNS).single();
  if (error) throw error;
  return mapDbUser(data);
}

function issueTokenPair(user) {
  const sessionId = crypto.randomUUID();
  const accessToken = signJwt(
    { sub: String(user.id), login: user.login, name: user.name, avatar_url: user.avatar_url, role: user.role },
    ACCESS_TOKEN_TTL_SECONDS
  );
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  refreshSessions.set(hashToken(refreshToken), {
    sessionId,
    user,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

function sendTokenCookies(res, tokenPair) {
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  res.cookie("insighta_access", tokenPair.accessToken, cookieOptions({ maxAgeSeconds: tokenPair.expiresIn }));
  res.cookie(
    "insighta_refresh",
    tokenPair.refreshToken,
    cookieOptions({ maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS })
  );
  res.cookie("insighta_csrf", csrfToken, cookieOptions({ httpOnly: false, maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS }));
  return csrfToken;
}

function clearAuthCookies(res) {
  for (const name of ["insighta_access", "insighta_refresh", "insighta_csrf", "insighta_pkce_state", "insighta_pkce_verifier"]) {
    res.clearCookie(name, { path: "/" });
  }
}

function extractBearer(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

async function authenticate(req, res, next) {
  const cookies = parseCookies(req);
  const bearer = extractBearer(req);
  const token = bearer || cookies.insighta_access;
  if (!token) return res.status(401).json({ status: "error", message: "Authentication required" });

  try {
    const payload = verifyJwt(token);
    const dbUser = await findUserById(payload.sub);
    if (!dbUser) return res.status(401).json({ status: "error", message: "Invalid user session" });
    if (dbUser.is_active === false) return res.status(403).json({ status: "error", message: "User account is inactive" });
    req.authSource = bearer ? "bearer" : "cookie";
    req.user = mapDbUser(dbUser);
    return next();
  } catch (error) {
    return res.status(401).json({ status: "error", message: "Invalid or expired access token" });
  }
}

function requireApiVersion(req, res, next) {
  if (req.headers["x-api-version"] !== "1") {
    return res.status(400).json({ status: "error", message: "API version header required" });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ status: "error", message: "Insufficient role" });
    }
    return next();
  };
}

function csrfProtection(req, res, next) {
  if (req.authSource !== "cookie" || !MUTATING_METHODS.has(req.method)) return next();
  const cookies = parseCookies(req);
  const expected = cookies.insighta_csrf;
  const actual = req.headers["x-csrf-token"];
  if (!expected || !actual || expected !== actual) {
    return res.status(403).json({ status: "error", message: "Invalid CSRF token" });
  }
  return next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        user: req.user ? req.user.login : null,
        ip: req.ip,
      })
    );
  });
  next();
}

function rateLimit(req, res, next) {
  const windowMs = 60_000;
  const isAuthRoute = req.path.startsWith("/auth/");
  const max = isAuthRoute ? 10 : 60;
  let identity = "anon";
  const bearer = extractBearer(req);
  const cookieToken = parseCookies(req).insighta_access;
  const rateToken = bearer || cookieToken;
  if (rateToken) {
    try {
      identity = verifyJwt(rateToken).sub;
    } catch {
      identity = "invalid-token";
    }
  }
  const key = `${isAuthRoute ? "auth" : "api"}:${req.ip}:${identity}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > max) {
    return res.status(429).json({ status: "error", message: "Rate limit exceeded" });
  }
  return next();
}

function validateProfileQueryParams(query) {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page,
    limit,
  } = query;

  if (gender !== undefined) {
    if (gender === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_GENDERS.includes(gender.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }
  if (age_group !== undefined) {
    if (age_group === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_AGE_GROUPS.includes(age_group.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }
  if (country_id !== undefined && country_id === "")
    return { valid: false, status: 400, message: "Invalid query parameters" };

  for (const [key, value] of Object.entries({ min_age, max_age, page, limit })) {
    if (value === undefined) continue;
    if (value === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const number = Number(value);
    const min = key === "page" || key === "limit" ? 1 : 0;
    if (Number.isNaN(number) || !Number.isInteger(number) || number < min)
      return { valid: false, status: 422, message: "Invalid query parameters" };
    if (key === "limit" && number > 50) return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  for (const value of [min_gender_probability, min_country_probability]) {
    if (value === undefined) continue;
    if (value === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const number = Number(value);
    if (Number.isNaN(number) || number < 0 || number > 1)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  if (sort_by !== undefined) {
    if (sort_by === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_SORT_BY.includes(sort_by.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }
  if (order !== undefined) {
    if (order === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_ORDER.includes(order.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  return { valid: true };
}

function applyFilters(baseQuery, params) {
  let query = baseQuery;
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
  } = params;

  if (gender) query = query.ilike("gender", gender);
  if (age_group) query = query.ilike("age_group", age_group);
  if (country_id) query = query.ilike("country_id", country_id);
  if (min_age !== undefined && min_age !== "") query = query.gte("age", Number(min_age));
  if (max_age !== undefined && max_age !== "") query = query.lte("age", Number(max_age));
  if (min_gender_probability !== undefined && min_gender_probability !== "")
    query = query.gte("gender_probability", Number(min_gender_probability));
  if (min_country_probability !== undefined && min_country_probability !== "")
    query = query.gte("country_probability", Number(min_country_probability));

  return query;
}

function buildPaginationLinks(req, page, limit, totalPages) {
  const makeLink = (targetPage) => {
    if (!targetPage || targetPage < 1 || targetPage > totalPages) return null;
    const params = new URLSearchParams(req.query);
    params.set("page", String(targetPage));
    params.set("limit", String(limit));
    return `${req.baseUrl}${req.path}?${params.toString()}`;
  };
  return {
    self: makeLink(page),
    next: page < totalPages ? makeLink(page + 1) : null,
    prev: page > 1 ? makeLink(page - 1) : null,
  };
}

function paginatedResponse(req, res, { page, limit, total, data }) {
  const safeTotal = total || 0;
  const totalPages = Math.ceil(safeTotal / limit);
  return res.status(200).json({
    status: "success",
    page,
    limit,
    total: safeTotal,
    total_pages: totalPages,
    links: buildPaginationLinks(req, page, limit, totalPages),
    data: data || [],
  });
}

function toCsv(rows) {
  const columns = PROFILE_COLUMNS.split(",").map((column) => column.trim());
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const stringValue = String(value);
    if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
    return stringValue;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}

function buildPkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function requireGithubConfig(res) {
  if (!GITHUB_CLIENT_ID) {
    res.status(500).json({ status: "error", message: "GITHUB_CLIENT_ID is not configured" });
    return false;
  }
  return true;
}

app.use(requestLogger);
app.use(rateLimit);

app.get("/health", (req, res) => {
  res.json({ status: "success", data: { service: "insighta-backend", version: "v1" } });
});

function startGithubAuth(req, res) {
  if (!requireGithubConfig(res)) return;

  const mode = req.query.interface === "cli" ? "cli" : "web";
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = req.query.code_verifier || crypto.randomBytes(48).toString("base64url");
  const challenge = req.query.code_challenge || buildPkceChallenge(verifier);
  const redirectUri =
    req.query.redirect_uri || process.env.GITHUB_REDIRECT_URI || `${WEB_ORIGIN}/auth/github/callback`;

  oauthStates.set(state, {
    mode,
    verifier,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "read:user user:email");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  if (mode === "cli") {
    return res.json({
      status: "success",
      data: {
        authorize_url: authorizeUrl.toString(),
        state,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
    });
  }

  res.cookie("insighta_pkce_state", state, cookieOptions({ maxAgeSeconds: 600 }));
  res.cookie("insighta_pkce_verifier", verifier, cookieOptions({ maxAgeSeconds: 600 }));
  return res.redirect(authorizeUrl.toString());
}

app.get("/auth/github", startGithubAuth);
app.get("/auth/github/start", startGithubAuth);

app.all("/auth/github/callback", async (req, res) => {
  if (!requireGithubConfig(res)) return;

  const cookies = parseCookies(req);
  const code = req.query.code || (req.body && req.body.code);
  const state = req.query.state || (req.body && req.body.state) || cookies.insighta_pkce_state;
  const saved = oauthStates.get(state);

  if (!code || !state || !saved || saved.expiresAt < Date.now()) {
    return res.status(400).json({ status: "error", message: "Invalid or expired OAuth state" });
  }

  oauthStates.delete(state);
  const verifier = (req.body && req.body.code_verifier) || req.query.code_verifier || cookies.insighta_pkce_verifier || saved.verifier;

  try {
    const tokenPayload = {
      client_id: GITHUB_CLIENT_ID,
      code,
      redirect_uri: saved.redirectUri,
      code_verifier: verifier,
    };
    if (GITHUB_CLIENT_SECRET) tokenPayload.client_secret = GITHUB_CLIENT_SECRET;

    const tokenRes = await axios.post("https://github.com/login/oauth/access_token", tokenPayload, {
      headers: { Accept: "application/json" },
    });

    if (!tokenRes.data.access_token) {
      return res.status(401).json({ status: "error", message: "GitHub OAuth exchange failed" });
    }

    const githubRes = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}`, Accept: "application/vnd.github+json" },
    });

    const user = await createOrUpdateUserFromGithub(githubRes.data, tokenRes.data.access_token);
    if (user.is_active === false) {
      return res.status(403).json({ status: "error", message: "User account is inactive" });
    }
    const tokenPair = issueTokenPair(user);

    if (saved.mode === "cli" || req.accepts("json") === "json") {
      return res.json({ status: "success", data: { user, ...tokenPair } });
    }

    sendTokenCookies(res, tokenPair);
    return res.redirect(WEB_ORIGIN);
  } catch (error) {
    console.error("OAuth callback error:", error.response ? error.response.data : error.message);
    return res.status(502).json({ status: "error", message: "GitHub OAuth request failed" });
  }
});

app.post("/auth/refresh", (req, res) => {
  const cookies = parseCookies(req);
  const refreshToken = req.body.refresh_token || cookies.insighta_refresh;
  const session = refreshSessions.get(hashToken(refreshToken || ""));
  if (!session || session.expiresAt < Date.now()) {
    return res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
  }
  refreshSessions.delete(hashToken(refreshToken));
  const tokenPair = issueTokenPair(session.user);
  const response = {
    status: "success",
    access_token: tokenPair.accessToken,
    refresh_token: tokenPair.refreshToken,
    data: { user: session.user, ...tokenPair },
  };
  if (cookies.insighta_refresh) {
    const csrfToken = sendTokenCookies(res, tokenPair);
    response.data.csrfToken = csrfToken;
  }
  return res.json(response);
});

app.post("/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  const refreshToken = req.body.refresh_token || cookies.insighta_refresh;
  if (refreshToken) refreshSessions.delete(hashToken(refreshToken));
  clearAuthCookies(res);
  return res.status(204).send();
});


const api = express.Router();
api.use(requireApiVersion);
api.use(authenticate);
api.use(csrfProtection);

api.get("/session/me", (req, res) => {
  res.json({ status: "success", data: { user: req.user } });
});

api.post("/profiles", requireRole("admin"), async (req, res) => {
  const { name } = req.body;

  if (name === undefined || name === null) {
    return res.status(400).json({ status: "error", message: "Missing or empty name" });
  }
  if (typeof name !== "string") {
    return res.status(422).json({ status: "error", message: "Invalid type" });
  }
  if (name.trim() === "") {
    return res.status(400).json({ status: "error", message: "Missing or empty name" });
  }

  try {
    const { data: existingProfile, error: selectError } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("name", name.trim())
      .single();

    if (selectError && selectError.code !== "PGRST116") throw selectError;

    if (existingProfile) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existingProfile,
      });
    }

    let genderizeRes, agifyRes, nationalizeRes;
    try {
      [genderizeRes, agifyRes, nationalizeRes] = await Promise.all([
        axios.get(`https://api.genderize.io?name=${encodeURIComponent(name.trim())}`),
        axios.get(`https://api.agify.io?name=${encodeURIComponent(name.trim())}`),
        axios.get(`https://api.nationalize.io?name=${encodeURIComponent(name.trim())}`),
      ]);
    } catch (err) {
      return res.status(502).json({ status: "error", message: "Upstream or server failure" });
    }

    const gender = genderizeRes.data.gender;
    const gender_probability = genderizeRes.data.probability;
    const sample_size = genderizeRes.data.count;
    if (!gender || sample_size === 0) {
      return res.status(502).json({ status: "error", message: "Genderize returned an invalid response" });
    }

    const age = agifyRes.data.age;
    if (age === null) return res.status(502).json({ status: "error", message: "Agify returned an invalid response" });

    const countries = nationalizeRes.data.country || [];
    if (countries.length === 0) {
      return res.status(502).json({ status: "error", message: "Nationalize returned an invalid response" });
    }

    const topCountry = countries.sort((a, b) => b.probability - a.probability)[0];
    const country_id = topCountry.country_id;
    const profile = {
      id: uuidv7(),
      name: name.trim(),
      gender,
      gender_probability,
      age,
      age_group: getAgeGroup(age),
      country_id,
      country_name: countryCodeToName[country_id] || null,
      country_probability: topCountry.probability,
      created_at: new Date().toISOString(),
    };

    const { data, error: insertError } = await supabase.from("profiles").insert([profile]).select(PROFILE_COLUMNS);
    if (insertError) throw insertError;

    return res.status(201).json({ status: "success", data: data[0] });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

api.get("/profiles/search", requireRole("admin", "analyst"), async (req, res) => {
  const { q, page: rawPage, limit: rawLimit } = req.query;

  if (q === undefined || q === null || q.trim() === "") {
    return res.status(400).json({ status: "error", message: "Invalid query parameters" });
  }

  const result = parseNaturalLanguageQuery(q);
  if (result.error) return res.status(400).json({ status: "error", message: result.error });

  const page = rawPage ? Math.max(1, parseInt(rawPage, 10) || 1) : 1;
  const limit = rawLimit ? Math.min(50, Math.max(1, parseInt(rawLimit, 10) || 10)) : 10;
  const offset = (page - 1) * limit;

  try {
    let countQuery = supabase.from("profiles").select("*", { count: "exact", head: true });
    countQuery = applyFilters(countQuery, result.filters);
    const { count: total, error: countError } = await countQuery;
    if (countError) throw countError;

    let dataQuery = supabase.from("profiles").select(PROFILE_COLUMNS);
    dataQuery = applyFilters(dataQuery, result.filters);
    dataQuery = dataQuery.order("created_at", { ascending: true }).range(offset, offset + limit - 1);

    const { data, error: dataError } = await dataQuery;
    if (dataError) throw dataError;

    return paginatedResponse(req, res, { page, limit, total, data });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

api.get("/profiles/export", requireRole("admin", "analyst"), async (req, res) => {
  if (req.query.format && req.query.format !== "csv") {
    return res.status(422).json({ status: "error", message: "Unsupported export format" });
  }
  const validation = validateProfileQueryParams({ ...req.query, page: undefined, limit: undefined });
  if (!validation.valid) {
    return res.status(validation.status).json({ status: "error", message: validation.message });
  }

  const filterParams = {
    gender: req.query.gender,
    age_group: req.query.age_group,
    country_id: req.query.country_id,
    min_age: req.query.min_age,
    max_age: req.query.max_age,
    min_gender_probability: req.query.min_gender_probability,
    min_country_probability: req.query.min_country_probability,
  };

  try {
    let dataQuery = supabase.from("profiles").select(PROFILE_COLUMNS);
    dataQuery = applyFilters(dataQuery, filterParams);
    const sortField = req.query.sort_by || "created_at";
    const ascending = (req.query.order || "asc").toLowerCase() === "asc";
    const { data, error } = await dataQuery.order(sortField, { ascending }).limit(10000);
    if (error) throw error;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="profiles_${stamp}.csv"`);
    return res.status(200).send(toCsv(data || []));
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

api.get("/profiles/:id", requireRole("admin", "analyst"), async (req, res) => {
  try {
    const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", req.params.id).single();

    if (error) {
      if (error.code === "PGRST116" || error.code === "22P02") {
        return res.status(404).json({ status: "error", message: "Profile not found" });
      }
      throw error;
    }

    return res.status(200).json({ status: "success", data });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

api.get("/profiles", requireRole("admin", "analyst"), async (req, res) => {
  const validation = validateProfileQueryParams(req.query);
  if (!validation.valid) {
    return res.status(validation.status).json({ status: "error", message: validation.message });
  }

  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page: rawPage,
    limit: rawLimit,
  } = req.query;

  const page = rawPage ? parseInt(rawPage, 10) : 1;
  const limit = rawLimit ? Math.min(50, parseInt(rawLimit, 10)) : 10;
  const offset = (page - 1) * limit;

  try {
    const filterParams = {
      gender,
      age_group,
      country_id,
      min_age,
      max_age,
      min_gender_probability,
      min_country_probability,
    };

    let countQuery = supabase.from("profiles").select("*", { count: "exact", head: true });
    countQuery = applyFilters(countQuery, filterParams);
    const { count: total, error: countError } = await countQuery;
    if (countError) throw countError;

    let dataQuery = supabase.from("profiles").select(PROFILE_COLUMNS);
    dataQuery = applyFilters(dataQuery, filterParams);
    const sortField = sort_by || "created_at";
    const ascending = (order || "asc").toLowerCase() === "asc";
    dataQuery = dataQuery.order(sortField, { ascending }).range(offset, offset + limit - 1);

    const { data, error: dataError } = await dataQuery;
    if (dataError) throw dataError;

    return paginatedResponse(req, res, { page, limit, total, data });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

api.delete("/profiles/:id", requireRole("admin"), async (req, res) => {
  try {
    const { error } = await supabase.from("profiles").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

app.use("/api/v1", api);
app.use("/api", api);

app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


