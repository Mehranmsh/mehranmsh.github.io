-- MEHRAN INTELLIGENCE production-compatible ownership + project model.
-- Apply ONLY after verifying that production worker's ensureIntelligenceTaskTable
-- has created intelligence_tasks and after checking its live schema.
-- This migration is additive. It preserves created_by and every existing task.
-- owner_uid stays NULL for legacy rows until an authenticated owner backfill runs.

ALTER TABLE intelligence_tasks ADD COLUMN owner_uid TEXT;
ALTER TABLE intelligence_tasks ADD COLUMN project_id TEXT
  REFERENCES intelligence_projects(id) ON DELETE RESTRICT;

CREATE TABLE intelligence_projects (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(trim(owner_uid)) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 3000),
  module_key TEXT NOT NULL CHECK(length(trim(module_key)) BETWEEN 1 AND 40),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','active','paused','completed','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX idx_intelligence_projects_owner_status
  ON intelligence_projects(owner_uid,status,updated_at DESC);
CREATE INDEX idx_intelligence_projects_owner_module
  ON intelligence_projects(owner_uid,module_key,updated_at DESC);
CREATE INDEX idx_intelligence_tasks_owner_project_status
  ON intelligence_tasks(owner_uid,project_id,status,created_at);
CREATE INDEX idx_intelligence_tasks_project_legacy
  ON intelligence_tasks(created_by,project_id,status,created_at);

CREATE TABLE intelligence_task_dependencies (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(trim(owner_uid)) BETWEEN 1 AND 200),
  task_id TEXT NOT NULL REFERENCES intelligence_tasks(id) ON DELETE RESTRICT,
  depends_on_task_id TEXT NOT NULL REFERENCES intelligence_tasks(id) ON DELETE RESTRICT,
  dependency_type TEXT NOT NULL DEFAULT 'blocks' CHECK(dependency_type='blocks'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(task_id <> depends_on_task_id),
  UNIQUE(owner_uid,task_id,depends_on_task_id,dependency_type)
);

CREATE INDEX idx_intelligence_task_dependencies_task
  ON intelligence_task_dependencies(owner_uid,task_id);
CREATE INDEX idx_intelligence_task_dependencies_prerequisite
  ON intelligence_task_dependencies(owner_uid,depends_on_task_id);

CREATE TRIGGER trg_intelligence_task_project_owner_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.owner_uid
)
BEGIN
  SELECT RAISE(ABORT,'task project owner mismatch');
END;

CREATE TRIGGER trg_intelligence_task_project_owner_update
BEFORE UPDATE OF project_id,owner_uid ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.owner_uid
)
BEGIN
  SELECT RAISE(ABORT,'task project owner mismatch');
END;

CREATE TRIGGER trg_intelligence_project_owner_immutable_with_tasks
BEFORE UPDATE OF owner_uid ON intelligence_projects
WHEN EXISTS (SELECT 1 FROM intelligence_tasks t WHERE t.project_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT,'project owner cannot change while tasks are attached');
END;

CREATE TRIGGER trg_intelligence_project_complete_guard
BEFORE UPDATE OF status ON intelligence_projects
WHEN NEW.status='completed' AND EXISTS (
  SELECT 1 FROM intelligence_tasks t
  WHERE t.project_id=OLD.id AND t.owner_uid=OLD.owner_uid AND t.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'project has incomplete tasks');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.owner_uid AND p.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'cannot add incomplete task to completed project');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_update
BEFORE UPDATE OF project_id,status,owner_uid ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.owner_uid AND p.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'cannot place incomplete task in completed project');
END;

CREATE TRIGGER trg_intelligence_task_dependency_guard_insert
BEFORE INSERT ON intelligence_task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_tasks t
    JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
    WHERE t.id=NEW.task_id
      AND t.owner_uid=NEW.owner_uid
      AND prerequisite.owner_uid=NEW.owner_uid
      AND COALESCE(t.project_id,'')=COALESCE(prerequisite.project_id,'')
  ) THEN RAISE(ABORT,'task dependency owner or project mismatch') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id
      FROM intelligence_task_dependencies d
      JOIN reachable r ON d.task_id=r.task_id
      WHERE d.owner_uid=NEW.owner_uid
    )
    SELECT 1 FROM reachable WHERE task_id=NEW.task_id
  ) THEN RAISE(ABORT,'task dependency cycle') END;
