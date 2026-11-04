# Insighta Labs+ Backend

Secure Profile Intelligence API for Stage 3. The Stage 2 profile features are still available, now behind GitHub OAuth, short-lived access tokens, refresh sessions, role-based access control, API versioning, CSV export, rate limiting, request logging, a web portal, and a globally installable CLI.

## System Architecture

- **Backend:** Node.js + Express
- **Database:** Supabase PostgreSQL, using the existing `profiles` table
- **Auth provider:** GitHub OAuth with PKCE
- **Interfaces:** shared backend for REST API, browser portal, and CLI
- **Versioned API:** primary routes live under `/api/v1`; `/api` remains as a compatibility mount
- **Portal:** separate `Insighta-web` static repository calling this backend
- **CLI:** separate `Insighta-cli` repository using this backend

## Setup

Requires Node.js 22.

```bash
npm install
```

Create a `.env` file:

```env
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-supabase-key
JWT_SECRET=replace-with-a-long-random-secret
GITHUB_CLIENT_ID=your-github-oauth-app-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-client-secret
GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback
WEB_ORIGIN=http://localhost:5173
# Comma-separated list of allowed origins. Defaults to WEB_ORIGIN.
CORS_ORIGIN=http://localhost:5173
INSIGHTA_ADMIN_LOGINS=your-github-username
DEFAULT_ROLE=analyst
PORT=3000
```

`JWT_SECRET` is required: the server refuses to start without it.

### Database setup

Run these scripts in the Supabase SQL editor, in this order:

1. `database/profiles.sql`: profiles table and indexes
2. `database/users.sql`: users table

### Seeding

The dataset is the 2026-profile JSON file supplied with the Stage 2 brief. It is not part of this repository. To load it, add it at the project root as `seed_profiles.json`, in this shape:

```json
{ "profiles": [ { "name": "", "gender": "", "gender_probability": 0, "age": 0, "age_group": "", "country_id": "", "country_name": "", "country_probability": 0 } ] }
```

`npm run seed` upserts on the unique `name`. Running it again updates existing rows, keeps their `id` and `created_at`, and leaves other rows untouched. Without the file it stops with an error.

Then run:

```bash
npm run seed
npm start
```

Run or deploy the separate `Insighta-web` repository, then point it to this backend URL.

## Auth Flow

The backend starts OAuth at:

```text
GET /auth/github/start?interface=web
GET /auth/github/start?interface=cli
```

For web users, the server generates a PKCE verifier, stores it temporarily with the OAuth state, sets short-lived HTTP-only PKCE cookies, and redirects to GitHub. The callback exchanges the GitHub code for a GitHub token, reads the GitHub user profile, assigns a role, then sets:

- `insighta_access`: HTTP-only access token cookie
- `insighta_refresh`: HTTP-only refresh token cookie
- `insighta_csrf`: HTTP-only CSRF cookie, compared with the `X-CSRF-Token` header

For CLI users, the CLI generates the PKCE verifier locally and calls `/auth/github/start?interface=cli` with its `code_challenge` and a loopback `redirect_uri` (`http://127.0.0.1:<port>` or `http://localhost:<port>`). The backend returns the authorization URL and state, and never sees the verifier until the CLI sends the GitHub `code`, `state`, and `code_verifier` to `/auth/github/callback`.

## CSRF and CORS

Cross-origin requests with credentials are only allowed from the origins listed in `CORS_ORIGIN`.

Requests authenticated by cookie that change data (`POST`, `PUT`, `PATCH`, `DELETE`, and `/auth/logout`) must send an `X-CSRF-Token` header matching the `insighta_csrf` cookie, otherwise they receive `403`. Because the cookie is HTTP-only and the portal runs on another origin, the portal gets the token from the `csrf_token` field of `GET /api/v1/session/me` (and of `POST /auth/refresh`) and keeps it in memory.

Requests authenticated with a Bearer token, such as the CLI, do not need a CSRF token. `POST /auth/refresh` is exempt too: it has to work after a page reload, before the portal holds a token, and it returns nothing a cross-site page can read.

## Token Handling

