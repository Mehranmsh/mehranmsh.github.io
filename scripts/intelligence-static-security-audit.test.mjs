import test from "node:test";
import assert from "node:assert/strict";
import { buildStaticSecurityAudit, SECURITY_AUDIT_PATHS } from "./intelligence-static-security-audit.mjs";

test("static security audit reports only rule metadata and never matched values", () => {
  const result = buildStaticSecurityAudit([{
    path:"worker.js",
    blobSha:"a".repeat(40),
    content:'const password = "this-is-a-fake-secret-value";\nconst harmless = true;'
  }], "b".repeat(40));
  assert.equal(result.type,"source_security_audit");
  assert.equal(result.summary.findings,1);
  assert.deepEqual(result.findings[0],{
    path:"worker.js",line:1,rule:"hardcoded_password_or_secret",severity:"high"
  });
  assert.equal(JSON.stringify(result).includes("this-is-a-fake-secret-value"),false);
  assert.equal(result.limitations.length,4);
  assert.equal(SECURITY_AUDIT_PATHS.length,6);
});

test("static security audit detects high-confidence token formats", () => {
  const token = "ghp_" + "A".repeat(36);
  const result = buildStaticSecurityAudit([{
    path:"worker.js",blobSha:"c".repeat(40),content:"const token = \"" + token + "\";"
  }], "d".repeat(40));
  assert.equal(result.findings[0].rule,"github_personal_access_token");
  assert.equal(JSON.stringify(result).includes(token),false);
});

test("static security audit rejects arbitrary paths, duplicate sources, invalid commits and size overflow", () => {
  const file = {path:"worker.js",blobSha:"a".repeat(40),content:"safe"};
  assert.throws(()=>buildStaticSecurityAudit([{...file,path:"README.md"}],"b".repeat(40)));
  assert.throws(()=>buildStaticSecurityAudit([file,file],"b".repeat(40)));
  assert.throws(()=>buildStaticSecurityAudit([file],"bad"));
  assert.throws(()=>buildStaticSecurityAudit([{...file,content:"x".repeat(600001)}],"b".repeat(40)));
});
