const MODULE_KEYS = new Set([
  "security","intelligence","logistics","customer_experience","labs","governance",
  "data","robot_operations","social","music","ai","instruments","robotics"
]);
const PROJECT_STATUSES = ["planned","active","paused","completed","archived"];
const TASK_STATUSES = ["queued","accepted","in_progress","blocked","awaiting_approval","completed","cancelled"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const clean = (value, max) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
const reply = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}
});
const fail = (message,status=400) => reply({success:false,error:message},status);

async function bodyOf(request) {
  try {
    const length=Number(request.headers.get("Content-Length")||0);
    if(length>20000 || !request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) return null;
    const value=await request.json();
    return value && typeof value==="object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export async function handleProductionIntelligenceProjectApi({request,env,admin,url,path,method}) {
  const projectMatch=path.match(/^\/intelligence\/projects\/([0-9a-f-]{36})$/i);
  const taskProjectMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/project$/i);
  const taskStatusMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/status$/i);
  const depsMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/dependencies$/i);
  const depDeleteMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/dependencies\/([0-9a-f-]{36})$/i);
  const ownerUid=admin.uid;
  const audit=async(action,type,id,details={})=>{
    await env.DB.prepare(
      "INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)"
    ).bind(crypto.randomUUID(),admin.uid,admin.username,action,type,id,JSON.stringify(details)).run();
  };

  if(path==="/intelligence/projects" && method==="GET"){
    const status=url.searchParams.get("status")||"", moduleKey=url.searchParams.get("moduleKey")||"";
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit"))||50));
    if(status&&!PROJECT_STATUSES.includes(status)) return fail("Invalid project status filter.");
    if(moduleKey&&!MODULE_KEYS.has(moduleKey)) return fail("Invalid project module filter.");
    const clauses=["p.owner_uid=?"],binds=[ownerUid];
    if(status){clauses.push("p.status=?");binds.push(status);}
    if(moduleKey){clauses.push("p.module_key=?");binds.push(moduleKey);}
    binds.push(limit);
    const rows=await env.DB.prepare(
      "SELECT p.id,p.name,p.description,p.module_key,p.status,p.created_at,p.updated_at,p.archived_at,"+
      "(SELECT COUNT(*) FROM intelligence_tasks t WHERE t.project_id=p.id AND t.owner_uid=p.owner_uid) task_count,"+
      "(SELECT COUNT(*) FROM intelligence_tasks t WHERE t.project_id=p.id AND t.owner_uid=p.owner_uid AND t.status='completed') completed_task_count "+
      "FROM intelligence_projects p WHERE "+clauses.join(" AND ")+" ORDER BY p.updated_at DESC LIMIT ?"
    ).bind(...binds).all();
    return reply({success:true,items:rows.results||[],limit,executionEnabled:false});
  }

  if(path==="/intelligence/projects" && method==="POST"){
    const body=await bodyOf(request);
    if(!body||Object.keys(body).some(k=>!["name","description","moduleKey"].includes(k))) return fail("Invalid project payload.");
    const name=clean(body.name,120), description=clean(body.description,3000), moduleKey=clean(body.moduleKey,40);
    if(typeof body.name!=="string"||!name||body.name.length>120||
      (body.description!==undefined&&(typeof body.description!=="string"||body.description.length>3000))||
      !MODULE_KEYS.has(moduleKey)) return fail("A valid project name and module are required.");
    const id=crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_projects(id,owner_uid,name,description,module_key,status) VALUES(?,?,?,?,?,'planned')")
          .bind(id,ownerUid,name,description,moduleKey),
        env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(crypto.randomUUID(),admin.uid,admin.username,"project_created","intelligence_project",id,JSON.stringify({moduleKey}))
      ]);
    } catch { return fail("Project could not be created. Check that the production migration is installed.",503); }
    return reply({success:true,id,status:"planned",executionEnabled:false},201);
  }

  if(projectMatch && method==="GET"){
    const id=projectMatch[1];
    const project=await env.DB.prepare("SELECT id,name,description,module_key,status,created_at,updated_at,archived_at FROM intelligence_projects WHERE id=? AND owner_uid=?")
      .bind(id,ownerUid).first();
    if(!project) return fail("Project not found.",404);
    const tasks=await env.DB.prepare(
      "SELECT t.id,t.title,t.description,t.assigned_to,t.priority,t.status,t.requires_approval,t.created_at,t.updated_at "+
      "FROM intelligence_tasks t WHERE t.owner_uid=? AND t.project_id=? ORDER BY t.created_at ASC LIMIT 100"
    ).bind(ownerUid,id).all();
    return reply({success:true,project,tasks:tasks.results||[],executionEnabled:false});
  }

  if(projectMatch && method==="PUT"){
    const id=projectMatch[1], body=await bodyOf(request);
    const allowed=["name","description","moduleKey","status"];
    if(!body||!Object.keys(body).length||Object.keys(body).some(k=>!allowed.includes(k))) return fail("Invalid project update.");
    const sets=[],values=[],changed=[];
    if(Object.hasOwn(body,"name")){const v=clean(body.name,120);if(typeof body.name!=="string"||!v||body.name.length>120)return fail("Invalid project name.");sets.push("name=?");values.push(v);changed.push("name");}
    if(Object.hasOwn(body,"description")){if(typeof body.description!=="string"||body.description.length>3000)return fail("Invalid description.");sets.push("description=?");values.push(clean(body.description,3000));changed.push("description");}
    if(Object.hasOwn(body,"moduleKey")){const v=clean(body.moduleKey,40);if(!MODULE_KEYS.has(v))return fail("Invalid module.");sets.push("module_key=?");values.push(v);changed.push("moduleKey");}
    if(Object.hasOwn(body,"status")){if(!PROJECT_STATUSES.includes(body.status))return fail("Invalid project status.");sets.push("status=?");values.push(body.status);sets.push(body.status==="archived"?"archived_at=CURRENT_TIMESTAMP":"archived_at=NULL");changed.push("status");}
    const exists=await env.DB.prepare("SELECT id FROM intelligence_projects WHERE id=? AND owner_uid=?").bind(id,ownerUid).first();
    if(!exists)return fail("Project not found.",404);
    sets.push("updated_at=CURRENT_TIMESTAMP");values.push(id,ownerUid);
    try{
      await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_projects SET "+sets.join(",")+" WHERE id=? AND owner_uid=?").bind(...values),
        env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(crypto.randomUUID(),admin.uid,admin.username,"project_updated","intelligence_project",id,JSON.stringify({fields:changed}))
      ]);
    } catch{return fail("Project update or its audit record could not be committed.",409);}
    return reply({success:true,id});
  }

  if(taskProjectMatch && method==="PUT"){
    const taskId=taskProjectMatch[1],body=await bodyOf(request);
    if(!body||Object.keys(body).length!==1||!Object.hasOwn(body,"projectId"))return fail("A projectId or null is required.");
    const projectId=body.projectId;
    if(projectId!==null&&(typeof projectId!=="string"||!uuidPattern.test(projectId)))return fail("Invalid project ID.");
    const task=await env.DB.prepare("SELECT id,project_id FROM intelligence_tasks WHERE id=? AND owner_uid=?").bind(taskId,ownerUid).first();
    if(!task)return fail("Task not found.",404);
    if(projectId!==null&&!await env.DB.prepare("SELECT id FROM intelligence_projects WHERE id=? AND owner_uid=?").bind(projectId,ownerUid).first())return fail("Project not found.",404);
    try{
      await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_tasks SET project_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=?").bind(projectId,taskId,ownerUid),
        env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(crypto.randomUUID(),admin.uid,admin.username,"task_project_changed","intelligence_task",taskId,JSON.stringify({projectId}))
      ]);
    } catch{return fail("Task project assignment or its audit record could not be committed.",409);}
    return reply({success:true,taskId,projectId});
  }

  if(taskStatusMatch && method==="PUT"){
    const taskId=taskStatusMatch[1],body=await bodyOf(request);
    if(!body||Object.keys(body).some(k=>!["status","result"].includes(k))||!["completed","queued","cancelled"].includes(body.status))return fail("Only manual completion, reopening, or cancellation is allowed.");
    if(body.result!==undefined&&(typeof body.result!=="string"||body.result.length>3000))return fail("Invalid task result.");
    const task=await env.DB.prepare("SELECT id,status,action_type FROM intelligence_tasks WHERE id=? AND owner_uid=?").bind(taskId,ownerUid).first();
    if(!task)return fail("Task not found.",404);
    if(task.action_type)return fail("Automated task approval and execution remain controlled by the existing approval flow.",409);
    try{
      await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_tasks SET status=?,result_text=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=?")
          .bind(body.status,clean(body.result||"",3000),taskId,ownerUid),
        env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(crypto.randomUUID(),admin.uid,admin.username,"task_status_changed","intelligence_task",taskId,JSON.stringify({status:body.status}))
      ]);
    } catch{return fail("Task status or its audit record could not be committed.",409);}
    return reply({success:true,id:taskId,status:body.status,executionEnabled:false});
  }

  if(depsMatch && method==="GET"){
    const taskId=depsMatch[1];
    const task=await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND owner_uid=?").bind(taskId,ownerUid).first();
    if(!task)return fail("Task not found.",404);
    const [prerequisites,dependents]=await Promise.all([
      env.DB.prepare("SELECT d.id,d.depends_on_task_id taskId,t.title,t.status,d.created_at FROM intelligence_task_dependencies d JOIN intelligence_tasks t ON t.id=d.depends_on_task_id AND t.owner_uid=d.owner_uid WHERE d.owner_uid=? AND d.task_id=? ORDER BY d.created_at LIMIT 100").bind(ownerUid,taskId).all(),
      env.DB.prepare("SELECT d.id,d.task_id taskId,t.title,t.status,d.created_at FROM intelligence_task_dependencies d JOIN intelligence_tasks t ON t.id=d.task_id AND t.owner_uid=d.owner_uid WHERE d.owner_uid=? AND d.depends_on_task_id=? ORDER BY d.created_at LIMIT 100").bind(ownerUid,taskId).all()
    ]);
    return reply({success:true,prerequisites:prerequisites.results||[],dependents:dependents.results||[]});
  }

  if(depsMatch && method==="POST"){
    const taskId=depsMatch[1],body=await bodyOf(request);
    if(!body||Object.keys(body).length!==1||typeof body.dependsOnTaskId!=="string"||!uuidPattern.test(body.dependsOnTaskId))return fail("A valid dependsOnTaskId is required.");
    if(taskId===body.dependsOnTaskId)return fail("A task cannot depend on itself.");
    const [task,prerequisite]=await Promise.all([
      env.DB.prepare("SELECT id,project_id FROM intelligence_tasks WHERE id=? AND owner_uid=?").bind(taskId,ownerUid).first(),
      env.DB.prepare("SELECT id,project_id FROM intelligence_tasks WHERE id=? AND owner_uid=?").bind(body.dependsOnTaskId,ownerUid).first()
    ]);
    if(!task||!prerequisite)return fail("Task or prerequisite not found.",404);
    if((task.project_id||"")!==(prerequisite.project_id||""))return fail("Tasks must belong to the same project before linking.",409);
    const id=crypto.randomUUID();
    try{await env.DB.batch([
      env.DB.prepare("INSERT INTO intelligence_task_dependencies(id,owner_uid,task_id,depends_on_task_id,dependency_type) VALUES(?,?,?,?,'blocks')").bind(id,ownerUid,taskId,body.dependsOnTaskId),
      env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),admin.uid,admin.username,"task_dependency_added","intelligence_task_dependency",id,JSON.stringify({taskId,dependsOnTaskId:body.dependsOnTaskId}))
    ]);}catch{return fail("Dependency conflicts with an existing edge, cycle, or task constraint.",409);}
    return reply({success:true,id,taskId,dependsOnTaskId:body.dependsOnTaskId},201);
  }

  if(depDeleteMatch && method==="DELETE"){
    const taskId=depDeleteMatch[1],dependencyId=depDeleteMatch[2];
    try{
      const result=await env.DB.prepare("DELETE FROM intelligence_task_dependencies WHERE id=? AND task_id=? AND owner_uid=?").bind(dependencyId,taskId,ownerUid).run();
      if(!Number(result.meta?.changes||0))return fail("Dependency not found.",404);
      await audit("task_dependency_removed","intelligence_task_dependency",dependencyId,{taskId});
    }catch{return fail("Dependency could not be removed.",503);}
    return reply({success:true,id:dependencyId,deleted:true});
  }
  return null;
}
