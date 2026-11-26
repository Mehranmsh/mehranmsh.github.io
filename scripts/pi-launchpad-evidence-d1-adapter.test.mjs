import test from "node:test";
import assert from "node:assert/strict";
import { buildPiLaunchpadEvidenceD1WritePlan, persistPiLaunchpadEvidenceD1Plan } from "./pi-launchpad-evidence-d1-adapter.mjs";

const record = (overrides={}) => ({
  recordId:"plev_"+"a".repeat(32), networkId:"pi-mainnet",
  assetIdentifier:"asset:issuer:PIEX", evidenceId:"ev-1",
  evidenceType:"official_project_claim", field:"utility", value:75,
  source:{sourceId:"project-site",kind:"official_project",url:"https://project.example/token"},
  observedAt:"2026-11-27T00:00:00.000Z", verificationStatus:"unverified",
  chainVerificationStatus:"not_verified",
  scoringStatus:"blocked_pending_independent_chain_verification",
  createdAt:"2026-11-27T00:01:00.000Z", ...overrides
});

test("builds bounded parameterized insert and readback plans",()=>{
 const p=buildPiLaunchpadEvidenceD1WritePlan([record()]);
 assert.equal(p.accepted,true); assert.equal(p.insertBatch.length,1); assert.equal(p.readback.length,1);
 assert.equal((p.insertBatch[0].sql.match(/\\?/g)||[]).length,p.insertBatch[0].params.length);
 assert.match(p.insertBatch[0].sql,/ON CONFLICT\\(record_id\\) DO NOTHING/);
 assert.match(p.readback[0].sql,/SELECT record_id/);
 assert.equal(p.expectedRows[0][9],"not_verified");
 assert.equal(p.expectedRows[0][10],"blocked_pending_independent_chain_verification");
});

test("rejects attempted promotion of chain verification or scoring",()=>{
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({chainVerificationStatus:"verified"})]).accepted,false);
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({scoringStatus:"eligible"})]).accepted,false);
});

test("rejects invalid network, unsafe source URL, invalid record ID and oversized batch",()=>{
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({networkId:"ethereum"})]).accepted,false);
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({source:{sourceId:"x",kind:"x",url:"http://project.example"}})]).accepted,false);
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({recordId:"bad"})]).accepted,false);
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan(Array(81).fill(record())).accepted,false);
});

test("rejects duplicate IDs inside a single batch",()=>{
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record(),record()]).code,"duplicate_record_id_in_batch");
});

test("serializes values and provenance without accepting objects or non-finite numbers",()=>{
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({value:{x:1}})]).accepted,false);
 assert.equal(buildPiLaunchpadEvidenceD1WritePlan([record({value:Infinity})]).accepted,false);
});

test("executes only parameterized batch and verifies exact readback",async()=>{
 const p=buildPiLaunchpadEvidenceD1WritePlan([record()]);
 let batchCalls=0, firstCalls=0;
 const expected=p.expectedRows[0];
 const row={
  record_id:expected[0],network_id:expected[1],asset_identifier:expected[2],evidence_id:expected[3],
  evidence_type:expected[4],field_name:expected[5],value_json:expected[6],provenance_json:expected[7],
  verification_status:expected[8],chain_verification_status:expected[9],scoring_status:expected[10],
  registry_version:expected[11],created_at:expected[12]
 };
 const db={
  prepare(sql){return {bind(...params){return {sql,params,async first(){firstCalls++;return row;}}};}},
  async batch(items){batchCalls++;assert.equal(items.length,1);return [];}
 };
 const result=await persistPiLaunchpadEvidenceD1Plan(db,p);
 assert.equal(result.accepted,true);assert.equal(result.persisted,true);
 assert.equal(batchCalls,1);assert.equal(firstCalls,1);
});

test("fails closed on readback mismatch and database errors",async()=>{
 const p=buildPiLaunchpadEvidenceD1WritePlan([record()]);
 const mismatchDb={prepare(sql){return {bind(){return {async first(){return {record_id:"different"};}}};}},async batch(){return [];}};
 assert.equal((await persistPiLaunchpadEvidenceD1Plan(mismatchDb,p)).code,"d1_readback_conflict");
 const failedDb={prepare(){throw new Error("secret db detail");},async batch(){throw new Error("failure");}};
 assert.equal((await persistPiLaunchpadEvidenceD1Plan(failedDb,p)).code,"d1_persistence_failed");
});

test("does not persist without an explicit D1 binding and valid plan",async()=>{
 assert.equal((await persistPiLaunchpadEvidenceD1Plan(null,{})).accepted,false);
});
