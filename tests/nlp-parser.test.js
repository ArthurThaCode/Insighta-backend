import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { parseNaturalLanguageQuery: parse } = require("../src/services/nlpParser");

describe("natural language parser", () => {
  it.each([
    ["young males", { gender: "male", min_age: 16, max_age: 24 }],
    ["females above 30", { gender: "female", min_age: 30 }],
    ["people from angola", { country_id: "AO" }],
    ["adult males from kenya", { gender: "male", age_group: "adult", country_id: "KE" }],
    ["male and female teenagers above 17", { age_group: "teenager", min_age: 17 }],
    ["young males from nigeria", { gender: "male", min_age: 16, max_age: 24, country_id: "NG" }],
    ["under 18", { max_age: 18 }],
    ["between 20 and 30", { min_age: 20, max_age: 30 }],
    ["women in kenya", { gender: "female", country_id: "KE" }],
    ["all profiles", {}],
  ])("parses %s", (query, filters) => {
    expect(parse(query)).toEqual({ filters });
  });

  it.each(["", "   ", "hello", "xyzzy plugh", "people from atlantis", "males in narnia"])("cannot interpret %j", (query) => {
    expect(parse(query)).toEqual({ error: "Unable to interpret query" });
  });

  it("reports a contradictory age range as a 422", () => {
    expect(parse("young males above 30")).toEqual({ error: "Invalid query parameters", status: 422 });
    expect(parse("between 30 and 20")).toEqual({ error: "Invalid query parameters", status: 422 });
  });
});
