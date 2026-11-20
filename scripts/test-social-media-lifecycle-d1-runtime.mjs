import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const ROOT = new URL("../", import.meta.url);
const mf = new Miniflare({
  script: "export default { async fetch() { return new Response('ok'); } };",
  modules: true,
  d1Databases: { DB: "social-media-lifecycle-d1-runtime" },
});

try {
  const db = await mf.getD1Database("DB");
  await db.exec(`
    CREATE TABLE social_uploads(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,acl TEXT NOT NULL,status TEXT NOT NULL,url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE social_users(id TEXT PRIMARY KEY,avatar_url TEXT);
    CREATE TABLE social_posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,media_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE social_stories(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,media_url TEXT NOT NULL);
    CREATE TABLE social_profile_photos(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,photo_url TEXT NOT NULL);
    CREATE TABLE social_messages(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,media_json TEXT NOT NULL DEFAULT '[]',deleted_at TEXT);
    CREATE TABLE social_channel_posts(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,media_json TEXT NOT NULL DEFAULT '[]');
  `);

  const migration = await readFile(new URL("migrations/0021_social_media_lifecycle_registry.sql", ROOT), "utf8");
  const sql = migration.split("\n").filter(line => !line.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
  await db.exec(sql);

  const insertUpload = async (id, owner = "owner-a", managed = 1, acl = "public") =>
    db.prepare(`
      INSERT INTO social_uploads(id,user_id,name,size,mime_type,acl,status,url,lifecycle_managed)
      VALUES(?,?,?,?,?,?,?, ?,?)
    `).bind(id,owner,"media.jpg",1024,acl,"ready",acl==="public"?"https://cdn.example/"+id:null,managed).run();

  const addRef = async (id, uploadId, type, contentId, slot = "primary", owner = "owner-a") =>
    db.prepare(`
      INSERT INTO social_media_references(id,upload_id,owner_user_id,content_type,content_id,media_slot)
      VALUES(?,?,?,?,?,?)
    `).bind(id,uploadId,owner,type,contentId,slot).run();

  const jobs = async uploadId => {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM social_media_deletion_jobs WHERE upload_id=?").bind(uploadId).first();
    return Number(row.count);
  };

  await insertUpload("shared-file");
  await db.prepare("INSERT INTO social_posts(id,user_id) VALUES('post-1','owner-a')").run();
  await db.prepare("INSERT INTO social_profile_photos(id,user_id,photo_url) VALUES('photo-1','owner-a','https://cdn.example/shared-file')").run();
  await addRef("ref-post","shared-file","post","post-1");
  await addRef("ref-gallery","shared-file","profile_gallery","photo-1");
  await db.prepare("DELETE FROM social_posts WHERE id='post-1'").run();
  assert.equal(await jobs("shared-file"),0,"shared media must not be queued early");
  await db.prepare("DELETE FROM social_profile_photos WHERE id='photo-1'").run();
  assert.equal(await jobs("shared-file"),1,"last reference release must queue one file job");
  await assert.rejects(
    db.prepare("DELETE FROM social_uploads WHERE id='shared-file'").run(),
    /SOCIAL upload cannot be deleted/i
  );

  const frozen = await db.prepare("SELECT status FROM social_uploads WHERE id='shared-file'").first();
  assert.equal(frozen.status,"deletion_pending","queued upload must be frozen against new references");
  await assert.rejects(
    db.prepare("UPDATE social_uploads SET status='ready' WHERE id='shared-file'").run(),
    /SOCIAL upload lifecycle state cannot be reversed/i
  );
  await assert.rejects(
    db.prepare("UPDATE social_uploads SET lifecycle_managed=0 WHERE id='shared-file'").run(),
    /SOCIAL upload lifecycle state cannot be reversed/i
  );
  await db.prepare("INSERT INTO social_posts(id,user_id) VALUES('post-2','owner-a')").run();
  await assert.rejects(
    addRef("ref-readded","shared-file","post","post-2"),
    /SOCIAL media reference upload ownership/i
  );
  const queued = await db.prepare("SELECT status FROM social_media_deletion_jobs WHERE upload_id='shared-file'").first();
  assert.equal(queued.status,"pending","re-reference rejection must leave the deletion job pending");
  await assert.rejects(
    db.prepare("INSERT INTO social_media_deletion_jobs(id,batch_id,upload_id,owner_user_id,request_key,status) VALUES('bad','batch','shared-file','owner-b','bad-request','pending')").run(),
    /SOCIAL media deletion requires/i
  );

  await insertUpload("terminal-file");
  await db.prepare("INSERT INTO social_posts(id,user_id) VALUES('terminal-post','owner-a')").run();
  await addRef("terminal-ref","terminal-file","post","terminal-post");
  await db.prepare("DELETE FROM social_posts WHERE id='terminal-post'").run();
  const terminalJob = await db.prepare("SELECT id FROM social_media_deletion_jobs WHERE upload_id='terminal-file'").first();
  await db.prepare("UPDATE social_media_deletion_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(terminalJob.id).run();
  await db.prepare("INSERT INTO social_posts(id,user_id) VALUES('after-delete-post','owner-a')").run();
  await assert.rejects(
    addRef("after-delete-ref","terminal-file","post","after-delete-post"),
    /SOCIAL media reference upload ownership/i
  );

  await insertUpload("private-file","owner-a",1,"private");
  await db.prepare("INSERT INTO social_messages(id,sender_id,media_json) VALUES('message-1','owner-a','[]')").run();
  await addRef("ref-message","private-file","message","message-1");
  await db.prepare("UPDATE social_messages SET deleted_at=CURRENT_TIMESTAMP WHERE id='message-1'").run();
  assert.equal(await jobs("private-file"),1,"soft-deleted message must release its private upload reference");

  await insertUpload("legacy-file","owner-a",0,"public");
  await db.prepare("INSERT INTO social_posts(id,user_id) VALUES('legacy-post','owner-a')").run();
  await assert.rejects(
    addRef("legacy-ref","legacy-file","post","legacy-post"),
    /SOCIAL media reference upload ownership/i
  );
  await db.prepare("DELETE FROM social_posts WHERE id='legacy-post'").run();
  assert.equal(await jobs("legacy-file"),0,"legacy upload must never be auto-queued");
  await assert.rejects(
    db.prepare("DELETE FROM social_uploads WHERE id='legacy-file'").run(),
    /SOCIAL upload cannot be deleted/i
  );

  const audit = await db.prepare("SELECT id FROM social_media_lifecycle_audit LIMIT 1").first();
  assert.ok(audit?.id);
  await assert.rejects(
    db.prepare("DELETE FROM social_media_lifecycle_audit WHERE id=?").bind(audit.id).run(),
    /append-only/i
  );

  const requiredTriggers = [
    "trg_social_media_reference_owner_guard","trg_social_media_deletion_job_owner_guard",
    "trg_social_media_deletion_job_identity_immutable","trg_social_media_reference_identity_immutable",
    "trg_social_media_reference_no_delete","trg_social_media_reference_insert_audit",
    "trg_social_media_reference_release_audit","trg_social_media_deletion_job_audit",
    "trg_social_media_deletion_job_mark_upload_pending","trg_social_media_audit_no_update","trg_social_media_audit_no_delete",
    "trg_social_upload_lifecycle_state_guard","trg_social_upload_delete_guard","trg_social_posts_media_release",
    "trg_social_stories_media_release","trg_social_profile_gallery_media_release",
    "trg_social_profile_gallery_media_replace","trg_social_profile_avatar_media_release","trg_social_messages_media_release",
    "trg_social_channel_posts_media_release"
  ];
  const rows = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ("+requiredTriggers.map(()=>"?").join(",")+")"
  ).bind(...requiredTriggers).all();
  assert.equal(rows.results.length,requiredTriggers.length,"all lifecycle triggers must exist in D1");

  console.log("PASS: disposable D1 validates SOCIAL media ownership, shared references, re-reference blocking, legacy quarantine, and append-only audit");
} finally {
  await mf.dispose();
}
