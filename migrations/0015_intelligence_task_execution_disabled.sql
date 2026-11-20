-- Keep Intelligence tasks as owner-created plans only.
-- No task execution, scheduler claim, agent claim, or executor state transition is allowed.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_task_insert_plan_only
BEFORE INSERT ON intelligence_tasks
WHEN NEW.status <> 'queued'
  OR NEW.assigned_to <> 'mehran_intelligence'
  OR NEW.requires_approval NOT IN (0, 1)
  OR NEW.result_text <> ''
  OR NEW.action_type <> ''
  OR NEW.action_payload <> '{}'
  OR NEW.agent_claimed_at IS NOT NULL
  OR NEW.agent_claim_id IS NOT NULL
  OR NEW.scheduler_claimed_at IS NOT NULL
  OR NEW.scheduler_claim_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Intelligence tasks may only be created as unclaimed plans');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_task_execution_state_immutable
BEFORE UPDATE OF status, assigned_to, result_text, action_type, action_payload,
                 agent_claimed_at, agent_claim_id, scheduler_claimed_at, scheduler_claim_id
ON intelligence_tasks
WHEN NEW.status IS NOT OLD.status
  OR NEW.assigned_to IS NOT OLD.assigned_to
  OR NEW.result_text IS NOT OLD.result_text
  OR NEW.action_type IS NOT OLD.action_type
  OR NEW.action_payload IS NOT OLD.action_payload
  OR NEW.agent_claimed_at IS NOT OLD.agent_claimed_at
  OR NEW.agent_claim_id IS NOT OLD.agent_claim_id
  OR NEW.scheduler_claimed_at IS NOT OLD.scheduler_claimed_at
  OR NEW.scheduler_claim_id IS NOT OLD.scheduler_claim_id
BEGIN
  SELECT RAISE(ABORT, 'Intelligence task execution is disabled in staging');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_task_identity_immutable
BEFORE UPDATE OF id, created_by, created_at ON intelligence_tasks
WHEN NEW.id IS NOT OLD.id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Intelligence task identity is immutable');
END;
