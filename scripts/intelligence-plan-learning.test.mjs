import test from "node:test";
import assert from "node:assert/strict";
import { learnFromIntelligencePlanOutcomes } from "./intelligence-plan-learning.mjs";

const opts = { ownerUid: "owner-a", actorUid: "owner-a" };
const rev = (version, tasks) => ({ owner_uid: "owner-a", revision_id: "r" + version,
  version, created_at: `2026-11-${String(20 + version).padStart(2,"0")}T10:00:00Z`, tasks });
const task = (id, extra = {}) => ({ task_id: id, title: id, priority: "normal",
  due_at: "", depends_on_task_ids: [], ...extra });
const event = (version, id, state, extra = {}) => ({
  owner_uid: "owner-a", actor_uid: "owner-a", explicit_confirmation: true,
  revision_id: "r" + version, task_id: id, event_id: "e" + version + id,
  progress_state: state, occurred_at: `2026-11-2${version}T12:00:00Z`, ...extra
});

test("reports repeated associations only after the minimum confirmed sample", () => {
  const revisions = [rev(1, [task("a")]), rev(2, [task("a", { priority: "high" })]),
    rev(3, [task("a", { priority: "high" })]), rev(4, [task("a", { priority: "high" })])];
  const events = [event(2,"a","completed"), event(3,"a","completed"), event(4,"a","completed")];
  const result = learnFromIntelligencePlanOutcomes(revisions, events, opts);
  const pattern = result.patterns.find(x => x.signature === "priority_changed");
  assert.equal(pattern.observations, 1);
  assert.equal(pattern.status, "insufficient_observations");
  assert.equal(result.diagnostics.causalClaims, false);
});

test("does not count cross-owner, spoofed, implicit, or unconfirmed events", () => {
  const revisions = [rev(1, [task("a")]), rev(2, [task("a", { priority: "high" })])];
  const events = [
    event(2,"a","completed"),
    event(2,"a","failed",{ actor_uid:"attacker", event_id:"spoof" }),
    event(2,"a","failed",{ explicit_confirmation:false, event_id:"implicit" }),
    event(2,"a","blocked",{ owner_uid:"owner-b", event_id:"foreign" })
  ];
  const result = learnFromIntelligencePlanOutcomes(revisions, events, opts);
  assert.equal(result.diagnostics.observationsAccepted, 1);
  assert.equal(result.patterns[0].status, "insufficient_observations");
});

test("emits a repeated association without claiming cause or changing preferences", () => {
  const revisions = [rev(1,[task("a")]), rev(2,[task("a",{priority:"high"})]),
    rev(3,[task("a",{priority:"normal"})]), rev(4,[task("a",{priority:"high"})])];
  const events = [event(2,"a","failed"),event(3,"a","failed"),event(4,"a","failed")];
  const result = learnFromIntelligencePlanOutcomes(revisions,events,opts);
  const pattern = result.patterns.find(x => x.signature === "priority_changed");
  assert.equal(pattern.status,"repeated_association");
  assert.match(pattern.note,/does not establish causation/);
  assert.equal(result.diagnostics.preferencesChanged,false);
  assert.equal(result.diagnostics.recordsChanged,false);
});

test("fails closed without authenticated owner context and isolates other owners", () => {
  assert.equal(learnFromIntelligencePlanOutcomes([rev(1,[task("a")])],[],{...opts,actorUid:"attacker"}).diagnostics.ownerScoped,false);
  const foreign = {...rev(2,[task("x")]),owner_uid:"owner-b"};
  const result = learnFromIntelligencePlanOutcomes([rev(1,[task("a")]),foreign],[event(2,"x","completed")],opts);
  assert.equal(result.diagnostics.revisionsAccepted,1);
  assert.equal(result.observations.length,0);
});

test("is deterministic, bounded and read-only", () => {
  const revisions = [rev(1,[task("a")]),rev(2,[task("a",{priority:"high"})])];
  const events = [event(2,"a","completed")];
  const before = structuredClone({revisions,events});
  const a = learnFromIntelligencePlanOutcomes(revisions,events,{...opts,maxRevisions:1});
  const b = learnFromIntelligencePlanOutcomes(revisions,events,{...opts,maxRevisions:1});
  assert.deepEqual(a,b);
  assert.deepEqual({revisions,events},before);
  assert.equal(a.diagnostics.revisionsInspected,1);
});
