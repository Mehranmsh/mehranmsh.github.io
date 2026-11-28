const MAX_PATCH_BYTES = 16384;
const MAX_CHANGED_LINES = 160;
const ALLOWED_ROOT_FILES = new Set(["worker.js","index.html","social.html","nexus.html","ai.html","services.html","music-studio.html"]);
const ALLOWED_PREFIXES = Object.freeze(["scripts/","src/","pages/","components/","modules/","social/","nexus/","ai/","music-studio/","studio/","assets/js/","assets/css/","public/js/","public/css/"]);
const FORBIDDEN_PATH = /(?:^|\/)(?:\.env[^/]*|[^/]*(?:secret|credential|wallet|user[-_]?data|account[-_]?data)[^/]*|private(?:\.|\/|$)|node_modules|\.github(?:\/|$)|migrations?|[^/]*(?:deploy|release|publish)[^/]*)\/?/i;
function fail(code) { return { ok: false, code }; }
export function isAllowedPatchPath(path) {
  if (typeof path !== "string" || !path || path.length > 240 || path.startsWith("/") ||
      path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") ||
      FORBIDDEN_PATH.test(path) || !/\.(?:mjs|js|jsx|ts|tsx|html|css|json)$/i.test(path)) return false;
  const rootAppSource = !path.includes("/") && /\.(?:mjs|js|html|css)$/i.test(path);
  return ALLOWED_ROOT_FILES.has(path) || rootAppSource || ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix));
}
function count(value) {
  if (value === undefined) return 1;
  const n=Number(value); return Number.isSafeInteger(n)&&n>=0&&n<=MAX_CHANGED_LINES? n:null;
}
export function validatePatchProposal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
  const {baseSha,targetPaths,diff,summary}=input;
  if (typeof baseSha!=="string" || !/^[a-f0-9]{40}$/.test(baseSha)) return fail("invalid_base_sha");
  if (typeof summary!=="string" || summary.trim().length<12 || summary.length>500) return fail("invalid_summary");
  if (!Array.isArray(targetPaths)||targetPaths.length!==1) return fail("invalid_target_count");
  const targetPath=targetPaths[0]; if(!isAllowedPatchPath(targetPath)) return fail("path_not_allowed");
  if(typeof diff!=="string"||diff.length<20||new TextEncoder().encode(diff).byteLength>MAX_PATCH_BYTES) return fail("patch_size_invalid");
  if(diff.includes("\u0000")||diff.includes("\r")||!diff.endsWith("\n")) return fail("patch_encoding_invalid");
  const lines=diff.slice(0,-1).split("\n");
  if(lines.length<4||lines[0]!=="--- a/"+targetPath||lines[1]!=="+++ b/"+targetPath) return fail("patch_path_mismatch");
  if(lines.some(line=>/^(?:diff --git |index |GIT binary patch|Binary files |rename |copy |(?:old|new) mode |deleted file mode |new file mode |similarity index )/.test(line))) return fail("unsupported_patch_feature");
  let i=2,hunks=0,adds=0,dels=0;
  while(i<lines.length){
    const m=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++]);
    if(!m)return fail("invalid_hunk_header"); hunks++;
    const oldStart=Number(m[1]),newStart=Number(m[3]);
    let old=count(m[2]),neu=count(m[4]); if(old===null||neu===null||(old===0&&neu===0))return fail("invalid_hunk_counts");
    if((old>0&&oldStart<1)||newStart!==(old===0?oldStart+1:oldStart))return fail("hunk_position_mismatch");
    while(old>0||neu>0){
      if(i>=lines.length)return fail("truncated_hunk");
      const line=lines[i++];
      if(line.startsWith(" ")){old--;neu--;}
      else if(line.startsWith("-")){old--;dels++;}
      else if(line.startsWith("+")){neu--;adds++;}
      else return fail("invalid_hunk_line");
      if(old<0||neu<0)return fail("hunk_count_mismatch");
    }
  }
  if(hunks!==1||adds+dels===0||adds+dels>MAX_CHANGED_LINES)return fail("change_limit_exceeded");
  return {ok:true,baseSha,targetPath,bytes:new TextEncoder().encode(diff).byteLength,additions:adds,deletions:dels,hunkCount:hunks,mode:"validate_only"};
}
export const PATCH_PROPOSAL_POLICY=Object.freeze({maxPatchBytes:MAX_PATCH_BYTES,maxChangedLines:MAX_CHANGED_LINES,allowedPaths:Object.freeze([...ALLOWED_ROOT_FILES,...ALLOWED_PREFIXES]),allowedRootFiles:Object.freeze([...ALLOWED_ROOT_FILES]),allowedPrefixes:ALLOWED_PREFIXES,forbiddenPathPattern:FORBIDDEN_PATH.source,appliesChanges:false,createsBranches:false,createsPullRequests:false});
