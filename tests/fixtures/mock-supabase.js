// Minimal in-memory PostgREST imitation, enough for @supabase/supabase-js as used by Insighta.
const http = require("http");

function makeProfiles() {
  const rows = [];
  const countries = [["NG", "Nigeria"], ["KE", "Kenya"], ["AO", "Angola"], ["GA", "Gabon"]];
  for (let i = 0; i < 60; i++) {
    const age = 10 + i;
    const [cid, cname] = countries[i % 4];
    rows.push({
      id: `019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      name: `person${i}`,
      gender: i % 2 ? "female" : "male",
      gender_probability: 0.5 + (i % 50) / 100,
      age,
      age_group: age <= 12 ? "child" : age <= 19 ? "teenager" : age <= 59 ? "adult" : "senior",
      country_id: cid,
      country_name: cname,
      country_probability: 0.3 + (i % 60) / 100,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
  return rows;
}

function parseInList(val) {
  return val.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^,]+/g).map((v) => v.replace(/^"|"$/g, ""));
}

function start(port) {
  const db = { profiles: makeProfiles(), users: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const table = url.pathname.split("/").pop();
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { "Content-Type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (!db[table]) return send(404, { message: "no table" });
      const rows = db[table];
      const reserved = new Set(["select", "order", "offset", "limit", "columns", "on_conflict"]);
      const match = (r) => {
        for (const [k, v] of url.searchParams) {
          if (reserved.has(k)) continue;
          const i = v.indexOf(".");
          const op = v.slice(0, i), val = v.slice(i + 1);
          if (op === "eq" && String(r[k]) !== val) return false;
          if (op === "neq" && String(r[k]) === val) return false;
          if (op === "ilike" && String(r[k]).toLowerCase() !== val.toLowerCase()) return false;
          if (op === "gte" && !(Number(r[k]) >= Number(val))) return false;
          if (op === "lte" && !(Number(r[k]) <= Number(val))) return false;
          if (op === "in" && !parseInList(val).includes(String(r[k]))) return false;
        }
        return true;
      };
      const single = (req.headers.accept || "").includes("vnd.pgrst.object");
      const prefer = req.headers.prefer || "";
      const reply = (out, code = 200) => {
        if (single) {
          if (out.length !== 1) return send(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "", hint: null });
          return send(code, out[0]);
        }
        return send(code, out);
      };
      if (req.method === "GET" || req.method === "HEAD") {
        let out = rows.filter(match);
        const total = out.length;
        const order = url.searchParams.get("order");
        if (order) {
          const [f, dir] = order.split(".");
          out = [...out].sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === "desc" ? -1 : 1));
        }
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = url.searchParams.get("limit");
        if (limit) out = out.slice(offset, offset + Number(limit));
        const headers = prefer.includes("count=exact") ? { "Content-Range": `0-${Math.max(out.length - 1, 0)}/${total}` } : {};
        if (req.method === "HEAD") { res.writeHead(200, headers); return res.end(); }
        if (single) return reply(out);
        return send(200, out, headers);
      }
      if (req.method === "POST") {
        const incoming = [].concat(JSON.parse(raw || "[]"));
        const conflict = url.searchParams.get("on_conflict");
        const saved = [];
        for (const row of incoming) {
          const ex = conflict && db[table].find((r) => r[conflict] === row[conflict]);
          if (ex) { Object.assign(ex, row); saved.push(ex); } else { db[table].push(row); saved.push(row); }
        }
        return reply(saved, 201);
      }
      if (req.method === "PATCH") {
        const patch = JSON.parse(raw || "{}");
        const out = rows.filter(match);
        out.forEach((r) => Object.assign(r, patch));
        return reply(out);
      }
      if (req.method === "DELETE") {
        const removed = rows.filter(match);
        db[table] = rows.filter((r) => !match(r));
        if (prefer.includes("return=representation")) return send(200, removed);
        return send(204, undefined);
      }
      send(405, { message: "nope" });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, db })));
}

module.exports = { start };
