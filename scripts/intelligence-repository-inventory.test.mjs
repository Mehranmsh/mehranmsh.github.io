import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryInventory, INTELLIGENCE_INVENTORY_PATHS } from "./intelligence-repository-inventory.mjs";

test("deterministic repository inventory is AI-independent and evidence bounded", () => {
  const file = { path:"scripts/intelligence-agent.mjs", blobSha:"a".repeat(40), content:"export function alpha() {}\nexport const beta = 1;\n" };
  const result = buildRepositoryInventory([file],"b".repeat(40));
  assert.equal(result.mode,"bounded_read_only_repository_inspection");
  assert.equal(result.files[0].lineCount,3);
  assert.deepEqual(result.files[0].symbols,["alpha","beta"]);
  assert.equal(result.analysis.findings.length,0);
  assert.equal(INTELLIGENCE_INVENTORY_PATHS.length,6);
});
test("repository inventory rejects paths, duplicate files, invalid commits and oversized content", () => {
  const file = {path:"worker.js",blobSha:"a".repeat(40),content:"x"};
  assert.throws(()=>buildRepositoryInventory([{...file,path:"README.md"}],"b".repeat(40)));
  assert.throws(()=>buildRepositoryInventory([file,file],"b".repeat(40)));
  assert.throws(()=>buildRepositoryInventory([file],"bad"));
  assert.throws(()=>buildRepositoryInventory([{...file,content:"x".repeat(600001)}],"b".repeat(40)));
});
