const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256=/^[0-9a-f]{64}$/;
function normalize(rows){
 if(!Array.isArray(rows)||rows.length>501)throw new RangeError("Consistency input must contain at most 501 rows.");
 return rows.map(row=>{
  if(!row||typeof row.id!=="string"||!UUID.test(row.id)||typeof row.finding_id!=="string"||!UUID.test(row.finding_id))throw new TypeError("Evidence and finding identities must be valid UUIDs.");
  const sourceRef=typeof row.source_ref==="string"?row.source_ref:"";
  if(!sourceRef||sourceRef.length>200||/[\u0000-\u001f\u007f]/.test(sourceRef))throw new TypeError("Evidence source reference metadata is invalid.");
  const digest=row.content_digest==null?null:String(row.content_digest);
  if(digest!==null&&!SHA256.test(digest))throw new TypeError("Evidence digest metadata is invalid.");
  return {evidenceId:row.id,findingId:row.finding_id,moduleId:String(row.module_id||""),checkId:String(row.check_id||""),kind:String(row.kind||"other"),sourceRef,contentDigest:digest};
 }).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
}
function collect(rows,keyOf,type,maxGroups){
 const map=new Map();
 for(const row of rows){const key=keyOf(row);if(!map.has(key))map.set(key,[]);map.get(key).push(row);}
 const out=[];
 for(const [key,references] of map){if(references.length<2)continue;out.push({candidateType:type,candidateKey:key,findingCount:new Set(references.map(x=>x.findingId)).size,referenceCount:references.length,referencesTruncated:references.length>20,references:references.slice(0,20)});}
 out.sort((a,b)=>a.candidateType.localeCompare(b.candidateType)||b.findingCount-a.findingCount||a.candidateKey.localeCompare(b.candidateKey));
 return out.slice(0,maxGroups);
}
export function buildEvidenceConsistency(inputRows,options={}){
 if(!Array.isArray(inputRows))throw new TypeError("Consistency input must be an array.");
 const maxRows=Number.isSafeInteger(options.maxRows)?options.maxRows:500,maxGroups=Number.isSafeInteger(options.maxGroups)?options.maxGroups:50;
 if(maxRows<1||maxRows>500||maxGroups<1||maxGroups>100)throw new RangeError("Consistency bounds are outside the supported range.");
 const scanLimitReached=inputRows.length>maxRows,rows=normalize(inputRows.slice(0,maxRows));
 const source=collect(rows,row=>row.sourceRef,"source_reference_digest_variance_candidate",maxGroups).filter(g=>new Set(g.references.map(x=>x.contentDigest).filter(Boolean)).size>1);
 const digest=collect(rows.filter(x=>x.contentDigest),row=>row.contentDigest,"digest_reused_across_source_references",maxGroups).filter(g=>new Set(g.references.map(x=>x.sourceRef)).size>1);
 const local=collect(rows,row=>row.findingId+"\u0000"+row.sourceRef,"within_finding_source_digest_variance",maxGroups).filter(g=>new Set(g.references.map(x=>x.contentDigest).filter(Boolean)).size>1);
 const all=[...source,...digest,...local].sort((a,b)=>a.candidateType.localeCompare(b.candidateType)||b.findingCount-a.findingCount||a.candidateKey.localeCompare(b.candidateKey));
 const missing=rows.filter(x=>x.contentDigest===null).map(x=>({evidenceId:x.evidenceId,findingId:x.findingId,moduleId:x.moduleId,checkId:x.checkId,sourceRef:x.sourceRef}));
 return {scanLimit:maxRows,evidenceReferencesScanned:rows.length,evidenceReferenceScanLimitReached:scanLimitReached,coverageComplete:!scanLimitReached,candidateGroupLimit:maxGroups,totalCandidateGroups:source.length+digest.length+local.length,returnedCandidates:all.slice(0,maxGroups),candidatesTruncated:source.length+digest.length+local.length>maxGroups,missingDigestCount:missing.length,missingDigestReferences:missing.slice(0,100),missingDigestReferencesTruncated:missing.length>100,assessment:"stored_evidence_metadata_consistency_candidates_only",isConflictVerdict:false,isContradictionVerdict:false,evidenceContentVerified:false,sourceReachabilityChecked:false,authenticityVerified:false,correctnessVerified:false,checkPassed:false,executionEnabled:false,operationPerformed:false,limitations:["Only owner-scoped stored evidence-reference metadata is compared; evidence content is not opened.","Different, reused, or missing digests are review candidates, not proof of conflict, contradiction, tampering, or invalid evidence.","A digest reused across source references may be legitimate and requires contextual human review.","No external source is contacted, no owner decision is created, and no finding or company state is changed.","Scan or candidate limits may omit records and affect the observed pattern set."]};
}
