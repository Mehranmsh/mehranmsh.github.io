/**
 * Fail-closed, plan-only Cloudflare D1 adapter for Pi Launchpad evidence records.
 * No database binding is imported, discovered, or executed here.
 */
const NETWORKS = new Set(["pi-mainnet", "pi-testnet"]);
const TYPES = new Set(["official_project_claim", "chain_indexer_observation", "dex_indexer_observation", "security_audit_claim", "community_claim"]);
const VERIFY = new Set(["unverified", "signature_verified", "attestation_rejected"]);
const CHAIN = "not_verified";
const SCORE = "blocked_pending_independent_chain_verification";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ID = /^plev_[a-f0-9]{32}$/;
const PLAN_BRAND = Symbol("pi-launchpad-evidence-d1-write-plan");
const isObject = v => !!v && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const validDate = v => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const canonical = v => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
};
const statement = (sql, params) => Object.freeze({sql, params:Object.freeze(params)});
function normalize(record) {
  if (!isObject(record) || !ID.test(record.recordId) ||
      !NETWORKS.has(record.networkId) ||
      typeof record.assetIdentifier !== "string" || !record.assetIdentifier.trim() || record.assetIdentifier.length > 256 ||
      typeof record.evidenceId !== "string" || !record.evidenceId.trim() || record.evidenceId.length > 160 ||
      !TYPES.has(record.evidenceType) ||
      typeof record.field !== "string" || !record.field.trim() || record.field.length > 64 ||
      !(record.value === null || ["string","number","boolean"].includes(typeof record.value)) ||
      (typeof record.value === "number" && !Number.isFinite(record.value)) ||
      (typeof record.value === "string" && record.value.length > 500) ||
      !isObject(record.source) ||
      typeof record.source.sourceId !== "string" || !record.source.sourceId.trim() || record.source.sourceId.length > 160 ||
      typeof record.source.kind !== "string" || !record.source.kind.trim() ||
      typeof record.source.url !== "string" || record.source.url.length > 2048 ||
      !validDate(record.observedAt) || !VERIFY.has(record.verificationStatus) ||
      record.chainVerificationStatus !== CHAIN || record.scoringStatus !== SCORE) {
    return {accepted:false, code:"invalid_or_promoted_evidence_record"};
  }
  let url;
  try { url = new URL(record.source.url); } catch { return {accepted:false, code:"invalid_source_url"}; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return {accepted:false, code:"invalid_source_url"};
  }
  const provenance = {
    source:{
      sourceId:record.source.sourceId,
      kind:record.source.kind,
      url:record.source.url
    },
    observedAt:record.observedAt
  };
  const valueJson = JSON.stringify(record.value);
  const provenanceJson = canonical(provenance);
  if (typeof valueJson !== "string" || valueJson.length > 8192 || provenanceJson.length > 8192) {
    return {accepted:false, code:"serialized_record_too_large"};
  }
  const row = [
    record.recordId, record.networkId, record.assetIdentifier, record.evidenceId,
    record.evidenceType, record.field, valueJson, provenanceJson,
    record.verificationStatus, CHAIN, SCORE, "0.1.0",
    validDate(record.createdAt) ? record.createdAt : record.observedAt
  ];
  return {accepted:true, row:Object.freeze(row), fingerprint:canonical(row)};
}

/**
 * Returns bounded parameterized D1 statements. Caller executes insertBatch in
 * one D1Database.batch(), then executes readback SELECTs and compares every
 * returned row with expectedRows. INSERT OR IGNORE is idempotent, not proof
 * of success: mismatched existing IDs must be treated as conflicts.
 */
export function buildPiLaunchpadEvidenceD1WritePlan(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 80) {
    return Object.freeze({accepted:false, code:"invalid_record_batch_size"});
  }
  const normalized = records.map(normalize);
  const rejected = normalized.find(item => !item.accepted);
  if (rejected) return Object.freeze({accepted:false, code:rejected.code});
  const ids = new Set();
  for (const item of normalized) {
    if (ids.has(item.row[0])) return Object.freeze({accepted:false, code:"duplicate_record_id_in_batch"});
    ids.add(item.row[0]);
  }
  const insertBatch = normalized.map(({row}) => statement(
    `INSERT INTO pi_launchpad_evidence_records
     (record_id, network_id, asset_identifier, evidence_id, evidence_type,
      field_name, value_json, provenance_json, verification_status,
      chain_verification_status, scoring_status, registry_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_id) DO NOTHING`, row
  ));
  const readback = normalized.map(({row}) => statement(
    `SELECT record_id, network_id, asset_identifier, evidence_id, evidence_type,
            field_name, value_json, provenance_json, verification_status,
            chain_verification_status, scoring_status, registry_version, created_at
     FROM pi_launchpad_evidence_records WHERE record_id = ?`, [row[0]]
  ));
  const plan = {
    accepted:true,
    adapter:"cloudflare-d1-plan-only",
    insertBatch:Object.freeze(insertBatch),
    readback:Object.freeze(readback),
    expectedRows:Object.freeze(normalized.map(({row})=>row)),
    executionRules:Object.freeze([
      "Execute all insert statements in exactly one D1Database.batch() call.",
      "Read back every record ID and compare all 13 columns byte-for-byte with expectedRows.",
      "Treat an identical existing row as an idempotent retry; any mismatch or missing row is a hard conflict.",
      "Never update or delete evidence rows. Corrections require a new evidence record with a new deterministic ID.",
      "Do not enable scoring or chain verification from this persistence result."
    ]),
    limitation:"Plan only. No D1 binding, credentials, network access, schema application, or live persistence is included."
  };
  Object.defineProperty(plan, PLAN_BRAND, {value:true});
  return Object.freeze(plan);
}

/** Execute only against an explicitly supplied D1 binding; intentionally not wired into any Worker. */
export async function persistPiLaunchpadEvidenceD1Plan(db, plan) {
  if (!db || typeof db.batch !== "function" || !isObject(plan) ||
      plan[PLAN_BRAND] !== true || plan.accepted !== true ||
      !Array.isArray(plan.insertBatch) || !Array.isArray(plan.readback) ||
      !Array.isArray(plan.expectedRows) || plan.insertBatch.length < 1 ||
      plan.insertBatch.length > 80 || plan.readback.length !== plan.insertBatch.length ||
      plan.expectedRows.length !== plan.insertBatch.length) {
    return Object.freeze({accepted:false, code:"invalid_d1_binding_or_plan"});
  }
  try {
    await db.batch(plan.insertBatch.map(item => db.prepare(item.sql).bind(...item.params)));
    const results = await Promise.all(plan.readback.map(async item =>
      db.prepare(item.sql).bind(...item.params).first()
    ));
    const matches = results.every((row,index) =>
      row && canonical([
        row.record_id,row.network_id,row.asset_identifier,row.evidence_id,row.evidence_type,
        row.field_name,row.value_json,row.provenance_json,row.verification_status,
        row.chain_verification_status,row.scoring_status,row.registry_version,row.created_at
      ]) === canonical(plan.expectedRows[index])
    );
    if (!matches) return Object.freeze({accepted:false, code:"d1_readback_conflict"});
    return Object.freeze({accepted:true, insertedOrAlreadyPresent:results.length, persisted:true,
      chainVerificationStatus:CHAIN, scoringStatus:SCORE});
  } catch {
    return Object.freeze({accepted:false, code:"d1_persistence_failed"});
  }
}
