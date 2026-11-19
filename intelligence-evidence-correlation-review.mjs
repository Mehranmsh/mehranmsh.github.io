const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export const EVIDENCE_CORRELATION_REVIEW_OUTCOMES = Object.freeze(["related","unrelated","needs_more_info"]);
export const EVIDENCE_CORRELATION_TYPES = Object.freeze([
 "shared_digest","shared_source_reference","source_reference_digest_variance_candidate"
]);

export function buildEvidenceCorrelationReviewSnapshot(references) {
 if(!Array.isArray(references)||references.length<2||references.length>20) {
  throw new RangeError("Correlation review snapshot must contain 2 to 20 references.");
 }
 const seen=new Set();
 const items=references.map(item=>{
  if(!item||typeof item.evidenceId!=="string"||!UUID.test(item.evidenceId)||
     typeof item.findingId!=="string"||!UUID.test(item.findingId)) {
   throw new TypeError("Correlation review reference identity is invalid.");
  }
  if(seen.has(item.evidenceId))throw new TypeError("Correlation review snapshot contains duplicate evidence IDs.");
  seen.add(item.evidenceId);
  const digest=item.contentDigest==null?null:String(item.contentDigest);
  if(digest!==null&&!SHA256.test(digest))throw new TypeError("Correlation review digest metadata is invalid.");
  const sourceRef=String(item.sourceRef||"");
  if(!sourceRef||sourceRef.length>200||/[\u0000-\u001f\u007f]/.test(sourceRef)) {
   throw new TypeError("Correlation review source reference metadata is invalid.");
  }
  return {
   evidenceId:item.evidenceId,
   findingId:item.findingId,
   moduleId:String(item.moduleId||""),
   checkId:String(item.checkId||""),
   kind:String(item.kind||"other"),
   sourceRef,
   contentDigest:digest
  };
 }).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
 return {references:items,snapshotJson:JSON.stringify(items),referenceCount:items.length};
}

export function buildEvidenceCorrelationReviewHistory(rows) {
 if(!Array.isArray(rows))throw new TypeError("Correlation review history must be an array.");
 return {
  items:rows.map(row=>({
   id:row.id,
   correlationType:row.correlation_type,
   correlationKeySha256:row.correlation_key_sha256,
   outcome:row.outcome,
   reason:row.reason,
   reviewerUid:row.reviewer_uid,
   reviewedAt:Number(row.reviewed_at),
   referenceCount:Number(row.reference_count),
   snapshotSha256:row.correlation_snapshot_sha256,
   snapshot:JSON.parse(row.correlation_snapshot_json)
  })),
  historyIsAppendOnly:true,
  evidenceContentVerified:false,
  relationshipFactVerified:false,
  checkPassed:false,
  executionEnabled:false,
  operationPerformed:false
 };
}
