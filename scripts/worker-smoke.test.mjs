import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const workerModule = await import(
  "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64")
);
const worker = workerModule.default;

function mockDb() {
  return {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes("SELECT 1 AS test")) return { test: 1 };
          throw new Error("Unexpected SQL in smoke test: " + sql);
        }
      };
    }
  };
}

async function request(path, { method = "GET", origin, headers = {}, body } = {}, env = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

test("health endpoint reports online and confirms the database binding", async () => {
  const response = await request("/health", {}, { DB: mockDb() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  const payload = await response.json();
  assert.equal(payload.status, "online");
  assert.equal(payload.database, true);
});

test("health endpoint remains diagnostic when database binding is absent", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.database, false);
});

test("foreign browser origins are rejected before route handling", async () => {
  const response = await request("/health", { origin: "https://attacker.example" });
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden");
});

test("allowed CORS preflight returns the expected methods and headers", async () => {
  const response = await request("/health", {
    method: "OPTIONS",
    origin: "https://mehranmsh.github.io"
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("database-backed routes fail closed when the DB binding is missing", async () => {
  for (const path of ["/projects", "/social/profile", "/admin/overview"]) {
    const response = await request(path);
    assert.equal(response.status, 503, path + " should return 503 without DB");
    const payload = await response.json();
    assert.match(payload.error, /Database binding is missing/);
  }
});

test("unknown routes return a structured 404 response", async () => {
  const response = await request("/this-route-does-not-exist");
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.success, false);
});
