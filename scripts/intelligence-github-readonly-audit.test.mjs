import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runReadOnlyAudit, verifyReadOnlyGitHubSnapshot } from "./intelligence-github-readonly-audit.mjs";

const repository = "Mehranmsh/mehranmsh.github.io";
const baseSha = "a".repeat(40), headSha = "b".repeat(40);
const baseTreeSha = "c".repeat(40), headTreeSha = "d".repeat(40);
const path = "docs/approved.md", content = Buffer.from("# approved\n");
const blobSha = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\0`),content])).digest("hex");
function fixture() {
  const baseCommit={repository,sha:baseSha,treeSha:baseTreeSha,parents:["9".repeat(40)]};
  const headCommit={repository,sha:headSha,treeSha:headTreeSha,parents:[baseSha]};
  const baseTree={sha:baseTreeSha,truncated:false,tree:[]};
  const headTree={sha:headTreeSha,truncated:false,tree:[{path,mode:"100644",type:"blob",sha:blobSha,size:content.length}]};
  const comparison={too_large:false,base_commit:{sha:baseSha},merge_base_commit:{sha:baseSha},commits:[{sha:headSha}],files:[{filename:path,status:"added"}]};
  const input={repository,baseCommit,headCommit,baseTree,headTree,comparison,allowedPaths:new Set([path]),fetchBlob:async()=>({bytes:content})};
  return {input};
}
test("accepts a complete read-only tree and compare snapshot with byte-verified blob",async()=>{
 const {input}=fixture();const r=await verifyReadOnlyGitHubSnapshot(input);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.changedFiles.length,1);
});
test("rejects a truncated tree",async()=>{const {input}=fixture();input.headTree.truncated=true;assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects mismatched compare file list",async()=>{const {input}=fixture();input.comparison.files=[];assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects undeclared extra paths",async()=>{const {input}=fixture();input.allowedPaths=new Set(["docs/other.md"]);assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects deleted files",async()=>{const {input}=fixture();input.baseTree.tree=[{path,mode:"100644",type:"blob",sha:blobSha,size:content.length}];input.headTree.tree=[];input.comparison.files=[{filename:path,status:"removed"}];assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects symlink and executable file modes",async()=>{for(const mode of ["120000","100755"]){const {input}=fixture();input.headTree.tree[0].mode=mode;assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);}});
test("rejects blob byte mismatch",async()=>{const {input}=fixture();input.fetchBlob=async()=>({bytes:Buffer.from("tampered")});assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects repository mismatch and incorrect merge-base binding",async()=>{const {input}=fixture();input.headCommit.repository="other/repo";assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);const f=fixture();f.input.comparison.merge_base_commit.sha="8".repeat(40);assert.equal((await verifyReadOnlyGitHubSnapshot(f.input)).ok,false);});
test("rejects oversized or missing comparison response",async()=>{const {input}=fixture();input.comparison.too_large=true;assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});
test("rejects duplicate tree paths",async()=>{const {input}=fixture();input.headTree.tree.push({...input.headTree.tree[0]});assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);});

test("rejects comparison responses bound to different base or head commits",async()=>{for(const field of ["base_commit","commits"]){const {input}=fixture();if(field==="base_commit")input.comparison.base_commit.sha="8".repeat(40);else input.comparison.commits[0].sha="8".repeat(40);assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);}});

test("HTTP adapter performs only authenticated GET requests and verifies real API-shaped responses",async()=>{
 const baseSha="1".repeat(40),headSha="2".repeat(40),baseTreeSha="3".repeat(40),headTreeSha="4".repeat(40);
 const filePath="docs/approved.md",bytes=Buffer.from("# live audit\n");
 const sha=createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest("hex");
 const requests=[];
 const responses=new Map([
  [`/repos/${repository}/commits/${baseSha}`,{sha:baseSha,parents:[{sha:"9".repeat(40)}],commit:{tree:{sha:baseTreeSha}}}],
  [`/repos/${repository}/commits/${headSha}`,{sha:headSha,parents:[{sha:baseSha}],commit:{tree:{sha:headTreeSha}}}],
  [`/repos/${repository}/git/trees/${baseTreeSha}`,{sha:baseTreeSha,truncated:false,tree:[]}],
  [`/repos/${repository}/git/trees/${headTreeSha}`,{sha:headTreeSha,truncated:false,tree:[{path:filePath,mode:"100644",type:"blob",sha,size:bytes.length}]}],
  [`/repos/${repository}/compare/${baseSha}...${headSha}`,{too_large:false,base_commit:{sha:baseSha},merge_base_commit:{sha:baseSha},commits:[{sha:headSha}],files:[{filename:filePath,status:"added"}]}],
  [`/repos/${repository}/git/blobs/${sha}`,{encoding:"base64",content:bytes.toString("base64")}]
 ]);
 const fakeFetch=async(url,options)=>{
  requests.push({url:String(url),method:options.method,redirect:options.redirect,hasTimeout:Boolean(options.signal),authorization:options.headers.Authorization});
  const pathname=new URL(url).pathname;
  const key=pathname;
  if(!responses.has(key))return new Response("not found",{status:404,headers:{"content-type":"application/json"}});
  return new Response(JSON.stringify(responses.get(key)),{status:200,headers:{"content-type":"application/json; charset=utf-8"}});
 };
 const result=await runReadOnlyAudit({
  GITHUB_REPOSITORY:repository,GITHUB_TOKEN:"test-token",
  MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha
 },fakeFetch,new Set([filePath]));
 assert.equal(result.changedFiles.length,1);
 assert.equal(requests.length,6);
 assert.ok(requests.every(r=>r.method==="GET"));
 assert.ok(requests.every(r=>r.redirect==="error" && r.hasTimeout));
 assert.ok(requests.every(r=>r.authorization==="Bearer test-token"));
});
test("HTTP adapter refuses to start without a token or immutable SHAs",async()=>{
 await assert.rejects(()=>runReadOnlyAudit({GITHUB_REPOSITORY:repository,MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha},async()=>{}),/Missing, untrusted, or malformed/);
});

test("HTTP adapter rejects a different repository before making a request", async () => {
 let calls=0;
 await assert.rejects(()=>runReadOnlyAudit({
  GITHUB_REPOSITORY:"attacker/other",GITHUB_TOKEN:"test-token",
  MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha
 },async()=>{calls++;}),/Missing, untrusted, or malformed/);
 assert.equal(calls,0);
});
test("HTTP adapter rejects redirects and non-JSON responses", async () => {
 const env={GITHUB_REPOSITORY:repository,GITHUB_TOKEN:"test-token",MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha};
 await assert.rejects(()=>runReadOnlyAudit(env,async(_url,options)=>{
  assert.equal(options.redirect,"error");
  throw new TypeError("redirect blocked");
 }),/redirect blocked/);
 await assert.rejects(()=>runReadOnlyAudit(env,async()=>new Response("<html>no</html>",{headers:{"content-type":"text/html"}})),/unexpected content type/);
});
test("HTTP adapter rejects invalid JSON and oversized API bodies", async () => {
 const env={GITHUB_REPOSITORY:repository,GITHUB_TOKEN:"test-token",MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha};
 await assert.rejects(()=>runReadOnlyAudit(env,async()=>new Response("{bad json",{headers:{"content-type":"application/json"}})),/invalid JSON/);
 const huge="x".repeat(2*1024*1024+1);
 await assert.rejects(()=>runReadOnlyAudit(env,async()=>new Response(huge,{headers:{"content-type":"application/json"}})),/size limit/);
});
test("HTTP adapter rejects malformed commit response before dereferencing tree fields", async () => {
 const env={GITHUB_REPOSITORY:repository,GITHUB_TOKEN:"test-token",MEHRAN_AUDIT_BASE_SHA:baseSha,GITHUB_SHA:headSha};
 await assert.rejects(()=>runReadOnlyAudit(env,async()=>new Response(JSON.stringify({sha:baseSha,parents:[],commit:{}}),{headers:{"content-type":"application/json"}})),/malformed base commit/);
});

test("rejects an audit head without parent metadata", async () => {
 const {input}=fixture();
 input.headCommit.parents=[];
 assert.equal((await verifyReadOnlyGitHubSnapshot(input)).ok,false);
});
