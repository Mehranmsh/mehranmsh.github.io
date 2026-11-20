-- SOCIAL media lifecycle foundation.
-- Staging-only migration. No provider deletion consumer is introduced or enabled here.
-- Every upload deletion remains queued and inert until separately approved.

ALTER TABLE social_stories ADD COLUMN media_upload_id TEXT;
ALTER TABLE social_users ADD COLUMN avatar_upload_id TEXT;
ALTER TABLE social_profile_photos ADD COLUMN upload_id TEXT;
ALTER TABLE social_uploads ADD COLUMN lifecycle_managed INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_managed IN (0,1));

CREATE TABLE IF NOT EXISTS social_media_references (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN (
    'post','story','profile_avatar','profile_gallery','message','channel_post'
  )),
  content_id TEXT NOT NULL,
  media_slot TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_media_references_active_unique
ON social_media_references(upload_id,content_type,content_id,media_slot)
WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_social_media_references_upload_active
ON social_media_references(upload_id,released_at);

CREATE INDEX IF NOT EXISTS idx_social_media_references_content_active
ON social_media_references(content_type,content_id,released_at);

-- One job represents one provider file. Multi-file account deletion therefore
-- remains independently retryable, without one failed file blocking siblings.
CREATE TABLE IF NOT EXISTS social_media_deletion_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','retry','blocked','completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_social_media_deletion_jobs_due
ON social_media_deletion_jobs(status,next_attempt_at,created_at);

CREATE INDEX IF NOT EXISTS idx_social_media_deletion_jobs_upload
ON social_media_deletion_jobs(upload_id,status);

