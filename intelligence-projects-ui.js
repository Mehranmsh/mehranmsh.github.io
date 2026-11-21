(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const request=(path,options={})=>api(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
const modules=[["security","Security"],["intelligence","Intelligence"],["logistics","Logistics"],["customer_experience","Customer Experience"],["labs","Labs"],["governance","Governance"],["data","Data"],["robot_operations","Robot Operations"],["social","SOCIAL"],["music","Music"],["ai","AI"],["instruments","Instruments"],["robotics","Robotics"]];
const statuses=["planned","active","paused","completed","archived"];
let projects=[],tasks=[],selected=null,detail=null,dependencies={};
function note(message,kind=""){const el=$("intelProjectStatus");if(el){el.textContent=message;el.className="notice"+(kind?" "+kind:"");}}
function moduleName(key){return modules.find(x=>x[0]===key)?.[1]||key;}
function mount(){
 const page=$("page-intelligence");if(!page||$("intelProjectWorkspace"))return;
 const anchor=page.querySelector(".intelligence-tasks");
 const root=document.createElement("section");root.id="intelProjectWorkspace";root.className="panel";
 root.innerHTML=`
 <div class="section-title"><div><h2>Project Workspace</h2><div class="small-text">Create projects, organize tasks and track progress. All records are owner-scoped.</div></div><button class="btn secondary small" id="ipRefresh" type="button">Refresh</button></div>
 <form class="card" id="ipCreateForm" autocomplete="off">
  <h3>New project</h3>
  <div class="field"><label for="ipName">Project name</label><input id="ipName" maxlength="120" required placeholder="For example, SOCIAL platform"></div>
  <div class="field"><label for="ipDescription">Description</label><textarea id="ipDescription" rows="2" maxlength="3000" placeholder="Goal and expected outcome"></textarea></div>
  <div class="field"><label for="ipModule">Company module</label><select id="ipModule">${modules.map(([v,n])=>`<option value="${v}">${n}</option>`).join("")}</select></div>
  <button class="btn" id="ipCreate" type="submit">Create project</button>
 </form>
 <div id="intelProjectStatus" class="notice" aria-live="polite">Loading owner projects...</div>
 <form class="card" id="ipTaskForm" autocomplete="off">
  <h3>New task</h3>
  <div class="field"><label for="ipTaskTitle">Task title</label><input id="ipTaskTitle" maxlength="120" minlength="4" required placeholder="For example, review SOCIAL security"></div>
  <div class="field"><label for="ipTaskDescription">Description</label><textarea id="ipTaskDescription" rows="2" maxlength="3000" required placeholder="Describe the expected work"></textarea></div>
  <div class="grid">
   <div class="field"><label for="ipTaskAssignee">Assign to</label><select id="ipTaskAssignee"><option value="mehran_intelligence">MEHRAN Intelligence</option><option value="chatgpt">ChatGPT</option><option value="shared">Shared</option></select></div>
   <div class="field"><label for="ipTaskPriority">Priority</label><select id="ipTaskPriority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div>
  </div>
  <button class="btn" id="ipTaskCreate" type="submit">Create task</button>
  <div class="small-text">New tasks are records only. No external action or automated execution is started.</div>
 </form>
 <div class="grid" id="ipSummary" aria-live="polite"></div>
 <div class="grid" id="ipProjectList"></div>
 <div id="ipDetail" class="card" hidden></div>
 <p class="small-text">Project records and task assignments are private to the authenticated owner. Automated execution remains disabled; status changes do not execute external actions.</p>`;
 if(anchor)anchor.insertAdjacentElement("afterend",root);else page.append(root);
 $("ipRefresh").addEventListener("click",loadAll);
 $("refreshIntelligenceBtn")?.addEventListener("click",loadAll);
 $("refreshIntelTasksBtn")?.addEventListener("click",loadAll);
 $("ipCreateForm").addEventListener("submit",createProject);
 $("ipTaskForm").addEventListener("submit",createTask);
 $("ipProjectList").addEventListener("click",projectAction);
 $("ipDetail").addEventListener("click",detailAction);
 loadAll();
}
async function loadAll(){
 note("Loading projects and tasks...");
 try{
  const [p,t]=await Promise.all([request("/intelligence/projects?limit=100"),request("/intelligence/tasks")]);
  projects=Array.isArray(p.items)?p.items:[];tasks=Array.isArray(t.tasks)?t.tasks:[];
  renderProjects();
  if(selected&&projects.some(x=>x.id===selected))await openProject(selected);else{selected=null;detail=null;$("ipDetail").hidden=true;}
  note(projects.length+" projects loaded. "+tasks.length+" tasks available.", "success");
 }catch(e){note("Could not load project workspace: "+e.message,"warn");}
}
function renderProjects(){
 const host=$("ipProjectList"),summary=$("ipSummary");if(!host||!summary)return;
 const completed=tasks.filter(t=>t.status==="completed").length;
 const blocked=tasks.filter(t=>t.status==="blocked").length;
 const active=tasks.filter(t=>["accepted","in_progress"].includes(t.status)).length;
 summary.innerHTML=[
  ["Projects",projects.length],["Open tasks",tasks.filter(t=>!["completed","cancelled"].includes(t.status)).length],
  ["In progress",active],["Blocked",blocked],["Completed",completed]
 ].map(([label,value])=>`<article class="card"><div class="eyebrow">${esc(label)}</div><h3>${Number(value)||0}</h3></article>`).join("");
 if(!projects.length){host.innerHTML='<div class="empty">No Intelligence projects yet. Create the first one above.</div>';return;}
 host.innerHTML=projects.map(p=>{
  const total=Number(p.task_count)||0,done=Number(p.completed_task_count)||0;
  const percent=total?Math.round(done/total*100):0;
  return `<article class="card">
   <div class="eyebrow">${esc(moduleName(p.module_key))} · ${esc(p.status)}</div>
   <h3>${esc(p.name)}</h3><p>${esc(p.description||"No description")}</p>
   <div class="small-text">${done} / ${total} tasks completed · ${percent}%</div>
   <div class="progress-track" role="progressbar" aria-label="Project completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill" style="width:${percent}%"></div></div>
   <div class="hero-actions"><button class="btn small" data-ip-action="open" data-id="${esc(p.id)}" type="button">Open workspace</button></div>
  </article>`;
 }).join("");
}
async function createProject(event){
 event.preventDefault();const button=$("ipCreate");button.disabled=true;
 try{
  const result=await request("/intelligence/projects",{method:"POST",body:JSON.stringify({name:$("ipName").value,description:$("ipDescription").value,moduleKey:$("ipModule").value})});
  $("ipCreateForm").reset();note("Project created. Loading its workspace...","success");await loadAll();if(result.id)await openProject(result.id);
 }catch(e){note("Project could not be created: "+e.message,"warn");}
 finally{button.disabled=false;}
}
async function createTask(event){
 event.preventDefault();const button=$("ipTaskCreate");button.disabled=true;
 try{
  await request("/intelligence/tasks",{method:"POST",body:JSON.stringify({
   title:$("ipTaskTitle").value,description:$("ipTaskDescription").value,
   assignedTo:$("ipTaskAssignee").value,priority:$("ipTaskPriority").value,
   requiresApproval:false,actionType:""
  })});
  $("ipTaskForm").reset();note("Task created. You can attach it to a project from the project workspace.","success");
  await loadAll();
 }catch(e){note("Task could not be created: "+e.message,"warn");}
 finally{button.disabled=false;}
}
async function openProject(id){
 try{
  const data=await request("/intelligence/projects/"+encodeURIComponent(id));
  selected=id;detail=data;dependencies={};await Promise.all((data.tasks||[]).map(async task=>{try{const d=await request("/intelligence/tasks/"+encodeURIComponent(task.id)+"/dependencies");dependencies[task.id]=d.prerequisites||[];}catch(e){dependencies[task.id]=[];}}));renderDetail();
 }catch(e){note("Could not open project: "+e.message,"warn");}
}
function renderDetail(){
 const host=$("ipDetail");if(!host||!detail)return;
 const p=detail.project,attached=detail.tasks||[];
 const available=tasks.filter(t=>!t.projectId);
 host.hidden=false;
 host.innerHTML=`
 <div class="section-title"><div><div class="eyebrow">${esc(moduleName(p.module_key))}</div><h3>${esc(p.name)}</h3></div><button class="btn secondary small" data-ip-action="close" type="button">Close</button></div>
 <p>${esc(p.description||"No description")}</p>
 <div class="grid"><div class="field"><label for="ipStatus">Project status</label><select id="ipStatus">${statuses.map(s=>`<option value="${s}" ${p.status===s?"selected":""}>${s}</option>`).join("")}</select></div>
 <div class="field"><label for="ipAttachTask">Attach an unassigned task</label><select id="ipAttachTask"><option value="">Select a task</option>${available.map(t=>`<option value="${esc(t.id)}">${esc(t.title)} · ${esc(t.status)}</option>`).join("")}</select></div></div>
 <div class="hero-actions"><button class="btn secondary small" data-ip-action="save-status" type="button">Save project status</button><button class="btn small" data-ip-action="attach" type="button">Attach task</button></div>
 <h4>Project tasks</h4>
 <div class="grid">${attached.length?attached.map(t=>`<article class="card">
  <div class="eyebrow">${esc(t.priority)} · ${esc(t.status)} ${t.action_type?"· AUTOMATED ACTION":""}</div>
  <h4>${esc(t.title)}</h4><p>${esc(t.description||"")}</p>
  ${t.result_text?`<div class="small-text">Result: ${esc(t.result_text)}</div>`:""}
  <div class="field"><label>Blocked by</label>${(dependencies[t.id]||[]).length?(dependencies[t.id]||[]).map(d=>`<div class="small-text">${esc(d.title)} · ${esc(d.status)} <button class="btn secondary small" data-ip-action="remove-dependency" data-id="${esc(t.id)}" data-dependency-id="${esc(d.id)}" type="button">Remove link</button></div>`).join(""):'<div class="small-text">No prerequisites linked.</div>'}</div>
  ${attached.some(other=>other.id!==t.id)?`<div class="field"><label for="ipPrereq-${esc(t.id)}">Add prerequisite</label><select id="ipPrereq-${esc(t.id)}"><option value="">Choose a task that must finish first</option>${attached.filter(other=>other.id!==t.id&&!(dependencies[t.id]||[]).some(d=>d.taskId===other.id)).map(other=>`<option value="${esc(other.id)}">${esc(other.title)} · ${esc(other.status)}</option>`).join("")}</select><button class="btn secondary small" data-ip-action="add-dependency" data-id="${esc(t.id)}" type="button">Add dependency</button></div>`:""}
  ${!t.action_type?`<button class="btn secondary small" data-ip-action="task-status" data-id="${esc(t.id)}" data-status="${t.status==="completed"?"queued":"completed"}" type="button">${t.status==="completed"?"Reopen task":"Mark completed"}</button>`:"<div class='small-text'>Automated task status is controlled by its approval workflow.</div>"}
 </article>`).join(""):'<div class="empty">No tasks assigned to this project yet.</div>'}</div>
 <div class="small-text">Dependencies are project-scoped. The server rejects self-links, cross-project links and cycles. No task is executed by changing its status.</div>`;
}
async function projectAction(event){
 const b=event.target.closest("[data-ip-action]");if(!b)return;
 if(b.dataset.ipAction==="open")await openProject(b.dataset.id);
}
async function detailAction(event){
 const b=event.target.closest("[data-ip-action]");if(!b)return;
 const action=b.dataset.ipAction;
 try{
  if(action==="close"){selected=null;detail=null;$("ipDetail").hidden=true;return;}
  if(action==="save-status"){
   await request("/intelligence/projects/"+encodeURIComponent(selected),{method:"PUT",body:JSON.stringify({status:$("ipStatus").value})});
   await loadAll();await openProject(selected);note("Project status updated.","success");
  }else if(action==="attach"){
   const taskId=$("ipAttachTask").value;if(!taskId){note("Select a task first.","warn");return;}
   await request("/intelligence/tasks/"+encodeURIComponent(taskId)+"/project",{method:"PUT",body:JSON.stringify({projectId:selected})});
   await loadAll();await openProject(selected);note("Task attached to project.","success");
  }else if(action==="task-status"){
   await request("/intelligence/tasks/"+encodeURIComponent(b.dataset.id)+"/status",{method:"PUT",body:JSON.stringify({status:b.dataset.status})});
   await loadAll();await openProject(selected);note("Task status updated.","success");
  }else if(action==="add-dependency"){
   const taskId=b.dataset.id,prerequisiteId=$("ipPrereq-"+taskId)?.value;
   if(!prerequisiteId){note("Choose a prerequisite task first.","warn");return;}
   await request("/intelligence/tasks/"+encodeURIComponent(taskId)+"/dependencies",{method:"POST",body:JSON.stringify({dependsOnTaskId:prerequisiteId})});
   await openProject(selected);note("Task dependency added.","success");
  }else if(action==="remove-dependency"){
   await request("/intelligence/tasks/"+encodeURIComponent(b.dataset.id)+"/dependencies/"+encodeURIComponent(b.dataset.dependencyId),{method:"DELETE"});
   await openProject(selected);note("Task dependency removed.","success");
  }
 }catch(e){note("Action failed: "+e.message,"warn");}
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();