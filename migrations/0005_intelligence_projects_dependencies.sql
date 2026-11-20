-- Additive project and dependency model for private INTELLIGENCE staging.
-- Apply only after migrations 0000-0004 on mehran-msh-intelligence-staging.
-- This migration adds coordination metadata only. It creates no executor or scheduler.

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

ALTER TABLE intelligence_tasks
  ADD COLUMN project_id TEXT REFERENCES intelligence_projects(id) ON DELETE RESTRICT;

CREATE INDEX idx_intelligence_tasks_project
  ON intelligence_tasks(created_by,project_id,status,created_at);

CREATE TRIGGER trg_intelligence_task_project_owner_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT,'task project owner mismatch');
END;

CREATE TRIGGER trg_intelligence_task_project_owner_update
BEFORE UPDATE OF project_id,created_by ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.owner_uid=NEW.created_by
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
  WHERE t.project_id=OLD.id AND t.status<>'completed'
)
BEGIN
  SELECT RAISE(ABORT,'project has incomplete tasks');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_insert
BEFORE INSERT ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'cannot add incomplete task to completed project');
END;

CREATE TRIGGER trg_intelligence_task_completed_project_guard_update
BEFORE UPDATE OF project_id,status ON intelligence_tasks
WHEN NEW.project_id IS NOT NULL AND NEW.status<>'completed' AND EXISTS (
  SELECT 1 FROM intelligence_projects p
  WHERE p.id=NEW.project_id AND p.status='completed'
)
BEGIN
  SELECT RAISE(ABORT,'cannot place incomplete task in completed project');
END;

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

CREATE TRIGGER trg_intelligence_task_dependency_guard_insert
BEFORE INSERT ON intelligence_task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_tasks t
    JOIN intelligence_tasks prerequisite ON prerequisite.id=NEW.depends_on_task_id
    WHERE t.id=NEW.task_id
      AND t.created_by=NEW.owner_uid
      AND prerequisite.created_by=NEW.owner_uid
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
      AND t.created_by=NEW.owner_uid
      AND prerequisite.created_by=NEW.owner_uid
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

-- Moving a task cannot silently invalidate already-recorded dependency edges.
CREATE TRIGGER trg_intelligence_task_dependency_consistency_update
BEFORE UPDATE OF project_id,created_by ON intelligence_tasks
WHEN EXISTS (
  SELECT 1
  FROM intelligence_task_dependencies d
  JOIN intelligence_tasks other
    ON other.id = CASE WHEN d.task_id=OLD.id THEN d.depends_on_task_id ELSE d.task_id END
  WHERE (d.task_id=OLD.id OR d.depends_on_task_id=OLD.id)
    AND (other.created_by<>NEW.created_by
      OR COALESCE(other.project_id,'')<>COALESCE(NEW.project_id,''))
)
BEGIN
  SELECT RAISE(ABORT,'task move would invalidate dependency scope');
END;
