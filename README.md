# Insighta Labs — Profile Intelligence API

A production-ready backend API that collects, stores, and intelligently queries demographic profile data. Built for **Insighta Labs**, a demographic intelligence company.

## Features

- **Profile Collection** — Enrich names using Genderize, Agify, and Nationalize APIs
- **Advanced Filtering** — Filter profiles by gender, age, age group, country, and probability scores
- **Combined Filters** — Stack multiple filter conditions in a single query (AND logic)
- **Sorting** — Sort results by age, creation date, or gender probability
- **Pagination** — Offset-based pagination with configurable page size (max 50)
- **Natural Language Search** — Query profiles using plain English (e.g., *"young males from nigeria"*)

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** Supabase (PostgreSQL)
- **IDs:** UUID v7 (time-ordered)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Set the following environment variables (via `.env` file locally or dashboard for deployment):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `PORT` | Server port (default: 3000) |

### 3. Database schema

The `profiles` table follows this structure:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID v7 | Primary key |
| `name` | VARCHAR + UNIQUE | Full name |
| `gender` | VARCHAR | `"male"` or `"female"` |
| `gender_probability` | FLOAT | Confidence score |
| `age` | INT | Exact age |
| `age_group` | VARCHAR | `child`, `teenager`, `adult`, `senior` |
| `country_id` | VARCHAR(2) | ISO code (NG, KE, etc.) |
| `country_name` | VARCHAR | Full country name |
| `country_probability` | FLOAT | Confidence score |
| `created_at` | TIMESTAMP | Auto-generated (UTC ISO 8601) |

### 4. Seed the database

```bash
npm run seed
```

This populates the database with 2026 profiles. Re-running the command will clear and re-insert (no duplicates).

### 5. Start the server

```bash
npm start
```

---

## API Endpoints

### `POST /api/profiles`

Create a new profile by enriching a name via external APIs.

**Request:**
```json
{ "name": "john" }
```

**Response (201):**
```json
{
  "status": "success",
  "data": {
    "id": "019...",
    "name": "john",
    "gender": "male",
    "gender_probability": 0.99,
    "age": 25,
    "age_group": "adult",
    "country_id": "US",
    "country_name": "United States",
    "country_probability": 0.85,
    "created_at": "2026-04-22T10:00:00.000Z"
  }
}
```

---

### `GET /api/profiles`

Retrieve profiles with advanced filtering, sorting, and pagination.

#### Query Parameters

| Parameter | Type | Description | Example |
|---|---|---|---|
| `gender` | string | Filter by gender (`male` or `female`) | `?gender=male` |
| `age_group` | string | Filter by age group (`child`, `teenager`, `adult`, `senior`) | `?age_group=adult` |
| `country_id` | string | Filter by ISO country code | `?country_id=NG` |
| `min_age` | integer | Minimum age (inclusive) | `?min_age=25` |
| `max_age` | integer | Maximum age (inclusive) | `?max_age=40` |
| `min_gender_probability` | float | Minimum gender confidence (0–1) | `?min_gender_probability=0.8` |
| `min_country_probability` | float | Minimum country confidence (0–1) | `?min_country_probability=0.5` |
| `sort_by` | string | Sort field: `age`, `created_at`, `gender_probability` | `?sort_by=age` |
| `order` | string | Sort direction: `asc` or `desc` | `?order=desc` |
| `page` | integer | Page number (default: 1) | `?page=2` |
| `limit` | integer | Results per page (default: 10, max: 50) | `?limit=20` |

All filters can be **combined**. Results match **all** conditions (AND logic).

**Example:** `/api/profiles?gender=male&country_id=NG&min_age=25&sort_by=age&order=desc&page=1&limit=10`

**Response:**
```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 142,
  "data": [ ... ]
}
```

---

### `GET /api/profiles/:id`

Retrieve a single profile by UUID.

**Response (200):**
```json
{
  "status": "success",
  "data": { ... }
}
```

**Response (404):**
```json
{
  "status": "error",
  "message": "Profile not found"
}
```

---

### `GET /api/profiles/search`

Search profiles using **natural language queries**. The system interprets plain English and converts it into database filters. Pagination (`page`, `limit`) also applies to this endpoint.

#### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `q` | string | Natural language query (**required**) |
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Results per page (default: 10, max: 50) |

#### Supported Patterns

| Query Example | Interpreted Filters |
|---|---|
| `"young males"` | gender=male, min_age=16, max_age=24 |
| `"females above 30"` | gender=female, min_age=30 |
| `"people from angola"` | country_id=AO |
| `"adult males from kenya"` | gender=male, age_group=adult, country_id=KE |
| `"male and female teenagers above 17"` | age_group=teenager, min_age=17 |
| `"senior women from nigeria"` | gender=female, age_group=senior, country_id=NG |
| `"children under 10"` | age_group=child, max_age=10 |

#### How the NLP Parser Works

The parser uses a **rule-based approach** (no AI or LLMs):

1. **Gender Detection** — Matches keywords: `male/males/men/man` → male, `female/females/women/woman` → female. If both are present, no gender filter is applied.
2. **Age Group Detection** — Maps keywords to groups: `teenager/teen`, `child/kid`, `adult`, `senior/elderly`
3. **"Young" Keyword** — Special case: maps to age range 16–24 (not a stored age group)
4. **Age Ranges** — Parses patterns like `"above 30"`, `"under 18"`, `"between 20 and 30"`, `"older than 40"`
5. **Country Detection** — Extracts country from `"from <country>"` patterns, maps names to ISO codes using a comprehensive dictionary of 70+ countries
6. **Neutral Words** — Words like `people`, `persons`, `profiles` are recognized as valid but don't generate filters

If no pattern is recognized, the endpoint returns:
```json
{ "status": "error", "message": "Unable to interpret query" }
```

**Example:** `/api/profiles/search?q=young males from nigeria&page=1&limit=10`

**Response:**
```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 9,
  "data": [ ... ]
}
```

---

### `DELETE /api/profiles/:id`

Delete a profile by UUID. Returns `204 No Content` on success.

---

## Error Handling

All errors follow a consistent format:

```json
{ "status": "error", "message": "<error description>" }
```

| HTTP Code | Meaning |
|---|---|
| `400` | Missing or empty parameter |
| `422` | Invalid parameter type or value |
| `404` | Profile not found |
| `500` | Internal server error |
| `502` | Upstream API failure |

---

## CORS

The API includes `Access-Control-Allow-Origin: *` for cross-origin access.

## Deployment

Deploy to any Node.js hosting platform (Railway, Render, Fly.io, etc.) with the required environment variables set in the platform dashboard.