- Access tokens are signed HMAC JWTs with a default 3 minute expiry (`ACCESS_TOKEN_TTL_SECONDS`).
- Refresh tokens are random opaque tokens stored server-side by SHA-256 hash.
- Refresh tokens default to 5 minutes (`REFRESH_TOKEN_TTL_SECONDS`). These short windows are a deliberate choice: a stolen token is useful for very little time.
- Refresh sessions are kept in memory. This is an accepted trade-off to keep the service simple: restarting the server signs everyone out, and it would not work with several instances.
- `/auth/refresh` rotates refresh tokens and returns a new access token with its `expires_in`.
- `/auth/logout` revokes the current refresh token.
- The browser uses HTTP-only cookies.
- The CLI stores credentials at:

```text
~/.insighta/credentials.json
```

## Role Enforcement

Roles are derived after GitHub login:

- GitHub usernames in `INSIGHTA_ADMIN_LOGINS` become `admin`
- all other users become `analyst`, unless `DEFAULT_ROLE=admin`

Access rules:

- `admin`: create profiles, delete profiles, read/search/export profiles
- `analyst`: read/search/export profiles only

Every `/api/v1` endpoint requires authentication, and the profile endpoints check the role. The role is read from the `users` table on each request, and a token whose user no longer exists is rejected.

## API Endpoints

All routes below require authentication.

### Session

```text
GET /api/v1/session/me
```

### Profiles

```text
POST   /api/v1/profiles          admin only
GET    /api/v1/profiles          admin, analyst
GET    /api/v1/profiles/:id      admin, analyst
DELETE /api/v1/profiles/:id      admin only
GET    /api/v1/profiles/search   admin, analyst
GET    /api/v1/profiles/export   admin, analyst
```

Filtering, sorting, pagination, and natural language search from Stage 2 remain intact.

### Updated Pagination Shape

List and search responses have this shape. `limit` accepts at most 50, and a higher value returns `422`:

```json
{
  "status": "success",
  "page": 2,
  "limit": 5,
  "total": 60,
  "total_pages": 12,
  "links": {
    "self": "/api/v1/profiles?page=2&limit=5",
    "next": "/api/v1/profiles?page=3&limit=5",
    "prev": "/api/v1/profiles?page=1&limit=5"
  },
  "data": []
}
```

### CSV Export

```text
GET /api/v1/profiles/export?gender=male&country_id=NG
```

The export endpoint accepts the same filters and sorting parameters as `GET /api/v1/profiles` and returns `text/csv`.

## CLI Usage

Install globally from the separate `Insighta-cli` repository:

```bash
npm install -g .
```

Commands:

```bash
insighta login --api http://localhost:3000
insighta whoami
insighta profiles list --page 1 --limit 10 --gender male
insighta profiles get <profile-id>
insighta profiles search "young males from nigeria"
insighta profiles create --name "Ada"
insighta profiles delete <profile-id> --yes
insighta profiles export --format csv
insighta logout
```

The CLI refreshes access tokens automatically when they are close to expiry.

## Natural Language Parsing Approach

The parser is rule-based and lives in `src/services/nlpParser.js`. It does not use an LLM. It recognizes:

- gender words like `male`, `men`, `female`, `women`
- age groups like `child`, `teenager`, `adult`, `senior`
- age ranges like `above 30`, `under 18`, `between 20 and 30`
- country phrases like `from nigeria` or `in kenya`
- neutral words like `people`, `profiles`, and `all`

Recognized phrases are converted into the same structured filters used by the normal profile list endpoint. A query that cannot be interpreted, including one naming an unknown country, returns `400` with `Unable to interpret query`. A contradictory age range such as `young males above 30` returns `422`.

## Rate Limiting and Logging

The backend applies an in-memory rate limit per client IP, with a stricter limit on `/auth/*`. Defaults:

```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
RATE_LIMIT_AUTH_MAX=10
```

The client IP is `req.ip`, with Express configured to trust one proxy. Counters reset when the server restarts.

Every request is logged as JSON with timestamp, method, path, status, duration, IP, and authenticated GitHub login when available. OAuth `code`, `state`, and `code_verifier` values are masked in the logged path.

## CI/CD

A lightweight syntax check is available:

```bash
npm run check
```

Recommended CI pipeline:

```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run check
```
