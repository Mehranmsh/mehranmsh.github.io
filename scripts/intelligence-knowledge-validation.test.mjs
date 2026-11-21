import test from "node:test";
import assert from "node:assert/strict";
import {
  handleProductionIntelligenceKnowledgeApi
} from "../intelligence-production-knowledge-api.mjs";

function fakeEnv() {
  const batches = [];
  const DB = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; }
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    }
  };
  return { env: { DB }, batches };
}

async function post(path, body) {
  const { env, batches } = fakeEnv();
  const request = new Request("https://example.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const response = await handleProductionIntelligenceKnowledgeApi({
    request,
    env,
    admin: { uid: "owner-uid", username: "mehranmsh" },
    url: new URL(request.url),
    path,
    method: "POST"
  });
  return { response, batches };
}

test("knowledge rejects non-string and overlong categories before database writes", async () => {
  for (const category of [{ forged: true }, 7, false, "x".repeat(41)]) {
    const { response, batches } = await post("/intelligence/knowledge", {
      title: "Valid title",
      content: "Valid content",
      category
    });
    assert.equal(response.status, 400);
    assert.equal(batches.length, 0);
  }
});

test("knowledge accepts a valid category and writes an audit batch", async () => {
  const { response, batches } = await post("/intelligence/knowledge", {
    title: "Valid title",
    content: "Valid content",
    category: "company"
  });
  assert.equal(response.status, 201);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test("memory rejects non-string and overlong categories before database writes", async () => {
  for (const category of [{ forged: true }, 7, false, "x".repeat(41)]) {
    const { response, batches } = await post("/intelligence/memory", {
      content: "Valid memory",
      category
    });
    assert.equal(response.status, 400);
    assert.equal(batches.length, 0);
  }
});

test("memory accepts a valid category and writes an audit batch", async () => {
  const { response, batches } = await post("/intelligence/memory", {
    content: "Valid memory",
    category: "general"
  });
  assert.equal(response.status, 201);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});
