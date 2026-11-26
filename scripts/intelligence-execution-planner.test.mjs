import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelligenceExecutionPlan } from "./intelligence-execution-planner.mjs";
const task=(task_id,extra={})=>({owner_uid:"owner-a",memory_type:"task",task_id,title:task_id,task_state:"pending",priority:"medium",...extra});
test("orders confirmed dependencies before dependents and uses priority among ready tasks",()=>{
 const r=buildIntelligenceExecutionPlan([task("publish",{depends_on_task_ids:["build"],dependencies_confirmed:true,dependencies_confirmed_by:"owner-a",priority:"critical"}),task("docs",{priority:"high"}),task("build",{priority:"low"})],{ownerUid:"owner-a"});
 assert.deepEqual(r.orderedTasks.map(x=>x.task_id),["docs","build","publish"]); assert.equal(r.diagnostics.executionPerformed,false);
});
test("does not trust unconfirmed dependency suggestions",()=>{
 const r=buildIntelligenceExecutionPlan([task("a",{depends_on_task_ids:["b"]}),task("b")],{ownerUid:"owner-a"});
 assert.deepEqual(r.orderedTasks.map(x=>x.task_id),["a","b"]); assert.equal(r.unresolvedTasks[0].reason,"dependencies_not_owner_confirmed");
});
test("holds tasks whose confirmed dependencies are incomplete",()=>{
 const r=buildIntelligenceExecutionPlan([task("deploy",{depends_on_task_ids:["test"],dependencies_confirmed:true,dependencies_confirmed_by:"owner-a"}),task("test",{task_state:"in_progress"})],{ownerUid:"owner-a"});
 assert.equal(r.orderedTasks.length,0); assert.deepEqual(r.blockedTasks[0].blocked_by,["test"]);
});
test("filters foreign, inactive, completed and sensitive records",()=>{
 const r=buildIntelligenceExecutionPlan([task("done",{task_state:"complete"}),task("foreign",{owner_uid:"owner-b"}),task("archived",{status:"archived"}),task("secret",{sensitivity:"credential"}),task("active")],{ownerUid:"owner-a"});
 assert.deepEqual(r.orderedTasks.map(x=>x.task_id),["active"]); assert.equal(r.diagnostics.completedTasksExcluded,1);
});
test("excludes health and identity classified tasks",()=>{
 const r=buildIntelligenceExecutionPlan([
  task("safe"),
  task("health",{sensitivity:"health"}),
  task("identity",{sensitivity:"identity"})
 ],{ownerUid:"owner-a"});
 assert.deepEqual(r.orderedTasks.map(x=>x.task_id),["safe"]);
});
test("reports missing dependencies and cycles without inventing an order",()=>{
 const r=buildIntelligenceExecutionPlan([task("a",{depends_on_task_ids:["missing"],dependencies_confirmed:true,dependencies_confirmed_by:"owner-a"}),task("b",{depends_on_task_ids:["c"],dependencies_confirmed:true,dependencies_confirmed_by:"owner-a"}),task("c",{depends_on_task_ids:["b"],dependencies_confirmed:true,dependencies_confirmed_by:"owner-a"})],{ownerUid:"owner-a"});
 assert.equal(r.orderedTasks.length,0); assert.equal(r.blockedTasks.find(x=>x.task_id==="a").reason,"dependency_missing_or_out_of_scope"); assert.equal(r.blockedTasks.find(x=>x.task_id==="b").reason,"dependency_not_complete_or_cycle");
});
test("is deterministic, bounded and read-only",()=>{
 const input=[task("z"),task("a"),task("b")],before=structuredClone(input),opts={ownerUid:"owner-a",maxTasks:2};
 const a=buildIntelligenceExecutionPlan(input,opts),b=buildIntelligenceExecutionPlan(input,opts);
 assert.deepEqual(a,b); assert.equal(a.diagnostics.omittedTasks,1); assert.deepEqual(input,before); assert.equal(a.diagnostics.advisoryOnly,true);
});
test("returns an empty safe plan without owner scope",()=>{const r=buildIntelligenceExecutionPlan([task("a")]);assert.equal(r.orderedTasks.length,0);assert.equal(r.diagnostics.executionPerformed,false);});


test("bounds raw task records before owner filtering",()=>{
 const records=Array.from({length:10000},(_,i)=>task("task-"+String(i).padStart(5,"0")));
 const r=buildIntelligenceExecutionPlan(records,{ownerUid:"owner-a",maxTasks:120});
 assert.equal(r.diagnostics.rawRecordsInspected,10000);
 assert.equal(r.diagnostics.rawRecordsOmitted,0);
 assert.equal(r.diagnostics.inspectedTasks,120);
 assert.equal(r.diagnostics.omittedTasks,9880);
 const oversized=[...records,...Array.from({length:25},(_,i)=>task("extra-"+i))];
 const capped=buildIntelligenceExecutionPlan(oversized,{ownerUid:"owner-a"});
 assert.equal(capped.diagnostics.rawRecordsInspected,10000);
 assert.equal(capped.diagnostics.rawRecordsOmitted,25);
});

test("caps nested dependency identifiers before normalization",()=>{
 const dependencies=Array.from({length:10000},(_,i)=>"dep-"+i);
 const r=buildIntelligenceExecutionPlan([
  task("build",{depends_on_task_ids:dependencies,dependencies_confirmed:true,dependencies_confirmed_by:"owner-a"})
 ],{ownerUid:"owner-a"});
 assert.equal(r.unresolvedTasks.length,0);
 assert.equal(r.blockedTasks[0].unresolved_dependencies.length,50);
 assert.equal(r.blockedTasks[0].unresolved_dependencies[0],"dep-0");
});
