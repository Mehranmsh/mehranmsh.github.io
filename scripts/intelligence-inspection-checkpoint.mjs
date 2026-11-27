import { createHash } from "node:crypto";

export const INSPECTION_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "scripts/intelligence-capabilities.test.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);

function canonical(value) {
  return JSON.stringify({
    schemaVersion: 1, phase: "file_progress", taskId: value.taskId,
    actionType: value.actionType, baseSha: value.baseSha,
    completedFiles: value.completedFiles
  });
}

function validEntry(file, expectedPath) {
  return !!file && file.path === expectedPath &&
    typeof file.blobSha === "string" && /^[a-f0-9]{40}$/i.test(file.blobSha) &&
    Number.isInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 600000 &&
    Number.isInteger(file.lineCount) && file.lineCount >= 0 && file.lineCount <= 20000 &&
    Array.isArray(file.symbols) && file.symbols.length <= 2 &&
    file.symbols.every(symbol => typeof symbol === "string" && symbol.length <= 60);
}

export function createInspectionProgressCheckpoint({taskId, baseSha, completedFiles}) {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(taskId)) throw new Error("Invalid inspection task identity.");
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error("Invalid immutable inspection commit.");
  if (!Array.isArray(completedFiles) || completedFiles.length > INSPECTION_PATHS.length ||
      completedFiles.some((file, index) => !validEntry(file, INSPECTION_PATHS[index]))) {
    throw new Error("Inspection progress must be a verified ordered prefix of the fixed path plan.");
  }
  const value = {taskId, actionType:"inspect_repository", baseSha, completedFiles:completedFiles.map(file=>({...file,symbols:[...file.symbols]}))};
  const payload = canonical(value);
  return {...JSON.parse(payload), digestSha256:createHash("sha256").update(payload).digest("hex")};
}

export function verifyInspectionProgressCheckpoint(checkpoint, expected) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return {valid:false,reason:"invalid_checkpoint"};
  const keys = ["actionType","baseSha","completedFiles","digestSha256","phase","schemaVersion","taskId"];
  const actual = Object.keys(checkpoint).sort();
  if (actual.length !== keys.length || actual.some((key,index)=>key!==keys[index])) return {valid:false,reason:"unexpected_checkpoint_fields"};
  if (checkpoint.phase !== "file_progress" || checkpoint.schemaVersion !== 1) return {valid:false,reason:"unsupported_checkpoint_schema"};
  if (!expected || checkpoint.taskId !== expected.taskId || checkpoint.actionType !== "inspect_repository" ||
      (expected.baseSha && checkpoint.baseSha !== expected.baseSha)) return {valid:false,reason:"task_identity_mismatch"};
  let rebuilt;
  try { rebuilt = createInspectionProgressCheckpoint(checkpoint); }
  catch { return {valid:false,reason:"invalid_completed_files"}; }
  if (checkpoint.digestSha256 !== rebuilt.digestSha256) return {valid:false,reason:"digest_mismatch"};
  return {valid:true,baseSha:rebuilt.baseSha,completedFiles:rebuilt.completedFiles};
}
