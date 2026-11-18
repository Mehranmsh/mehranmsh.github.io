import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyReadOnlyGitHubSnapshot } from "./intelligence-github-readonly-audit.mjs";

const repository = "owner/repo";
const baseSha = "a".repeat(40), headSha = "b".repeat(40);
const baseTreeSha = "c".repeat(40), headTreeSha = "d".repeat(40);
const path = "docs/approved.md", content = Buffer.from("# approved\n");
const blobSha = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\\0`),content])).digest("hex");
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
 const {input}=fixture();const r=await verifyReadOnlyGitHubSnapshot(input);assert.equal(r.ok,true);assert.equal(r.changedFiles.length,1);
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
