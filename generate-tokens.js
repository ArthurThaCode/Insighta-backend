require("dotenv").config();
const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me-before-deploying";
// Long TTL: 2 hours — so the tokens stay valid during grading
const TOKEN_TTL = 2 * 60 * 60;

if (JWT_SECRET === "dev-only-change-me-before-deploying") {
  console.error("\nERROR: JWT_SECRET is not set in .env — tokens will NOT match Railway!\n");
  process.exit(1);
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

const adminUser = {
  sub: "00000000-0000-0000-0000-000000000001",
  id: "00000000-0000-0000-0000-000000000001",
  github_id: "test_admin",
  login: "admin_bot",
  username: "admin_bot",
  name: "admin_bot",
  email: "admin_bot@example.com",
  avatar_url: "",
  role: "admin",
};

const analystUser = {
  sub: "00000000-0000-0000-0000-000000000002",
  id: "00000000-0000-0000-0000-000000000002",
  github_id: "test_analyst",
  login: "analyst_bot",
  username: "analyst_bot",
  name: "analyst_bot",
  email: "analyst_bot@example.com",
  avatar_url: "",
  role: "analyst",
};

const adminAccessToken = signJwt(adminUser, TOKEN_TTL);
const analystAccessToken = signJwt(analystUser, TOKEN_TTL);
// Refresh token must match what the server registers — use /api/test-tokens for that
// This is just a placeholder for the form refresh field
const adminRefreshPlaceholder = "USE_SERVER_ENDPOINT_SEE_BELOW";

console.log("\n========================================");
console.log("  INSIGHTA TEST TOKENS (valides 2h)");
console.log("  Signés avec la VRAIE clé Railway");
console.log("========================================\n");
console.log(">>> Admin Test Token:");
console.log(adminAccessToken);
console.log("\n>>> Analyst Test Token:");
console.log(analystAccessToken);
console.log("\n>>> IMPORTANT — Pour le Refresh Test Token:");
console.log("    Appelez ce endpoint juste avant de soumettre:");
console.log("    curl https://backendhng-production.up.railway.app/api/test-tokens");
console.log("    Utilisez la valeur 'admin_refresh_token' du résultat.");
console.log("\n========================================\n");
