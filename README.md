# Insighta Labs+ Backend

Secure Profile Intelligence API for Stage 3. The Stage 2 profile features are still available, now behind GitHub OAuth, short-lived access tokens, refresh sessions, role-based access control, API versioning, CSV export, rate limiting, request logging, a web portal, and a globally installable CLI.

## System Architecture

- **Backend:** Node.js + Express
- **Database:** Supabase PostgreSQL, using the existing `profiles` table
- **Auth provider:** GitHub OAuth with PKCE
- **Interfaces:** shared backend for REST API, browser portal, and CLI
- **Versioned API:** primary routes live under `/api/v1`; `/api` remains as a compatibility mount
- **Portal:** static app served from `/portal`
- **CLI:** `insighta`, configured through `package.json#bin`

## Setup

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
WEB_ORIGIN=http://localhost:3000
INSIGHTA_ADMIN_LOGINS=your-github-username
DEFAULT_ROLE=analyst
PORT=3000
```

Then run:

```bash
npm run seed
npm start
```

Open the web portal at:

```text
http://localhost:3000/portal
```

## Auth Flow

The backend starts OAuth at:

```text
GET /auth/github/start?interface=web
GET /auth/github/start?interface=cli
```

For web users, the server generates a PKCE verifier, stores it temporarily with the OAuth state, sets short-lived HTTP-only PKCE cookies, and redirects to GitHub. The callback exchanges the GitHub code for a GitHub token, reads the GitHub user profile, assigns a role, then sets:

- `insighta_access`: HTTP-only access token cookie
- `insighta_refresh`: HTTP-only refresh token cookie
- `insighta_csrf`: readable CSRF token cookie for mutating portal requests

For CLI users, `/auth/github/start?interface=cli` returns the authorization URL, state, and code verifier. The CLI stores the login attempt locally, then sends the GitHub `code`, `state`, and `code_verifier` to `/auth/github/callback`.

## Token Handling

- Access tokens are signed HMAC JWTs with a default 15 minute expiry.
- Refresh tokens are random opaque tokens stored server-side by SHA-256 hash.
- Refresh tokens default to 7 days.
- `/auth/refresh` rotates refresh tokens and returns a new access token.
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

Every `/api/v1` endpoint requires authentication and role checks. Browser mutating requests also require `X-CSRF-Token`.

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

List and search responses now include a `pagination` object:

```json
{
  "status": "success",
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 0,
    "total_pages": 0,
    "has_next": false,
    "has_previous": false
  }
}
```

The legacy `page`, `limit`, and `total` fields are also kept for compatibility.

### CSV Export

```text
GET /api/v1/profiles/export?gender=male&country_id=NG
```

The export endpoint accepts the same filters and sorting parameters as `GET /api/v1/profiles` and returns `text/csv`.

## CLI Usage

Install globally from this repository:

```bash
npm link
```

Login:

```bash
insighta login --api http://localhost:3000
insighta callback --code <code> --state <state>
```

Commands:

```bash
insighta me
insighta profiles --page 1 --limit 10 --gender male
insighta search "young males from nigeria"
insighta create "Ada"
insighta delete <profile-id>
insighta export --out profiles.csv
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

Recognized phrases are converted into the same structured filters used by the normal profile list endpoint.

## Rate Limiting and Logging

The backend applies an in-memory rate limit to all requests. Defaults:

```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

Every request is logged as JSON with timestamp, method, path, status, duration, IP, and authenticated GitHub login when available.

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

## Submission

Run `/submit` in `stage-3-backend` and provide:

- Backend repository URL
- CLI repository URL
- Web portal repository URL
- Live backend URL
- Live web portal URL
