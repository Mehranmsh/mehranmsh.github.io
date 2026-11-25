const MAX_TASKS = 300;
const SENSITIVE = new Set(["secret","credential","wallet","financial","private_social"]);
const DONE = new Set(["done","complete","completed"]);
const INACTIVE = new Set(["deleted","archived","cancelled","canceled"]);
const clean = (v,n=160) => typeof v === "string" ? v.trim().slice(0,n) : "";
const score = v => ({critical:4,urgent:4,high:3,medium:2,normal:2,low:1})[String(v||"").toLowerCase()] || 0;
const date = v => { if(typeof v!=="string"||!v.trim()) return null; const n=Date.parse(v); return Number.isFinite(n)?n:null; };

/** Deterministic owner-scoped advisory planner. Never executes tasks or mutates input. */
export function buildIntelligenceExecutionPlan(records, options={}) {
  const owner=clean(options.ownerUid), limit=Number.isInteger(options.maxTasks)&&options.maxTasks>0?Math.min(options.maxTasks,MAX_TASKS):100;
  const empty={orderedTasks:[],blockedTasks:[],unresolvedTasks:[],diagnostics:{inspectedTasks:0,omittedTasks:0,completedTasksExcluded:0,advisoryOnly:true,executionPerformed:false}};
  if(!owner||!Array.isArray(records)) return empty;
  const eligible=records.filter(r=>r&&typeof r==="object"&&!Array.isArray(r)&&clean(r.owner_uid)===owner&&!r.deleted_at&&(!r.status||!INACTIVE.has(String(r.status).toLowerCase()))&&!SENSITIVE.has(String(r.sensitivity||"").toLowerCase())&&(String(r.memory_type||r.type||"").toLowerCase()==="task"||typeof r.task_id==="string"));
  const all=[...new Map(eligible.map(r=>[clean(r.task_id||r.memory_key),r]).filter(([id])=>id)).entries()].sort(([a],[b])=>a.localeCompare(b));
  const tasks=new Map(all.slice(0,limit)), done=new Set([...tasks].filter(([,r])=>DONE.has(String(r.task_state||r.state||r.status||"").toLowerCase())).map(([id])=>id));
  const pending=new Set([...tasks.keys()].filter(id=>!done.has(id))), deps=new Map(), unresolved=[];
  for(const [id,r] of tasks) {
    if(!pending.has(id)) continue;
    const raw=r.depends_on_task_ids, list=[...new Set((Array.isArray(raw)?raw:typeof raw==="string"?[raw]:[]).map(v=>clean(v)).filter(Boolean))].sort();
    const trusted=r.dependencies_confirmed===true&&r.dependencies_confirmed_by===owner;
    deps.set(id,trusted?list:[]);
    if(list.length&&!trusted) unresolved.push({task_id:id,reason:"dependencies_not_owner_confirmed",suggested_dependencies:list,advisory:"confirmation_required"});
  }
  const status=id=>{const d=deps.get(id)||[];return {missing:d.filter(x=>!tasks.has(x)),unfinished:d.filter(x=>tasks.has(x)&&!done.has(x))};};
  const orderedTasks=[], blockedTasks=[];
  while(pending.size) {
    const ready=[...pending].filter(id=>{const s=status(id);return !s.missing.length&&!s.unfinished.length;}).sort((a,b)=>{
      const x=tasks.get(a),y=tasks.get(b),p=score(y.priority)-score(x.priority);
      return p||(date(x.due_at)??Number.MAX_SAFE_INTEGER)-(date(y.due_at)??Number.MAX_SAFE_INTEGER)||a.localeCompare(b);
    });
    if(!ready.length) break;
    for(const id of ready) if(pending.delete(id)) {
      const r=tasks.get(id),due=date(r.due_at);
      orderedTasks.push({task_id:id,title:clean(r.title||r.label||id,200),priority:clean(r.priority,24)||"unspecified",estimate_minutes:Number.isFinite(r.estimate_minutes)&&r.estimate_minutes>=0?Math.min(Math.floor(r.estimate_minutes),100000):null,due_at:due===null?null:new Date(due).toISOString(),rationale:"dependencies_explicitly_satisfied",advisory:true});
    }
  }
  for(const id of [...pending].sort()) {const s=status(id);blockedTasks.push({task_id:id,blocked_by:s.unfinished,unresolved_dependencies:s.missing,reason:s.missing.length?"dependency_missing_or_out_of_scope":"dependency_not_complete_or_cycle",advisory:true});}
  return {orderedTasks,blockedTasks,unresolvedTasks:unresolved,diagnostics:{inspectedTasks:tasks.size,omittedTasks:Math.max(0,all.length-tasks.size),completedTasksExcluded:done.size,advisoryOnly:true,executionPerformed:false}};
}
