import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { createTestApp } = require("./helpers/test-app");

describe("profiles API", () => {
  let t, analyst, admin;
  beforeAll(async () => {
    t = await createTestApp();
    analyst = t.addUser("analyst-user", "analyst");
    admin = t.addUser("admin-user", "admin");
  });
  afterAll(() => t.close());

  const as = (token, method, path) => t.api(method, path).set("Authorization", `Bearer ${token}`);

  describe("RBAC", () => {
    it("lets an analyst read, search, and export", async () => {
      expect((await as(analyst, "get", "/api/v1/profiles")).status).toBe(200);
      expect((await as(analyst, "get", `/api/v1/profiles/${t.db.profiles[0].id}`)).status).toBe(200);
      expect((await as(analyst, "get", "/api/v1/profiles/search?q=males")).status).toBe(200);
      expect((await as(analyst, "get", "/api/v1/profiles/export")).status).toBe(200);
    });

    it("forbids an analyst from creating or deleting", async () => {
      const id = t.db.profiles[0].id;
      expect((await as(analyst, "post", "/api/v1/profiles").send({ name: "Blocked" })).status).toBe(403);
      expect((await as(analyst, "delete", `/api/v1/profiles/${id}`)).status).toBe(403);
      expect(t.db.profiles.some((profile) => profile.id === id)).toBe(true);
      expect(t.db.profiles.some((profile) => profile.name === "Blocked")).toBe(false);
    });

    it("lets an admin create and delete", async () => {
      const created = await as(admin, "post", "/api/v1/profiles").send({ name: "Ada" });
      expect(created.status).toBe(201);
      expect(created.body.data.age_group).toBe("adult");

      const again = await as(admin, "post", "/api/v1/profiles").send({ name: "Ada" });
      expect(again.status).toBe(200);
      expect(again.body.message).toBe("Profile already exists");

      expect((await as(admin, "delete", `/api/v1/profiles/${created.body.data.id}`)).status).toBe(204);
      expect(t.db.profiles.some((profile) => profile.id === created.body.data.id)).toBe(false);
    });

    it("uses the role stored in the database, not the one in the token", async () => {
      const { signToken } = require("./helpers/test-app");
      const token = signToken({ sub: "analyst-user", role: "admin" });
      expect((await as(token, "post", "/api/v1/profiles").send({ name: "Escalated" })).status).toBe(403);
    });

    it("returns 404 when deleting an unknown profile", async () => {
      expect((await as(admin, "delete", "/api/v1/profiles/does-not-exist")).status).toBe(404);
    });

    it("also protects the /api compatibility mount", async () => {
      expect((await t.api("get", "/api/profiles")).status).toBe(401);
      expect((await as(analyst, "get", "/api/profiles")).status).toBe(200);
    });
  });

  describe("listing", () => {
    it("returns the documented pagination shape", async () => {
      const { body } = await as(analyst, "get", "/api/v1/profiles?page=2&limit=5");
      expect(Object.keys(body).sort()).toEqual(["data", "limit", "links", "page", "status", "total", "total_pages"]);
      expect(body.data).toHaveLength(5);
      expect(body.total_pages).toBe(Math.ceil(body.total / 5));
      expect(body.links.next).toBe("/api/v1/profiles?page=3&limit=5");
      expect(body.links.prev).toBe("/api/v1/profiles?page=1&limit=5");
    });

    it("combines filters and sorts", async () => {
      const filtered = await as(analyst, "get", "/api/v1/profiles?gender=male&country_id=NG&min_age=25");
      expect(filtered.body.total).toBeGreaterThan(0);
      expect(filtered.body.data.every((p) => p.gender === "male" && p.country_id === "NG" && p.age >= 25)).toBe(true);

      const sorted = await as(analyst, "get", "/api/v1/profiles?sort_by=age&order=desc&limit=3");
      const ages = sorted.body.data.map((p) => p.age);
      expect(ages).toEqual([...ages].sort((a, b) => b - a));
    });

    it.each([
      ["limit=51", 422],
      ["gender=", 400],
      ["gender=robot", 422],
      ["min_age=abc", 422],
      ["sort_by=name", 422],
    ])("rejects %s with %i", async (query, status) => {
      expect((await as(analyst, "get", `/api/v1/profiles?${query}`)).status).toBe(status);
    });

    it("exports filtered and sorted CSV", async () => {
      const response = await as(analyst, "get", "/api/v1/profiles/export?gender=male&country_id=NG&sort_by=age&order=desc");
      const [header, ...rows] = response.text.split("\n");
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(header.startsWith("id,name,gender")).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.includes(",male,") && row.includes(",NG,"))).toBe(true);
    });
  });

  describe("search", () => {
    it("applies the parsed filters", async () => {
      const { body } = await as(analyst, "get", `/api/v1/profiles/search?q=${encodeURIComponent("young males from nigeria")}`);
      expect(body.total).toBeGreaterThan(0);
      expect(body.data.every((p) => p.gender === "male" && p.country_id === "NG" && p.age >= 16 && p.age <= 24)).toBe(true);
    });

    it.each([
      ["people from atlantis", 400],
      ["xyzzy plugh", 400],
      ["young males above 30", 422],
    ])("answers %s with %i", async (q, status) => {
      expect((await as(analyst, "get", `/api/v1/profiles/search?q=${encodeURIComponent(q)}`)).status).toBe(status);
    });

    it("refuses a limit above 50", async () => {
      expect((await as(analyst, "get", "/api/v1/profiles/search?q=males&limit=51")).status).toBe(422);
      expect((await as(analyst, "get", "/api/v1/profiles/search?q=males&limit=50")).status).toBe(200);
    });
  });
});