END;

CREATE TRIGGER trg_intelligence_task_dependency_guard_update
BEFORE UPDATE OF owner_uid,task_id,depends_on_task_id,dependency_type
ON intelligence_task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_tasks t
    JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
    WHERE t.id=NEW.task_id
      AND t.owner_uid=NEW.owner_uid
      AND prerequisite.owner_uid=NEW.owner_uid
      AND COALESCE(t.project_id,'')=COALESCE(prerequisite.project_id,'')
  ) THEN RAISE(ABORT,'task dependency owner or project mismatch') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id
      FROM intelligence_task_dependencies d
      JOIN reachable r ON d.task_id=r.task_id
      WHERE d.owner_uid=NEW.owner_uid AND d.id<>OLD.id
    )
    SELECT 1 FROM reachable WHERE task_id=NEW.task_id
  ) THEN RAISE(ABORT,'task dependency cycle') END;
END;

CREATE TRIGGER trg_intelligence_task_completion_dependency_guard
BEFORE UPDATE OF status ON intelligence_tasks
WHEN NEW.status='completed' AND EXISTS (
  SELECT 1 FROM intelligence_task_dependencies d
  JOIN intelligence_tasks prerequisite ON prerequisite.id=d.depends_on_task_id
  WHERE d.owner_uid=OLD.owner_uid
    AND d.task_id=OLD.id
    AND prerequisite.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'task has incomplete prerequisites');
END;

CREATE TRIGGER trg_intelligence_task_dependency_completed_guard_insert
BEFORE INSERT ON intelligence_task_dependencies
WHEN EXISTS (
  SELECT 1
  FROM intelligence_tasks dependent
  JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
  WHERE dependent.id=NEW.task_id
    AND dependent.owner_uid=NEW.owner_uid
    AND dependent.status='completed'
    AND prerequisite.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'completed task cannot gain an incomplete prerequisite');
END;

CREATE TRIGGER trg_intelligence_task_dependency_completed_guard_update
BEFORE UPDATE OF owner_uid,task_id,depends_on_task_id ON intelligence_task_dependencies
WHEN EXISTS (
  SELECT 1
  FROM intelligence_tasks dependent
  JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
  WHERE dependent.id=NEW.task_id
    AND dependent.owner_uid=NEW.owner_uid
    AND dependent.status='completed'
    AND prerequisite.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'completed task cannot gain an incomplete prerequisite');
END;

CREATE TRIGGER trg_intelligence_task_reopen_dependency_guard
BEFORE UPDATE OF status ON intelligence_tasks
WHEN OLD.status='completed' AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_task_dependencies d
  JOIN intelligence_tasks dependent ON dependent.id=d.task_id
  WHERE d.owner_uid=OLD.owner_uid
    AND d.depends_on_task_id=OLD.id
    AND dependent.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'completed dependent tasks must be reopened first');
END;

CREATE TRIGGER trg_intelligence_task_dependency_consistency_update
BEFORE UPDATE OF project_id,owner_uid ON intelligence_tasks
WHEN EXISTS (
  SELECT 1
  FROM intelligence_task_dependencies d
  JOIN intelligence_tasks other
    ON other.id = CASE WHEN d.task_id=OLD.id THEN d.depends_on_task_id ELSE d.task_id END
  WHERE (d.task_id=OLD.id OR d.depends_on_task_id=OLD.id)
    AND (other.owner_uid<>NEW.owner_uid
      OR COALESCE(other.project_id,'')<>COALESCE(NEW.project_id,''))
)
BEGIN
  SELECT RAISE(ABORT,'task move would invalidate dependency scope');
END;
