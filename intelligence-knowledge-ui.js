(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const request=(path,options={})=>api(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
let knowledge=[],memory=[];
function status(id,message,kind=""){const el=$(id);if(el){el.textContent=message;el.className="notice"+(kind?" "+kind:"");}}
function mount(){
 const page=$("page-intelligence");if(!page||$("intelKnowledgeMemory"))return;
 const overview=page.querySelector(".intelligence-overview");
 const root=document.createElement("section");root.id="intelKnowledgeMemory";root.className="panel";
 root.innerHTML=`
 <div class="section-title"><div><h2>Knowledge & Memory</h2><div class="small-text">Owner-controlled reference records used by the private assistant.</div></div><button class="btn secondary small" id="intelKmRefresh" type="button">Refresh</button></div>
 <div class="grid">
  <form class="card" id="intelKnowledgeForm" autocomplete="off">
   <h3>Knowledge record</h3><div class="field"><label for="ikTitle">Title</label><input id="ikTitle" maxlength="160" required placeholder="A clear, searchable title"></div>
   <div class="field"><label for="ikContent">Content</label><textarea id="ikContent" rows="4" maxlength="12000" required placeholder="Facts, decisions, project information..."></textarea></div>
   <div class="grid"><div class="field"><label for="ikCategory">Category</label><input id="ikCategory" maxlength="40" value="company"></div><div class="field"><label for="ikImportance">Importance</label><select id="ikImportance"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div></div>
   <div class="field"><label for="ikSourceType">Source type</label><select id="ikSourceType"><option value="owner_input">Owner input</option><option value="uploaded_document">Uploaded document</option><option value="external_url">External URL (reference only)</option><option value="system_observation">System observation</option></select></div>
   <div class="field"><label for="ikSourceRef">Source reference / URL</label><input id="ikSourceRef" maxlength="1000" placeholder="Optional source reference"></div>
   <div class="field"><label for="ikSourceTitle">Source title</label><input id="ikSourceTitle" maxlength="200"></div>
   <div class="field"><label for="ikSourceExcerpt">Source excerpt</label><textarea id="ikSourceExcerpt" rows="2" maxlength="1000"></textarea></div>
   <div class="field"><label for="ikConfidence">Recorded confidence (0-100, optional)</label><input id="ikConfidence" type="number" min="0" max="100" step="1"></div>
   <button class="btn" id="ikSave" type="submit">Save knowledge</button><div id="ikFormStatus" class="notice" aria-live="polite"></div>
  </form>
  <form class="card" id="intelMemoryForm" autocomplete="off">
   <h3>Owner memory</h3><div class="field"><label for="imType">Memory type</label><select id="imType"><option value="fact">Fact</option><option value="preference">Preference</option><option value="instruction">Instruction</option><option value="project_decision">Project decision</option></select></div>
   <div class="field"><label for="imCategory">Category</label><input id="imCategory" maxlength="40" value="general"></div>
   <div class="field"><label for="imContent">Memory content</label><textarea id="imContent" rows="5" maxlength="4000" required placeholder="A concise, durable memory for the assistant"></textarea></div>
   <div class="field"><label for="imImportance">Importance</label><select id="imImportance"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div>
   <button class="btn" id="imSave" type="submit">Save memory</button><div id="imFormStatus" class="notice" aria-live="polite"></div>
  </form>
 </div>
 <div class="section-title" style="margin-top:22px"><h3>Knowledge library</h3><select id="ikState"><option value="active">Active</option><option value="archived">Archived</option><option value="all">All records</option></select></div>
 <div id="ikListStatus" class="notice">Knowledge records have not been loaded.</div><div id="ikList" class="grid"></div>
 <div class="section-title" style="margin-top:22px"><h3>Owner memory</h3></div>
 <div id="imListStatus" class="notice">Memory records have not been loaded.</div><div id="imList" class="grid"></div>
 <p class="small-text">Source metadata and recorded confidence are descriptive, not proof of truth. External URLs are stored as references only and are not fetched. Records are archived rather than permanently deleted.</p>`;
 if(overview)overview.insertAdjacentElement("afterend",root);else page.prepend(root);
 $("intelKmRefresh").addEventListener("click",loadAll);
 $("ikState").addEventListener("change",loadKnowledge);
 $("intelKnowledgeForm").addEventListener("submit",saveKnowledge);
 $("intelMemoryForm").addEventListener("submit",saveMemory);
 $("ikList").addEventListener("click",knowledgeAction);
 $("imList").addEventListener("click",memoryAction);
 loadAll();
}
async function loadAll(){await Promise.all([loadKnowledge(),loadMemory()]);}
async function loadKnowledge(){
 status("ikListStatus","Loading owner knowledge...");
 try{const data=await request("/intelligence/knowledge?state="+encodeURIComponent($("ikState").value));knowledge=data.items||[];renderKnowledge();status("ikListStatus",knowledge.length+" knowledge records loaded.","success");}
 catch(e){status("ikListStatus","Knowledge unavailable: "+e.message,"warn");$("ikList").innerHTML="";}
}
async function loadMemory(){
 status("imListStatus","Loading owner memory...");
 try{const data=await request("/intelligence/memory");memory=data.items||[];renderMemory();status("imListStatus",memory.length+" active memory records loaded.","success");}
 catch(e){status("imListStatus","Memory unavailable: "+e.message,"warn");$("imList").innerHTML="";}
}
function renderKnowledge(){
 const list=$("ikList");if(!knowledge.length){list.innerHTML='<div class="empty">No records in this view.</div>';return;}
 list.innerHTML=knowledge.map(item=>'<article class="card"><div class="eyebrow">'+esc(item.category)+' · '+esc(item.importance)+' · '+esc(item.verification_status)+'</div><h3>'+esc(item.title)+'</h3><p style="white-space:pre-wrap">'+esc(item.content)+'</p><div class="small-text">Source: '+esc(item.source_type)+(item.source_title?' · '+esc(item.source_title):'')+(item.recorded_confidence!==null?' · Recorded confidence: '+esc(item.recorded_confidence)+'%':'')+'</div>'+(item.source_ref?'<div class="small-text">Reference: '+esc(item.source_ref)+'</div>':'')+(item.source_excerpt?'<div class="small-text">Excerpt: '+esc(item.source_excerpt)+'</div>':'')+'<div class="hero-actions" style="margin-top:10px">'+(item.archived_at?'':'<button class="btn secondary small" data-k-action="verify" data-id="'+esc(item.id)+'">Verify</button><button class="btn secondary small" data-k-action="dispute" data-id="'+esc(item.id)+'">Dispute</button><button class="btn secondary small" data-k-action="unverify" data-id="'+esc(item.id)+'">Reset review</button><button class="btn secondary small" data-k-action="edit" data-id="'+esc(item.id)+'">Edit</button><button class="btn danger small" data-k-action="archive" data-id="'+esc(item.id)+'">Archive</button>')+'</div></article>').join("");
}
function renderMemory(){
 const list=$("imList");if(!memory.length){list.innerHTML='<div class="empty">No saved memory yet.</div>';return;}
 list.innerHTML=memory.map(item=>'<article class="card"><div class="eyebrow">'+esc(item.memory_type)+' · '+esc(item.category)+' · '+esc(item.importance)+'</div><p style="white-space:pre-wrap">'+esc(item.content)+'</p><div class="hero-actions"><button class="btn secondary small" data-m-action="edit" data-id="'+esc(item.id)+'">Edit</button><button class="btn danger small" data-m-action="archive" data-id="'+esc(item.id)+'">Archive</button></div></article>').join("");
}
async function saveKnowledge(event){
 event.preventDefault();const button=$("ikSave");button.disabled=true;
 const confidence=$("ikConfidence").value;
 const body={title:$("ikTitle").value,content:$("ikContent").value,category:$("ikCategory").value,importance:$("ikImportance").value,sourceType:$("ikSourceType").value,sourceRef:$("ikSourceRef").value,sourceTitle:$("ikSourceTitle").value,sourceExcerpt:$("ikSourceExcerpt").value};
 if(confidence!=="")body.recordedConfidence=Number(confidence);
 try{await request("/intelligence/knowledge",{method:"POST",body:JSON.stringify(body)});$("intelKnowledgeForm").reset();$("ikCategory").value="company";status("ikFormStatus","Knowledge saved. It remains unreviewed until you review it.","success");await loadKnowledge();}
 catch(e){status("ikFormStatus","Could not save knowledge: "+e.message,"warn");}
 finally{button.disabled=false;}
}
async function saveMemory(event){
 event.preventDefault();const button=$("imSave");button.disabled=true;
 try{await request("/intelligence/memory",{method:"POST",body:JSON.stringify({memoryType:$("imType").value,category:$("imCategory").value,content:$("imContent").value,importance:$("imImportance").value})});$("intelMemoryForm").reset();$("imCategory").value="general";status("imFormStatus","Memory saved.","success");await loadMemory();}
 catch(e){status("imFormStatus","Could not save memory: "+e.message,"warn");}
 finally{button.disabled=false;}
}
async function knowledgeAction(event){
 const button=event.target.closest("[data-k-action]");if(!button)return;
 const item=knowledge.find(x=>x.id===button.dataset.id);if(!item)return;
 const action=button.dataset.kAction;button.disabled=true;
 try{
  if(action==="archive"){if(!confirm("Archive this knowledge record?"))return;await request("/intelligence/knowledge/"+encodeURIComponent(item.id),{method:"DELETE"});}
  else if(action==="edit"){const title=prompt("Knowledge title:",item.title);if(title===null)return;const content=prompt("Knowledge content:",item.content);if(content===null)return;const category=prompt("Category:",item.category);if(category===null)return;await request("/intelligence/knowledge/"+encodeURIComponent(item.id),{method:"PUT",body:JSON.stringify({title,content,category,importance:item.importance})});}
  else await request("/intelligence/knowledge/"+encodeURIComponent(item.id),{method:"PUT",body:JSON.stringify({action})});
  await loadKnowledge();
 }catch(e){status("ikListStatus","Action failed: "+e.message,"warn");}
 finally{button.disabled=false;}
}
async function memoryAction(event){
 const button=event.target.closest("[data-m-action]");if(!button)return;
 const item=memory.find(x=>x.id===button.dataset.id);if(!item)return;
 const action=button.dataset.mAction;button.disabled=true;
 try{
  if(action==="archive"){if(!confirm("Archive this memory?"))return;await request("/intelligence/memory/"+encodeURIComponent(item.id),{method:"DELETE"});}
  else{const content=prompt("Memory content:",item.content);if(content===null)return;const category=prompt("Category:",item.category);if(category===null)return;await request("/intelligence/memory/"+encodeURIComponent(item.id),{method:"PUT",body:JSON.stringify({content,category,memoryType:item.memory_type,importance:item.importance})});}
  await loadMemory();
 }catch(e){status("imListStatus","Action failed: "+e.message,"warn");}
 finally{button.disabled=false;}
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();
