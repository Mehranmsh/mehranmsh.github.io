import { validatePatchProposal } from "./intelligence-patch-policy.mjs";
/** Apply a validated one-file unified diff to an in-memory source snapshot only. */
export function applyValidatedPatchInMemory(input={}){
 if(!input||typeof input!=="object"||Array.isArray(input))return {ok:false,code:"invalid_input"};
 const {baseSha,expectedBaseSha,source,targetPath,summary,diff}=input;
 if(typeof expectedBaseSha!=="string"||!/^[a-f0-9]{40}$/.test(expectedBaseSha)||baseSha!==expectedBaseSha)return {ok:false,code:"stale_base_sha"};
 if(typeof source!=="string"||!source.endsWith("\n")||new TextEncoder().encode(source).byteLength>128*1024)return {ok:false,code:"invalid_source"};
 const checked=validatePatchProposal({baseSha,targetPaths:[targetPath],summary,diff});if(!checked.ok)return checked;
 const patch=diff.slice(0,-1).split("\n"), src=source.slice(0,-1).split("\n");
 const h=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patch[2]);
 if(!h)return {ok:false,code:"invalid_hunk_header"};
 let oldPos=Number(h[1])-1, newLines=[], cursor=3, consumed=0;
 if(oldPos<0||oldPos>src.length)return {ok:false,code:"hunk_position_out_of_range"};
 newLines.push(...src.slice(0,oldPos));
 while(cursor<patch.length){
  const line=patch[cursor++];
  if(line.startsWith(" ")){const value=line.slice(1);if(src[oldPos]!==value)return {ok:false,code:"context_mismatch"};newLines.push(value);oldPos++;consumed++;}
  else if(line.startsWith("-")){if(src[oldPos]!==line.slice(1))return {ok:false,code:"deletion_mismatch"};oldPos++;consumed++;}
  else if(line.startsWith("+"))newLines.push(line.slice(1));
  else return {ok:false,code:"invalid_hunk_line"};
 }
 newLines.push(...src.slice(oldPos));
 return {ok:true,content:newLines.join("\n")+"\n",targetPath,baseSha,additions:checked.additions,deletions:checked.deletions,mode:"in_memory_only"};
}
export {readBoundedResponse} from "./intelligence-bounded-response.mjs";
