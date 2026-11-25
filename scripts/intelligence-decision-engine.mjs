const MAX_OPTIONS=50, MAX_CRITERIA=30;
const clean=(v,n=120)=>typeof v==="string"?v.trim().slice(0,n):"";
const finite=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
/** Compare explicitly scored alternatives. Advisory only; never authorizes or executes actions. */
export function evaluateIntelligenceOptions(options, criteria, settings={}) {
 const empty={rankedOptions:[],excludedOptions:[],reviewRequired:[],diagnostics:{advisoryOnly:true,decisionMade:false,executionPerformed:false}};
 if(!Array.isArray(options)||!Array.isArray(criteria)) return empty;
 const owner=clean(settings.ownerUid), boundedCriteria=criteria.slice(0,MAX_CRITERIA).filter(c=>c&&typeof c==="object"&&clean(c.key)&&finite(c.weight,0,100)&&(c.direction==="higher"||c.direction==="lower"));
 const totalWeight=boundedCriteria.reduce((n,c)=>n+c.weight,0);
 if(!owner||!boundedCriteria.length||!totalWeight) return empty;
 const excludedOptions=[],reviewRequired=[],rankedOptions=[];
 for(const option of options.slice(0,MAX_OPTIONS)) {
  if(!option||typeof option!=="object"||!clean(option.id)) continue;
  const failed=(Array.isArray(option.constraints)?option.constraints:[]).filter(x=>x&&x.confirmed===true&&x.confirmed_by===owner&&x.passed===false).map(x=>clean(x.key));
  if(failed.length){excludedOptions.push({option_id:clean(option.id),failed_constraints:failed,reason:"owner_confirmed_constraint_failure"});continue;}
  const unknownConstraints=(Array.isArray(option.constraints)?option.constraints:[]).filter(x=>!x||x.confirmed!==true||x.confirmed_by!==owner||typeof x.passed!=="boolean").map(x=>clean(x&&x.key)||"unspecified");
  let weighted=0,covered=0; const evidence=[];
  for(const criterion of boundedCriteria) {
   const value=option.scores&&option.scores[criterion.key];
   if(!finite(value,0,5)){evidence.push({criterion:criterion.key,status:"missing_or_invalid"});continue;}
   const normalized=criterion.direction==="higher"?value:5-value;
   weighted+=normalized*criterion.weight;covered+=criterion.weight;
   evidence.push({criterion:criterion.key,value,weight:criterion.weight,direction:criterion.direction,status:"scored"});
  }
  const coverage=covered/totalWeight;
  const needsReview=coverage<1||unknownConstraints.length>0||option.high_impact===true;
  const item={option_id:clean(option.id),title:clean(option.title||option.id,180),score:covered?Number((weighted/covered).toFixed(4)):null,coverage:Number(coverage.toFixed(4)),evidence,unknown_constraints:unknownConstraints,review_required:needsReview,approval_required:needsReview||option.high_impact===true,advisory:true};
  rankedOptions.push(item);
  if(needsReview) reviewRequired.push({option_id:item.option_id,reasons:[...(coverage<1?["incomplete_scoring"]:[]),...(unknownConstraints.length?["unconfirmed_constraints"]:[]),...(option.high_impact===true?["high_impact"]:[])]});
 }
 rankedOptions.sort((a,b)=>(b.score??-1)-(a.score??-1)||a.option_id.localeCompare(b.option_id));
 return {rankedOptions,excludedOptions,reviewRequired,diagnostics:{advisoryOnly:true,decisionMade:false,executionPerformed:false,inspectedOptions:Math.min(options.length,MAX_OPTIONS),omittedOptions:Math.max(0,options.length-MAX_OPTIONS),criteriaUsed:boundedCriteria.length}};
}
