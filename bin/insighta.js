#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const CONFIG_DIR = path.join(os.homedir(), ".insighta");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const DEFAULT_API_URL = process.env.INSIGHTA_API_URL || "http://localhost:3000";

function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCredentials(credentials) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

function removeCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
}

function request(method, urlString, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] || "";
          const data = contentType.includes("application/json") && text ? JSON.parse(text) : text;
          if (res.statusCode >= 400) {
            const message = data && data.message ? data.message : `Request failed with ${res.statusCode}`;
            reject(new Error(message));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

function apiUrl(credentials, args) {
  return (args.api || credentials.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
}

async function refreshIfNeeded(credentials) {
  if (!credentials.refreshToken) return credentials;
  const expiresAt = credentials.expiresAt || 0;
  if (Date.now() < expiresAt - 30_000) return credentials;
  const data = await request("POST", `${credentials.apiUrl}/auth/refresh`, {
    body: { refresh_token: credentials.refreshToken },
  });
  const next = {
    ...credentials,
    accessToken: data.data.accessToken,
    refreshToken: data.data.refreshToken,
    user: data.data.user,
    expiresAt: Date.now() + data.data.expiresIn * 1000,
  };
  writeCredentials(next);
  return next;
}

async function authedRequest(method, pathName, { args, body, raw = false } = {}) {
  let credentials = readCredentials();
  credentials.apiUrl = apiUrl(credentials, args || {});
  credentials = await refreshIfNeeded(credentials);
  if (!credentials.accessToken) throw new Error("Run `insighta login` first.");
  return request(method, `${credentials.apiUrl}${pathName}`, {
    token: credentials.accessToken,
    body,
    headers: raw ? { Accept: "text/csv" } : {},
  });
}

function formatTable(rows) {
  if (!rows.length) {
    console.log("No profiles found.");
    return;
  }
  const widths = {
    name: Math.max(4, ...rows.map((row) => String(row.name).length)),
    gender: 6,
    age: 3,
    country: Math.max(7, ...rows.map((row) => String(row.country_id || "").length)),
  };
  console.log(
    `${"NAME".padEnd(widths.name)}  GENDER  AGE  ${"COUNTRY".padEnd(widths.country)}  CREATED`
  );
  for (const row of rows) {
    console.log(
      `${String(row.name).padEnd(widths.name)}  ${String(row.gender).padEnd(widths.gender)}  ${String(row.age).padEnd(
        widths.age
      )}  ${String(row.country_id || "").padEnd(widths.country)}  ${row.created_at}`
    );
  }
}

function usage() {
  console.log(`Insighta CLI

Usage:
  insighta login [--api http://localhost:3000]
  insighta callback --code <code> --state <state>
  insighta me
  insighta profiles [--page 1] [--limit 10] [--gender male] [--country_id NG]
  insighta search "young males from nigeria"
  insighta create "Ada"
  insighta delete <profile-id>
  insighta export [--out profiles.csv]
  insighta logout
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const credentials = readCredentials();
  const baseUrl = apiUrl(credentials, args);

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "login") {
    const data = await request("GET", `${baseUrl}/auth/github/start?interface=cli`);
    writeCredentials({
      apiUrl: baseUrl,
      state: data.data.state,
      codeVerifier: data.data.code_verifier,
      redirectUri: data.data.redirect_uri,
    });
    console.log("Open this URL in your browser:");
    console.log(data.data.authorize_url);
    console.log("\nThen run:");
    console.log("insighta callback --code <code> --state <state>");
    return;
  }

  if (command === "callback") {
    if (!args.code || !args.state) throw new Error("callback requires --code and --state");
    if (args.state !== credentials.state) throw new Error("OAuth state does not match the stored login attempt.");
    const data = await request("POST", `${baseUrl}/auth/github/callback`, {
      body: { code: args.code, state: args.state, code_verifier: credentials.codeVerifier },
    });
    writeCredentials({
      apiUrl: baseUrl,
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken,
      expiresAt: Date.now() + data.data.expiresIn * 1000,
      user: data.data.user,
    });
    console.log(`Logged in as ${data.data.user.login} (${data.data.user.role}).`);
    return;
  }

  if (command === "logout") {
    if (credentials.refreshToken) {
      await request("POST", `${baseUrl}/auth/logout`, { body: { refresh_token: credentials.refreshToken } }).catch(
        () => {}
      );
    }
    removeCredentials();
    console.log("Logged out.");
    return;
  }

  if (command === "me") {
    const data = await authedRequest("GET", "/api/v1/session/me", { args });
    console.log(JSON.stringify(data.data.user, null, 2));
    return;
  }

  if (command === "profiles") {
    const query = new URLSearchParams();
    for (const key of ["page", "limit", "gender", "age_group", "country_id", "min_age", "max_age", "sort_by", "order"]) {
      if (args[key]) query.set(key, args[key]);
    }
    const data = await authedRequest("GET", `/api/v1/profiles?${query.toString()}`, { args });
    formatTable(data.data);
    console.log(`\nPage ${data.pagination.page}/${Math.max(data.pagination.total_pages, 1)} (${data.pagination.total} total)`);
    return;
  }

  if (command === "search") {
    const q = args._.slice(1).join(" ");
    if (!q) throw new Error("search requires a query, e.g. insighta search \"young males\"");
    const data = await authedRequest("GET", `/api/v1/profiles/search?q=${encodeURIComponent(q)}`, { args });
    formatTable(data.data);
    return;
  }

  if (command === "create") {
    const name = args._.slice(1).join(" ");
    if (!name) throw new Error("create requires a name");
    const data = await authedRequest("POST", "/api/v1/profiles", { args, body: { name } });
    console.log(JSON.stringify(data.data, null, 2));
    return;
  }

  if (command === "delete") {
    const id = args._[1];
    if (!id) throw new Error("delete requires a profile id");
    await authedRequest("DELETE", `/api/v1/profiles/${encodeURIComponent(id)}`, { args });
    console.log("Profile deleted.");
    return;
  }

  if (command === "export") {
    const csv = await authedRequest("GET", "/api/v1/profiles/export", { args, raw: true });
    if (args.out) {
      fs.writeFileSync(args.out, csv);
      console.log(`Exported to ${args.out}`);
    } else {
      process.stdout.write(csv);
    }
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
