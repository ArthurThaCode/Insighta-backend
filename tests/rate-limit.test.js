import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";

const require = createRequire(import.meta.url);
const { createTestApp } = require("./helpers/test-app");

describe("rate limit", () => {
  let t;
  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_MAX: "5", RATE_LIMIT_AUTH_MAX: "3", RATE_LIMIT_WINDOW_MS: "1000" });
  });
  afterAll(() => t.close());

  const health = (ip, path = "/health") => request(t.app).get(path).set("X-Forwarded-For", ip);
  const statuses = async (count, send) => {
    const results = [];
    for (let i = 0; i < count; i += 1) results.push((await send()).status);
    return results;
  };

  it("applies RATE_LIMIT_MAX per IP, across routes", async () => {
    const results = await statuses(5, () => health("10.0.0.1"));
    expect(results.every((status) => status === 200)).toBe(true);

    const limited = await health("10.0.0.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await health("10.0.0.1", "/another-route")).status).toBe(429);
  });

  it("does not limit other clients", async () => {
    await statuses(6, () => health("10.0.0.2"));
    expect((await health("10.0.0.3")).status).toBe(200);
  });

  it("ignores client-supplied X-Forwarded-For entries", async () => {
    await statuses(6, () => health("10.0.0.4"));
    expect((await health("1.2.3.4, 10.0.0.4")).status).toBe(429);
  });

  it("applies the stricter limit to /auth routes", async () => {
    const send = () => request(t.app).post("/auth/refresh").set("X-Forwarded-For", "10.0.0.5");
    expect(await statuses(4, send)).toEqual([400, 400, 400, 429]);
    expect((await health("10.0.0.5")).status).toBe(200);
  });

  it("resets after RATE_LIMIT_WINDOW_MS", async () => {
    await statuses(6, () => health("10.0.0.6"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await health("10.0.0.6")).status).toBe(200);
  });
});
