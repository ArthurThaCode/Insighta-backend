require("dotenv").config();
const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me-before-deploying";
// 2 hours TTL — enough time for the grader to run
const TOKEN_TTL = 2 * 60 * 60;

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
const adminRefreshToken = crypto.randomBytes(48).toString("base64url");

console.log("\n========================================");
console.log("  INSIGHTA TEST TOKENS (valides 2h)");
console.log("========================================\n");
console.log(">>> Admin Test Token:");
console.log(adminAccessToken);
console.log("\n>>> Analyst Test Token:");
console.log(analystAccessToken);
console.log("\n>>> Refresh Test Token (pour admin):");
console.log(adminRefreshToken);
console.log("\n========================================");
console.log("Copiez ces valeurs dans le formulaire HNG.");
console.log("Soumettez IMMEDIATEMENT apres avoir copie !");
console.log("========================================\n");
