import test from "node:test";
import assert from "node:assert/strict";
import { filterRepositoryInventoryPaths, getRepositoryModuleKey } from "./intelligence-repository-inventory.mjs";

test("dynamic inventory includes application modules and root entry points", () => {
  const paths = filterRepositoryInventoryPaths([
    "index.html", "worker.js", "social/feed.js", "music-studio/mixer.ts",
    "nexus/catalog.jsx", "src/core/auth.mjs", "engine/render.py"
  ]);
  assert.deepEqual(paths, [
    "engine/render.py", "index.html", "music-studio/mixer.ts", "nexus/catalog.jsx",
    "social/feed.js", "src/core/auth.mjs", "worker.js"
  ]);
});

test("dynamic inventory excludes secrets, private data, workflows, dependencies and generated output", () => {
  const paths = filterRepositoryInventoryPaths([
    "src/app.js", ".env.production", "config/api-secret.json", "wallet/private-key.js",
    "users/user-data.json", "node_modules/pkg/index.js", "dist/app.js",
    ".github/workflows/deploy.yml", "coverage/report.json", "docs/readme.md"
  ]);
  assert.deepEqual(paths, ["src/app.js"]);
});

test("inventory module keys group root files and module directories deterministically", () => {
  assert.equal(getRepositoryModuleKey("index.html"), "root");
  assert.equal(getRepositoryModuleKey("music-studio/mixer.ts"), "music-studio");
});
