const MODULE_KEYS = new Set([
  "security","intelligence","logistics","customer_experience","labs",
  "governance","data","robot_operations","social","music","ai","instruments","robotics"
]);
const PROJECT_STATUSES = ["planned","active","paused","completed","archived"];

export async function handleProjectApi({request,env,owner,url,path,method,helpers}) {
  const {response,fail,readJson,clean,randomId,audit,uuid}=helpers;
  const projectMatch=path.match(/^\/intelligence\/projects\/([0-9a-f-]{36})$/i);
  const taskProjectMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/project$/i);
  const taskDepsMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/dependencies$/i);
  const depDeleteMatch=path.match(/^\/intelligence\/tasks\/([0-9a-f-]{36})\/dependencies\/([0-9a-f-]{36})$/i);

  if(path==="/intelligence/projects"&&method==="GET"){
    const status=clean(url.searchParams.get("status"),20);
    const moduleKey=clean(url.searchParams.get("moduleKey"),40);
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit"))||50));
    if(status&&!PROJECT_STATUSES.includes(status))return fail("Invalid project status filter.");
    if(moduleKey&&!MODULE_KEYS.has(moduleKey))return fail("Invalid project module filter.");
    const clauses=["p.owner_uid = ?"],binds=[owner.uid];
    if(status){clauses.push("p.status = ?");binds.push(status);}
    if(moduleKey){clauses.push("p.module_key = ?");binds.push(moduleKey);}
    binds.push(limit);
    const sql=[
      "SELECT p.id,p.name,p.description,p.module_key,p.status,p.created_at,p.updated_at,p.archived_at,",
      "(SELECT COUNT(*) FROM intelligence_tasks t WHERE t.project_id=p.id AND t.created_by=p.owner_uid) AS task_count,",
      "(SELECT COUNT(*) FROM intelligence_tasks t WHERE t.project_id=p.id AND t.created_by=p.owner_uid AND t.status='completed') AS completed_task_count,",
      "(SELECT COUNT(*) FROM intelligence_tasks t WHERE t.project_id=p.id AND t.created_by=p.owner_uid AND EXISTS (",
      "SELECT 1 FROM intelligence_task_dependencies d JOIN intelligence_tasks prerequisite ON prerequisite.id=d.depends_on_task_id",
      "WHERE d.owner_uid=p.owner_uid AND d.task_id=t.id AND prerequisite.status<>'completed')) AS blocked_task_count",
      "FROM intelligence_projects p WHERE "+clauses.join(" AND ")+" ORDER BY p.updated_at DESC,p.id ASC LIMIT ?"
    ].join(" ");
    const rows=await env.DB.prepare(sql).bind(...binds).all();
    return response({success:true,items:rows.results||[],limit,executionEnabled:false});
  }

  if(path==="/intelligence/projects"&&method==="POST"){
    const body=await readJson(request);
    if(!body||Object.keys(body).some(k=>!["name","description","moduleKey"].includes(k)))return fail("Invalid project payload.");
    const name=clean(body.name,120),description=clean(body.description,3000),moduleKey=clean(body.moduleKey,40);
    if(typeof body.name!=="string"||!name||body.name.length>120||
      (body.description!==undefined&&(typeof body.description!=="string"||body.description.length>3000))||
      !MODULE_KEYS.has(moduleKey))return fail("A valid project name and allowed module are required.");
    const id=randomId();
    try{
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_projects(id,owner_uid,name,description,module_key,status) VALUES(?,?,?,?,?,'planned')")
          .bind(id,owner.uid,name,description,moduleKey),
        audit(env.DB,owner.uid,"project_created","project",id,{moduleKey})
      ]);
    }catch{return fail("Project could not be created.",503);}
    return response({success:true,id,status:"planned",executionEnabled:false},201);
  }

  if(projectMatch&&method==="GET"){
    const id=projectMatch[1];
    const project=await env.DB.prepare("SELECT id,name,description,module_key,status,created_at,updated_at,archived_at FROM intelligence_projects WHERE id=? AND owner_uid=? LIMIT 1")
      .bind(id,owner.uid).first();
    if(!project)return fail("Project not found.",404);
    const tasks=await env.DB.prepare(
      "SELECT t.id,t.title,t.description,t.assigned_to,t.priority,t.status,t.requires_approval,t.created_at,t.updated_at,"+
      "(SELECT COUNT(*) FROM intelligence_task_dependencies d JOIN intelligence_tasks p ON p.id=d.depends_on_task_id "+
      "WHERE d.owner_uid=? AND d.task_id=t.id AND p.status<>'completed') AS open_prerequisite_count "+
      "FROM intelligence_tasks t WHERE t.created_by=? AND t.project_id=? ORDER BY t.created_at ASC,t.id ASC LIMIT 100"
    ).bind(owner.uid,owner.uid,id).all();
    return response({success:true,project,tasks:tasks.results||[],executionEnabled:false});
  }

  if(projectMatch&&method==="PUT"){
    const id=projectMatch[1],body=await readJson(request);
    const allowed=["name","description","moduleKey","status"];
    if(!body||!Object.keys(body).length||Object.keys(body).some(k=>!allowed.includes(k)))return fail("Invalid project update.");
    const sets=[],values=[],changed=[];
    if(Object.hasOwn(body,"name")){
      const v=clean(body.name,120);
      if(typeof body.name!=="string"||!v||body.name.length>120)return fail("Invalid project name.");
      sets.push("name=?");values.push(v);changed.push("name");
    }
    if(Object.hasOwn(body,"description")){
      if(typeof body.description!=="string"||body.description.length>3000)return fail("Invalid project description.");
      sets.push("description=?");values.push(clean(body.description,3000));changed.push("description");
    }
    if(Object.hasOwn(body,"moduleKey")){
      const v=clean(body.moduleKey,40);
      if(!MODULE_KEYS.has(v))return fail("Invalid project module.");
      sets.push("module_key=?");values.push(v);changed.push("moduleKey");
    }
    if(Object.hasOwn(body,"status")){
      if(!PROJECT_STATUSES.includes(body.status))return fail("Invalid project status.");
      sets.push("status=?");values.push(body.status);changed.push("status");
    }
    const existing=await env.DB.prepare("SELECT id,status FROM intelligence_projects WHERE id=? AND owner_uid=?").bind(id,owner.uid).first();
    if(!existing)return fail("Project not found.",404);
    sets.push("updated_at=CURRENT_TIMESTAMP");values.push(id,owner.uid);
    const action=body.status==="archived"?"project_archived":
      (existing.status==="archived"&&body.status&&body.status!=="archived"?"project_restored":"project_updated");
    try{
      const results=await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_projects SET "+sets.join(",")+" WHERE id=? AND owner_uid=?").bind(...values),
        env.DB.prepare("INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at) "+
          "SELECT ?,?,?,?,?,?,? WHERE changes()=1")
          .bind(randomId(),owner.uid,action,"project",id,JSON.stringify({fields:changed}),Math.floor(Date.now()/1000))
      ]);
      if(!Number(results?.[0]?.meta?.changes||0))return fail("Project not found.",404);
    }catch{return fail("Project update violates a project or task constraint.",409);}
    return response({success:true,id,status:body.status||existing.status});
  }

  if(taskProjectMatch&&method==="PUT"){
    const taskId=taskProjectMatch[1],body=await readJson(request);
    if(!body||Object.keys(body).some(k=>k!=="projectId")||!Object.hasOwn(body,"projectId"))return fail("A projectId string or null is required.");
    const projectId=body.projectId;
    if(projectId!==null&&!uuid(projectId))return fail("Invalid project ID.");
    const task=await env.DB.prepare("SELECT id,project_id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(taskId,owner.uid).first();
    if(!task)return fail("Task not found.",404);
    if(task.project_id===projectId)return response({success:true,unchanged:true,projectId});
    if(projectId!==null){
      const project=await env.DB.prepare("SELECT id FROM intelligence_projects WHERE id=? AND owner_uid=?").bind(projectId,owner.uid).first();
      if(!project)return fail("Project not found.",404);
    }
    try{
      await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_tasks SET project_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=?")
          .bind(projectId,taskId,owner.uid),
        audit(env.DB,owner.uid,projectId?"task_project_assigned":"task_project_unassigned","task",taskId,{projectId})
      ]);
    }catch{return fail("Task project assignment violates a dependency or project constraint.",409);}
    return response({success:true,taskId,projectId});
  }

  if(taskDepsMatch&&method==="GET"){
    const taskId=taskDepsMatch[1];
    const task=await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(taskId,owner.uid).first();
    if(!task)return fail("Task not found.",404);
    const [prerequisites,dependents]=await Promise.all([
      env.DB.prepare("SELECT d.id,d.depends_on_task_id AS taskId,t.title,t.status,d.dependency_type,d.created_at "+
        "FROM intelligence_task_dependencies d JOIN intelligence_tasks t ON t.id=d.depends_on_task_id AND t.created_by=d.owner_uid "+
        "WHERE d.owner_uid=? AND d.task_id=? ORDER BY d.created_at,d.id LIMIT 100").bind(owner.uid,taskId).all(),
      env.DB.prepare("SELECT d.id,d.task_id AS taskId,t.title,t.status,d.dependency_type,d.created_at "+
        "FROM intelligence_task_dependencies d JOIN intelligence_tasks t ON t.id=d.task_id AND t.created_by=d.owner_uid "+
        "WHERE d.owner_uid=? AND d.depends_on_task_id=? ORDER BY d.created_at,d.id LIMIT 100").bind(owner.uid,taskId).all()
    ]);
    return response({success:true,prerequisites:prerequisites.results||[],dependents:dependents.results||[]});
  }

  if(taskDepsMatch&&method==="POST"){
    const taskId=taskDepsMatch[1],body=await readJson(request);
    if(!body||Object.keys(body).some(k=>k!=="dependsOnTaskId")||!uuid(body.dependsOnTaskId))return fail("A valid dependsOnTaskId is required.");
    if(taskId===body.dependsOnTaskId)return fail("A task cannot depend on itself.");
    const task=await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(taskId,owner.uid).first();
    if(!task)return fail("Task not found.",404);
    const prerequisite=await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(body.dependsOnTaskId,owner.uid).first();
    if(!prerequisite)return fail("Prerequisite task not found.",404);
    const id=randomId();
    try{
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_task_dependencies(id,owner_uid,task_id,depends_on_task_id,dependency_type) VALUES(?,?,?,?,'blocks')")
          .bind(id,owner.uid,taskId,body.dependsOnTaskId),
        audit(env.DB,owner.uid,"task_dependency_added","task_dependency",id,{taskId,dependsOnTaskId:body.dependsOnTaskId})
      ]);
    }catch{return fail("Dependency conflicts with an existing edge or project constraint.",409);}
    return response({success:true,id,taskId,dependsOnTaskId:body.dependsOnTaskId},201);
  }

  if(depDeleteMatch&&method==="DELETE"){
    const taskId=depDeleteMatch[1],dependencyId=depDeleteMatch[2];
    try{
      const results=await env.DB.batch([
        env.DB.prepare("DELETE FROM intelligence_task_dependencies WHERE id=? AND task_id=? AND owner_uid=?")
          .bind(dependencyId,taskId,owner.uid),
        env.DB.prepare("INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at) "+
          "SELECT ?,?,?,?,?,?,? WHERE changes()=1")
          .bind(randomId(),owner.uid,"task_dependency_removed","task_dependency",dependencyId,JSON.stringify({taskId}),Math.floor(Date.now()/1000))
      ]);
      if(!Number(results?.[0]?.meta?.changes||0))return fail("Dependency not found.",404);
    }catch{return fail("Dependency could not be removed.",503);}
    return response({success:true,id:dependencyId,deleted:true});
  }
  return null;
}
