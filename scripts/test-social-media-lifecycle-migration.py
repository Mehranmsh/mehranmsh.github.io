#!/usr/bin/env python3
"""Disposable SQLite regression tests for SOCIAL media lifecycle migration 0021."""
from pathlib import Path
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0021_social_media_lifecycle_registry.sql"


def expect_integrity_error(fn, message):
    try:
        fn()
    except sqlite3.IntegrityError:
        return
    raise AssertionError(message)


def build_db():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
      CREATE TABLE social_uploads(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, mime_type TEXT NOT NULL, acl TEXT NOT NULL,
        status TEXT NOT NULL, url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE social_users(id TEXT PRIMARY KEY, avatar_url TEXT);
      CREATE TABLE social_posts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE social_stories(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_url TEXT NOT NULL);
      CREATE TABLE social_profile_photos(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, photo_url TEXT NOT NULL);
      CREATE TABLE social_messages(id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, media_json TEXT NOT NULL DEFAULT '[]', deleted_at TEXT);
      CREATE TABLE social_channel_posts(id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, media_json TEXT NOT NULL DEFAULT '[]');
    """)
    db.executescript(MIGRATION.read_text(encoding="utf-8"))
    return db


def add_upload(db, upload_id="file-a", owner="user-a"):
    db.execute(
        "INSERT INTO social_uploads(id,user_id,name,size,mime_type,acl,status,url) VALUES(?,?,?,?,?,?,?,?)",
        (upload_id, owner, "photo.jpg", 1024, "image/jpeg", "public", "ready", "https://cdn.example/photo.jpg"),
    )


def add_ref(db, upload_id, content_type, content_id, slot="primary", owner="user-a"):
    db.execute(
        """INSERT INTO social_media_references(id,upload_id,owner_user_id,content_type,content_id,media_slot)
           VALUES(?,?,?,?,?,?)""",
        ("ref-" + content_type + "-" + content_id + "-" + slot, upload_id, owner, content_type, content_id, slot),
    )


def job_count(db, upload_id):
    return db.execute("SELECT COUNT(*) FROM social_media_deletion_jobs WHERE upload_id=?", (upload_id,)).fetchone()[0]


def test_shared_reference_blocks_early_deletion():
    db = build_db()
    add_upload(db)
    db.execute("INSERT INTO social_posts(id,user_id) VALUES('post-1','user-a')")
    db.execute("INSERT INTO social_profile_photos(id,user_id,photo_url) VALUES('photo-1','user-a','https://cdn.example/photo.jpg')")
    add_ref(db, "file-a", "post", "post-1")
    add_ref(db, "file-a", "profile_gallery", "photo-1")
    db.execute("DELETE FROM social_posts WHERE id='post-1'")
    assert job_count(db, "file-a") == 0, "shared file must not be queued while gallery reference remains"
    db.execute("DELETE FROM social_profile_photos WHERE id='photo-1'")
    assert job_count(db, "file-a") == 1, "last reference release must create one per-file job"
    expect_integrity_error(
        lambda: db.execute("DELETE FROM social_uploads WHERE id='file-a'"),
        "upload row must remain while deletion job is pending",
    )
    db.close()


def test_new_reference_blocks_pending_job():
    db = build_db()
    add_upload(db)
    db.execute("INSERT INTO social_posts(id,user_id) VALUES('post-2','user-a')")
    add_ref(db, "file-a", "post", "post-2")
    db.execute("DELETE FROM social_posts WHERE id='post-2'")
    assert job_count(db, "file-a") == 1
    db.execute("INSERT INTO social_posts(id,user_id) VALUES('post-3','user-a')")
    add_ref(db, "file-a", "post", "post-3")
    status = db.execute("SELECT status,last_error FROM social_media_deletion_jobs WHERE upload_id='file-a'").fetchone()
    assert status == ("blocked", "active_reference_added"), "new reference must block pending provider deletion"
    expect_integrity_error(
        lambda: db.execute("DELETE FROM social_uploads WHERE id='file-a'"),
        "blocked job must keep upload row",
    )
    db.close()


def test_all_content_release_paths():
    db = build_db()
    add_upload(db, "story-file")
    db.execute("INSERT INTO social_stories(id,user_id,media_url) VALUES('story-1','user-a','https://cdn.example/photo.jpg')")
    add_ref(db, "story-file", "story", "story-1")
    db.execute("DELETE FROM social_stories WHERE id='story-1'")
    assert job_count(db, "story-file") == 1

    add_upload(db, "gallery-file")
    db.execute("INSERT INTO social_profile_photos(id,user_id,photo_url) VALUES('gallery-1','user-a','https://cdn.example/photo.jpg')")
    add_ref(db, "gallery-file", "profile_gallery", "gallery-1")
    db.execute("DELETE FROM social_profile_photos WHERE id='gallery-1'")
    assert job_count(db, "gallery-file") == 1

    add_upload(db, "avatar-file")
    db.execute("INSERT INTO social_users(id,avatar_url,avatar_upload_id) VALUES('user-a','https://cdn.example/photo.jpg','avatar-file')")
    add_ref(db, "avatar-file", "profile_avatar", "user-a", "avatar")
    db.execute("UPDATE social_users SET avatar_upload_id=NULL WHERE id='user-a'")
    assert job_count(db, "avatar-file") == 1

    add_upload(db, "message-file")
    db.execute("INSERT INTO social_messages(id,sender_id,media_json) VALUES('message-1','user-a','[]')")
    add_ref(db, "message-file", "message", "message-1")
    db.execute("UPDATE social_messages SET deleted_at=CURRENT_TIMESTAMP WHERE id='message-1'")
    assert job_count(db, "message-file") == 1

    add_upload(db, "channel-file")
    db.execute("INSERT INTO social_channel_posts(id,sender_id,media_json) VALUES('channel-post-1','user-a','[]')")
    add_ref(db, "channel-file", "channel_post", "channel-post-1")
    db.execute("DELETE FROM social_channel_posts WHERE id='channel-post-1'")
    assert job_count(db, "channel-file") == 1
    db.close()


def test_legacy_untracked_urls_are_never_guessed():
    db = build_db()
    add_upload(db)
    db.execute("INSERT INTO social_stories(id,user_id,media_url) VALUES('legacy-story','user-a','https://cdn.example/photo.jpg')")
    db.execute("DELETE FROM social_stories WHERE id='legacy-story'")
    assert job_count(db, "file-a") == 0, "URL-only legacy content must not be inferred as a managed reference"
    db.close()


def test_reference_and_audit_are_immutable_and_upload_delete_is_guarded():
    db = build_db()
    add_upload(db)
    db.execute("INSERT INTO social_posts(id,user_id) VALUES('post-4','user-a')")
    add_ref(db, "file-a", "post", "post-4")
    ref_id = db.execute("SELECT id FROM social_media_references").fetchone()[0]
    expect_integrity_error(
        lambda: db.execute("UPDATE social_media_references SET upload_id='other-file' WHERE id=?", (ref_id,)),
        "reference identity must be immutable",
    )
    expect_integrity_error(
        lambda: db.execute("DELETE FROM social_media_references WHERE id=?", (ref_id,)),
        "reference history must not be deleted",
    )
    audit_id = db.execute("SELECT id FROM social_media_lifecycle_audit LIMIT 1").fetchone()[0]
    expect_integrity_error(
        lambda: db.execute("UPDATE social_media_lifecycle_audit SET details='tampered' WHERE id=?", (audit_id,)),
        "audit must be append-only",
    )
    expect_integrity_error(
        lambda: db.execute("DELETE FROM social_media_lifecycle_audit WHERE id=?", (audit_id,)),
        "audit must be append-only",
    )
    db.execute("DELETE FROM social_posts WHERE id='post-4'")
    job_id = db.execute("SELECT id FROM social_media_deletion_jobs WHERE upload_id='file-a'").fetchone()[0]
    db.execute("UPDATE social_media_deletion_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?", (job_id,))
    db.execute("DELETE FROM social_uploads WHERE id='file-a'")
    assert db.execute("SELECT COUNT(*) FROM social_uploads").fetchone()[0] == 0
    db.close()


def test_reference_and_job_owner_guards():
    db = build_db()
    add_upload(db)
    expect_integrity_error(
        lambda: db.execute(
            """INSERT INTO social_media_references(id,upload_id,owner_user_id,content_type,content_id)
               VALUES('bad-owner-ref','file-a','user-b','post','post-x')"""
        ),
        "reference owner must match the upload owner",
    )
    db.execute("UPDATE social_uploads SET acl='private' WHERE id='file-a'")
    expect_integrity_error(
        lambda: add_ref(db, "file-a", "post", "post-private"),
        "public content cannot reference a private upload",
    )
    expect_integrity_error(
        lambda: db.execute(
            """INSERT INTO social_media_deletion_jobs(
                 id,batch_id,upload_id,owner_user_id,request_key,status
               ) VALUES('bad-job','batch','file-a','user-b','bad-request','pending')"""
        ),
        "deletion job owner must match the upload owner",
    )
    db.execute("UPDATE social_uploads SET acl='public' WHERE id='file-a'")
    db.execute("INSERT INTO social_posts(id,user_id) VALUES('post-active','user-a')")
    add_ref(db, "file-a", "post", "post-active")
    expect_integrity_error(
        lambda: db.execute(
            """INSERT INTO social_media_deletion_jobs(
                 id,batch_id,upload_id,owner_user_id,request_key,status
               ) VALUES('active-job','batch','file-a','user-a','active-request','pending')"""
        ),
        "deletion job must not be queued while an active reference exists",
    )
    db.close()


def test_duplicate_active_reference_is_rejected():
    db = build_db()
    add_upload(db)
    add_ref(db, "file-a", "post", "post-5")
    expect_integrity_error(
        lambda: add_ref(db, "file-a", "post", "post-5"),
        "duplicate active reference must be rejected",
    )
    db.close()


if __name__ == "__main__":
    tests = [
        test_shared_reference_blocks_early_deletion,
        test_new_reference_blocks_pending_job,
        test_all_content_release_paths,
        test_legacy_untracked_urls_are_never_guessed,
        test_reference_and_audit_are_immutable_and_upload_delete_is_guarded,
        test_duplicate_active_reference_is_rejected,
        test_reference_and_job_owner_guards,
    ]
    for test in tests:
        test()
        print("PASS:", test.__name__)
    print(f"PASS: {len(tests)} SOCIAL media lifecycle migration tests")
