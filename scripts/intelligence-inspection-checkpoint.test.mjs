import test from "node:test";
import assert from "node:assert/strict";
import {
  INSPECTION_PATHS, createInspectionProgressCheckpoint, verifyInspectionProgressCheckpoint
} from "./intelligence-inspection-checkpoint.mjs";

const identity = {taskId:"inspect-001",baseSha:"a".repeat(40)};
const entry = (path) => ({path,blobSha:"b".repeat(40),bytes:120,lineCount:4,symbols:["runTask"]});

test("creates and verifies ordered immutable inspection progress",()=>{
  const saved=createInspectionProgressCheckpoint({...identity,completedFiles:INSPECTION_PATHS.slice(0,2).map(entry)});
  assert.equal(saved.phase,"file_progress");
  assert.deepEqual(verifyInspectionProgressCheckpoint(saved,identity),{
    valid:true,baseSha:identity.baseSha,completedFiles:INSPECTION_PATHS.slice(0,2).map(entry)
  });
});

test("rejects task, commit, order, path and digest tampering",()=>{
  const saved=createInspectionProgressCheckpoint({...identity,completedFiles:[entry(INSPECTION_PATHS[0])]});
  assert.equal(verifyInspectionProgressCheckpoint(saved,{...identity,taskId:"other"}).reason,"task_identity_mismatch");
  assert.equal(verifyInspectionProgressCheckpoint(saved,{...identity,baseSha:"c".repeat(40)}).reason,"task_identity_mismatch");
  const tampered={...saved,completedFiles:[entry(INSPECTION_PATHS[1])]};
  assert.equal(verifyInspectionProgressCheckpoint(tampered,identity).reason,"invalid_completed_files");
  assert.equal(verifyInspectionProgressCheckpoint({...saved,digestSha256:"0".repeat(64)},identity).reason,"digest_mismatch");
});

test("rejects unknown fields and oversized or malformed evidence",()=>{
  const saved=createInspectionProgressCheckpoint({...identity,completedFiles:[]});
  assert.equal(verifyInspectionProgressCheckpoint({...saved,extra:"x"},identity).reason,"unexpected_checkpoint_fields");
  assert.throws(()=>createInspectionProgressCheckpoint({...identity,completedFiles:[{...entry(INSPECTION_PATHS[0]),bytes:700000}]}));
  assert.throws(()=>createInspectionProgressCheckpoint({...identity,completedFiles:[entry(INSPECTION_PATHS[1])]}));
});
