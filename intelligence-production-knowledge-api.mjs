const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean=(v,max)=>typeof v==="string"?v.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max):"";
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
  "Content-Type":"application/json; charset=utf-8",
  "Access-Control-Allow-Origin":"https://mehranmsh.github.io",
  "Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type, Authorization",
  "Vary":"Origin",
  "Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer",
  "X-Frame-Options":"DENY"
}});
const fail=(message,status=400)=>reply({success:false,error:message},status);
async function readBody(request){
  try{
    const type=(request.headers.get("Content-Type")||"").split(";")[0].trim().toLowerCase();
    const length=Number(request.headers.get("Content-Length")||0);
    if(type!=="application/json"||!Number.isFinite(length)||length>20000||!request.body)return null;
    const reader=request.body.getReader(),chunks=[];
    let total=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>20000){await reader.cancel();return null;}
      chunks.push(value);
    }
    const bytes=new Uint8Array(total);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const value=JSON.parse(new TextDecoder().decode(bytes));
    return value&&typeof value==="object"&&!Array.isArray(value)?value:null;
  }catch{return null;}
}
async function audit(env,admin,action,type,id,details={}){
  return env.DB.prepare("INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details) SELECT ?,?,?,?,?,?,? WHERE changes()>0")
    .bind(crypto.randomUUID(),admin.uid,admin.username,action,type,id,JSON.stringify(details).slice(0,1000));
}
export async function handleProductionIntelligenceKnowledgeApi({request,env,admin,url,path,method}){
  const owner=admin.uid;
  if(path==="/intelligence/knowledge"&&method==="GET"){
    const state=url.searchParams.get("state")||"active";
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit"))||50));
    if(!["active","archived","all"].includes(state))return fail("Invalid knowledge state.");
    const rows=await env.DB.prepare("SELECT id,category,title,content,importance,source_type,source_ref,source_title,source_excerpt,observed_at,recorded_confidence,verification_status,reviewed_at,created_at,updated_at,archived_at FROM intelligence_knowledge WHERE owner_uid=? AND (?='all' OR (?='archived' AND archived_at IS NOT NULL) OR (?='active' AND archived_at IS NULL)) ORDER BY updated_at DESC LIMIT ?")
      .bind(owner,state,state,state,limit).all();
    return reply({success:true,items:rows.results||[],limit});
  }
  if(path==="/intelligence/knowledge"&&method==="POST"){
    const b=await readBody(request);
    const allowed=["category","title","content","importance","sourceType","sourceRef","sourceTitle","sourceExcerpt","observedAt","recordedConfidence"];
    if(!b||Object.keys(b).some(k=>!allowed.includes(k)))return fail("Invalid knowledge payload.");
    const title=clean(b.title,160),content=clean(b.content,12000),category=clean(b.category||"company",40),importance=b.importance||"normal";
    const sourceType=b.sourceType||"owner_input",sourceRef=clean(b.sourceRef||"",1000),sourceTitle=clean(b.sourceTitle||"",200),sourceExcerpt=clean(b.sourceExcerpt||"",1000);
    const observedAt=b.observedAt||null,confidence=b.recordedConfidence===undefined?null:b.recordedConfidence;
    if(!title||!content||!["high","normal","low"].includes(importance)||!["owner_input","uploaded_document","external_url","system_observation"].includes(sourceType))return fail("Title, content, importance or source type is invalid.");
    if(b.sourceRef!==undefined&&typeof b.sourceRef!=="string"||b.sourceTitle!==undefined&&typeof b.sourceTitle!=="string"||b.sourceExcerpt!==undefined&&typeof b.sourceExcerpt!=="string")return fail("Invalid source metadata.");
    if(sourceType==="external_url"){try{const u=new URL(sourceRef);if(u.protocol!=="https:"||!u.hostname||u.username||u.password)return fail("Only public HTTPS source references are accepted.");}catch{return fail("Invalid source URL.");}}
    if(observedAt!==null&&(typeof observedAt!=="string"||!Number.isFinite(Date.parse(observedAt))))return fail("Invalid observation date.");
    if(confidence!==null&&(!Number.isInteger(confidence)||confidence<0||confidence>100))return fail("Recorded confidence must be between 0 and 100.");
    const id=crypto.randomUUID();
    try{await env.DB.batch([
      env.DB.prepare("INSERT INTO intelligence_knowledge(id,owner_uid,category,title,content,importance,source_type,source_ref,source_title,source_excerpt,observed_at,recorded_confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,owner,category,title,content,importance,sourceType,sourceRef,sourceTitle,sourceExcerpt,observedAt,confidence),
      audit(env,admin,"intelligence_knowledge_created","intelligence_knowledge",id,{sourceType,category})
    ]);}catch{return fail("Knowledge could not be saved. Confirm migration 0002 is installed.",503);}
    return reply({success:true,id,verificationStatus:"unreviewed"},201);
  }
  const knowledgeMatch=path.match(/^\/intelligence\/knowledge\/([0-9a-f-]{36})$/i);
  if(knowledgeMatch&&(method==="PUT"||method==="DELETE")){
    const id=knowledgeMatch[1];
    if(!uuidPattern.test(id))return fail("Invalid record ID.");
    const existing=await env.DB.prepare("SELECT id FROM intelligence_knowledge WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(id,owner).first();
    if(!existing)return fail("Knowledge record not found.",404);
    if(method==="DELETE"){
      try{await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(id,owner),
        audit(env,admin,"intelligence_knowledge_archived","intelligence_knowledge",id)
      ]);}catch{return fail("Knowledge archive failed.",503);}
      return reply({success:true,id,archived:true});
    }
    const b=await readBody(request);
    if(!b||Object.keys(b).some(k=>!["action","category","title","content","importance"].includes(k)))return fail("Invalid knowledge update.");
    const action=b.action||"update";
    if(action==="verify"||action==="dispute"||action==="unverify"){
      if(Object.keys(b).length!==1)return fail("Review actions accept no additional fields.");
      const status=({verify:"owner_verified",dispute:"disputed",unverify:"unreviewed"})[action];
      try{await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_knowledge SET verification_status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(status,admin.uid,id,owner),
        audit(env,admin,"intelligence_knowledge_"+action,"intelligence_knowledge",id,{verificationStatus:status})
      ]);}catch{return fail("Knowledge review failed.",503);}
      return reply({success:true,id,verificationStatus:status});
    }
    if(action!=="update")return fail("Unsupported knowledge action.");
    const sets=[],vals=[],fields=[];
    if(Object.hasOwn(b,"title")){const v=clean(b.title,160);if(!v||typeof b.title!=="string")return fail("Invalid title.");sets.push("title=?");vals.push(v);fields.push("title");}
    if(Object.hasOwn(b,"content")){const v=clean(b.content,12000);if(!v||typeof b.content!=="string")return fail("Invalid content.");sets.push("content=?");vals.push(v);fields.push("content");}
    if(Object.hasOwn(b,"category")){const v=clean(b.category,40);if(!v)return fail("Invalid category.");sets.push("category=?");vals.push(v);fields.push("category");}
    if(Object.hasOwn(b,"importance")){if(!["high","normal","low"].includes(b.importance))return fail("Invalid importance.");sets.push("importance=?");vals.push(b.importance);fields.push("importance");}
    if(!sets.length)return fail("No editable fields supplied.");
    sets.push("updated_at=CURRENT_TIMESTAMP");vals.push(id,owner);
    try{await env.DB.batch([
      env.DB.prepare("UPDATE intelligence_knowledge SET "+sets.join(",")+" WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(...vals),
      audit(env,admin,"intelligence_knowledge_updated","intelligence_knowledge",id,{fields})
    ]);}catch{return fail("Knowledge update failed.",503);}
    return reply({success:true,id});
  }
  if(path==="/intelligence/memory"&&method==="GET"){
    const rows=await env.DB.prepare("SELECT id,memory_type,category,content,importance,created_at,updated_at FROM intelligence_owner_memory WHERE owner_uid=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(owner).all();
    return reply({success:true,items:rows.results||[]});
  }
  if(path==="/intelligence/memory"&&method==="POST"){
    const b=await readBody(request);
    if(!b||Object.keys(b).some(k=>!["memoryType","category","content","importance"].includes(k)))return fail("Invalid memory payload.");
    const type=b.memoryType||"fact",category=clean(b.category||"general",40),content=clean(b.content,4000),importance=b.importance||"normal";
    if(!["fact","preference","instruction","project_decision"].includes(type)||!category||!content||typeof b.content!=="string"||b.content.length>4000||!["high","normal","low"].includes(importance))return fail("Memory type, category, content or importance is invalid.");
    const id=crypto.randomUUID();
    try{await env.DB.batch([
      env.DB.prepare("INSERT INTO intelligence_owner_memory(id,owner_uid,memory_type,category,content,importance) VALUES(?,?,?,?,?,?)").bind(id,owner,type,category,content,importance),
      audit(env,admin,"intelligence_memory_created","intelligence_owner_memory",id,{memoryType:type,category})
    ]);}catch{return fail("Memory could not be saved. Confirm migration 0002 is installed.",503);}
    return reply({success:true,id},201);
  }
  const memoryMatch=path.match(/^\/intelligence\/memory\/([0-9a-f-]{36})$/i);
  if(memoryMatch&&(method==="PUT"||method==="DELETE")){
    const id=memoryMatch[1];
    if(!uuidPattern.test(id))return fail("Invalid memory ID.");
    const existing=await env.DB.prepare("SELECT id FROM intelligence_owner_memory WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(id,owner).first();
    if(!existing)return fail("Memory record not found.",404);
    if(method==="DELETE"){
      try{await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_owner_memory SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(id,owner),
        audit(env,admin,"intelligence_memory_archived","intelligence_owner_memory",id)
      ]);}catch{return fail("Memory archive failed.",503);}
      return reply({success:true,id,archived:true});
    }
    const b=await readBody(request);
    if(!b||Object.keys(b).some(k=>!["memoryType","category","content","importance"].includes(k))||!Object.keys(b).length)return fail("Invalid memory update.");
    const sets=[],vals=[];
    if(Object.hasOwn(b,"memoryType")){if(!["fact","preference","instruction","project_decision"].includes(b.memoryType))return fail("Invalid memory type.");sets.push("memory_type=?");vals.push(b.memoryType);}
    if(Object.hasOwn(b,"category")){const v=clean(b.category,40);if(!v)return fail("Invalid category.");sets.push("category=?");vals.push(v);}
    if(Object.hasOwn(b,"content")){const v=clean(b.content,4000);if(!v||typeof b.content!=="string")return fail("Invalid content.");sets.push("content=?");vals.push(v);}
    if(Object.hasOwn(b,"importance")){if(!["high","normal","low"].includes(b.importance))return fail("Invalid importance.");sets.push("importance=?");vals.push(b.importance);}
    sets.push("updated_at=CURRENT_TIMESTAMP");vals.push(id,owner);
    try{await env.DB.batch([
      env.DB.prepare("UPDATE intelligence_owner_memory SET "+sets.join(",")+" WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(...vals),
      audit(env,admin,"intelligence_memory_updated","intelligence_owner_memory",id,{fields:Object.keys(b)})
    ]);}catch{return fail("Memory update failed.",503);}
    return reply({success:true,id});
  }
  return null;
}