CREATE TABLE IF NOT EXISTS social_media_lifecycle_audit (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  reference_id TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_social_media_lifecycle_audit_upload
ON social_media_lifecycle_audit(upload_id,created_at);

CREATE TRIGGER IF NOT EXISTS trg_social_media_reference_owner_guard
BEFORE INSERT ON social_media_references
WHEN NOT EXISTS (
  SELECT 1 FROM social_uploads u
  WHERE u.id=NEW.upload_id AND u.user_id=NEW.owner_user_id AND u.status='ready' AND u.lifecycle_managed=1 AND u.lifecycle_managed=1
    AND (
      (NEW.content_type='message' AND u.acl='private')
      OR (NEW.content_type!='message' AND u.acl='public')
    )
)
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media reference upload ownership, readiness, or visibility mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_deletion_job_owner_guard
BEFORE INSERT ON social_media_deletion_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM social_uploads u
  WHERE u.id=NEW.upload_id AND u.user_id=NEW.owner_user_id AND u.status='ready'
) OR NEW.status!='pending' OR NEW.attempts!=0 OR EXISTS (
  SELECT 1 FROM social_media_references r
  WHERE r.upload_id=NEW.upload_id AND r.released_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media deletion requires an owned upload with no active references');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_deletion_job_identity_immutable
BEFORE UPDATE ON social_media_deletion_jobs
WHEN NEW.id IS NOT OLD.id
  OR NEW.batch_id IS NOT OLD.batch_id
  OR NEW.upload_id IS NOT OLD.upload_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.request_key IS NOT OLD.request_key
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media deletion job identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_reference_identity_immutable
BEFORE UPDATE ON social_media_references
WHEN NEW.id IS NOT OLD.id
  OR NEW.upload_id IS NOT OLD.upload_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.content_type IS NOT OLD.content_type
  OR NEW.content_id IS NOT OLD.content_id
  OR NEW.media_slot IS NOT OLD.media_slot
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
  OR (NEW.released_at IS NOT NULL AND NEW.released_at > CURRENT_TIMESTAMP)
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media reference identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_reference_release_audit
AFTER UPDATE OF released_at ON social_media_references
WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
BEGIN
  INSERT INTO social_media_lifecycle_audit(
    id,upload_id,owner_user_id,event_type,reference_id,details
  ) VALUES(
    lower(hex(randomblob(16))),NEW.upload_id,NEW.owner_user_id,
    'reference_released',NEW.id,NEW.content_type||':'||NEW.content_id||':'||NEW.media_slot
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_reference_no_delete
BEFORE DELETE ON social_media_references
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media references are retained for lifecycle history');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_reference_insert_audit
AFTER INSERT ON social_media_references
BEGIN
  INSERT INTO social_media_lifecycle_audit(
    id,upload_id,owner_user_id,event_type,reference_id,details
  ) VALUES(
    lower(hex(randomblob(16))),NEW.upload_id,NEW.owner_user_id,
    'reference_created',NEW.id,NEW.content_type||':'||NEW.content_id||':'||NEW.media_slot
  );
  UPDATE social_media_deletion_jobs
  SET status='blocked',last_error='active_reference_added',updated_at=CURRENT_TIMESTAMP
  WHERE upload_id=NEW.upload_id AND status IN ('pending','retry');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_deletion_job_audit
AFTER INSERT ON social_media_deletion_jobs
BEGIN
  INSERT INTO social_media_lifecycle_audit(
    id,upload_id,owner_user_id,event_type,job_id,details
  ) VALUES(
    lower(hex(randomblob(16))),NEW.upload_id,NEW.owner_user_id,
    'deletion_queued',NEW.id,'provider deletion is not executed by this migration'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_audit_no_update
BEFORE UPDATE ON social_media_lifecycle_audit
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media lifecycle audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_media_audit_no_delete
BEFORE DELETE ON social_media_lifecycle_audit
BEGIN
  SELECT RAISE(ABORT,'SOCIAL media lifecycle audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_social_upload_delete_guard
BEFORE DELETE ON social_uploads
WHEN OLD.lifecycle_managed!=1 OR EXISTS (
  SELECT 1 FROM social_media_references
  WHERE upload_id=OLD.id AND released_at IS NULL
) OR EXISTS (
  SELECT 1 FROM social_media_deletion_jobs
  WHERE upload_id=OLD.id AND status IN ('pending','retry')
)
BEGIN
  SELECT RAISE(ABORT,'SOCIAL upload cannot be deleted before references are released and provider deletion is confirmed');
END;

-- A single-file job is queued only after the final known reference is released.
-- Legacy URL-only references are intentionally not inferred or auto-deleted.
CREATE TRIGGER IF NOT EXISTS trg_social_posts_media_release
AFTER DELETE ON social_posts
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='post' AND content_id=OLD.id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'post-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE u.lifecycle_managed=1 AND EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.content_type='post' AND r.content_id=OLD.id
      AND r.released_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_deletion_jobs j
    WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_stories_media_release
AFTER DELETE ON social_stories
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='story' AND content_id=OLD.id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'story-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.content_type='story' AND r.content_id=OLD.id
      AND r.released_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_deletion_jobs j
    WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_profile_gallery_media_release
AFTER DELETE ON social_profile_photos
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='profile_gallery' AND content_id=OLD.id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'gallery-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.content_type='profile_gallery' AND r.content_id=OLD.id
      AND r.released_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_deletion_jobs j
    WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_profile_avatar_media_release
AFTER UPDATE OF avatar_upload_id ON social_users
WHEN OLD.avatar_upload_id IS NOT NEW.avatar_upload_id AND OLD.avatar_upload_id IS NOT NULL
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='profile_avatar' AND content_id=OLD.id
    AND media_slot='avatar' AND upload_id=OLD.avatar_upload_id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'avatar-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE u.lifecycle_managed=1 AND u.id=OLD.avatar_upload_id
    AND NOT EXISTS (
      SELECT 1 FROM social_media_references r
      WHERE r.upload_id=u.id AND r.released_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM social_media_deletion_jobs j
      WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_messages_media_release
AFTER UPDATE OF deleted_at ON social_messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='message' AND content_id=OLD.id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'message-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.content_type='message' AND r.content_id=OLD.id
      AND r.released_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_deletion_jobs j
    WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_social_channel_posts_media_release
AFTER DELETE ON social_channel_posts
BEGIN
  UPDATE social_media_references SET released_at=CURRENT_TIMESTAMP
  WHERE content_type='channel_post' AND content_id=OLD.id AND released_at IS NULL;
  INSERT INTO social_media_deletion_jobs(
    id,batch_id,upload_id,owner_user_id,request_key,status
  )
  SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),u.id,u.user_id,
    'channel-release:'||u.id||':'||lower(hex(randomblob(16))),'pending'
  FROM social_uploads u
  WHERE EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.content_type='channel_post' AND r.content_id=OLD.id
      AND r.released_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_references r
    WHERE r.upload_id=u.id AND r.released_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM social_media_deletion_jobs j
    WHERE j.upload_id=u.id AND j.status IN ('pending','retry')
  );
END;
