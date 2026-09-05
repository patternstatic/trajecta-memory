export const projects = {
  launch: {name:"Ship the beta",description:"Finish checkout without losing the decisions from planning.",branch:"beta-launch",old:"Use a monthly subscription",oldDetail:"The first plan, before you settled on a one-time beta.",current:"Ship a $9 one-time beta",currentDetail:"One payment. First ten customers. Keep the setup simple.",next:"Build the one-time checkout"},
  onboarding: {name:"First-run experience",description:"Carry the latest setup decision into the implementation session.",branch:"first-run",old:"Ask for an account first",oldDetail:"An earlier onboarding plan that added a sign-up step.",current:"Start with a local example",currentDetail:"Let a new user try a handoff before configuring real work.",next:"Build the local example flow"},
  bugfix: {name:"Fix the retry bug",description:"Recover interrupted work without applying the same change twice.",branch:"retry-recovery",old:"Start a new operation on retry",oldDetail:"The initial fix would risk applying the change twice.",current:"Reuse the exact operation",currentDetail:"Return the original receipt when the same attempt is retried.",next:"Implement exact receipt lookup"}
};
export function createSample(project="launch") {
  if (!Object.hasOwn(projects,project)) throw new Error("Unknown sample project");
  return {project,revision:3,phase:"ready",receipt:null,accepted:null,events:[{title:"Latest decision captured",detail:"Current plan · revision 3"}]};
}
export function act(sample,event) {
  const p=projects[sample.project];
  const append=(title,detail)=>[...sample.events,{title,detail}];
  if(event==="reset") return createSample(sample.project);
  if(event==="stale") {
    const receipt={schema:"trajecta.playground-receipt/v1",simulation:true,work:sample.project,branch:p.branch,result:"REVISION_CONFLICT",expectedRevision:2,beforeRevision:sample.revision,afterRevision:sample.revision};
    return {...sample,phase:"rejected",receipt,events:append("Earlier plan rejected","Revision 2 ≠ "+sample.revision+" · workspace unchanged")};
  }
  if(event==="select"&&!sample.accepted) return {...sample,phase:"selected",events:append("Current handoff inspected","Revision 3 matches · waiting for approval")};
  if(event==="resume"&&sample.phase==="selected"&&!sample.accepted) {
    const receipt={schema:"trajecta.playground-receipt/v1",simulation:true,receiptId:"sample-"+sample.project+"-resume-3-4",work:sample.project,branch:p.branch,result:"RESUMED",expectedRevision:3,beforeRevision:3,afterRevision:4,nextAction:p.next};
    return {...sample,revision:4,phase:"resumed",receipt,accepted:receipt,events:append("Current handoff accepted","Revision 3 → 4 · one resume")};
  }
  if(event==="retry"&&sample.accepted) return {...sample,phase:"retried",receipt:sample.accepted,events:append("Exact attempt retried","Original receipt returned · revision remains 4")};
  return sample;
}
if(typeof document!=="undefined"){
  const $=id=>document.getElementById(id);
  let sample=createSample();
  const messages={
    ready:["neutral","A familiar plan can still be out of date.","Try the earlier handoff to see what Trajecta catches.","Ready to continue"],
    selected:["success","The current plan matches your workspace.","Review the branch and next step, then approve this sample resume.","Awaiting approval"],
    resumed:["success","The right work, resumed once.","Your workspace advanced from 3 to 4. Try the same handoff again.","Resumed · rev 4"],
    retried:["success","Same attempt. Same receipt.","Retry returned the original receipt. Revision stays at 4.","Exact retry"]
  };
  function showTab(name,focus=false){
    for(const key of ["handoff","history","receipt"]){const tab=$("tab-"+key);tab.setAttribute("aria-selected",String(key===name));tab.tabIndex=key===name?0:-1;$("panel-"+key).hidden=key!==name;if(key===name&&focus)tab.focus();}
  }
  function render(){
    const p=projects[sample.project];
    for(const [id,value] of Object.entries({"workspace-title":p.name,"project-breadcrumb":p.name,"project-description":p.description,"old-plan":p.old,"old-detail":p.oldDetail,"current-plan":p.current,"current-detail":p.currentDetail,"context-branch":p.branch,"context-revision":sample.revision,"context-next":p.next,"activity-count":sample.events.length}))$(id).textContent=value;
    const m=sample.phase==="rejected"?["rejected","Old plan caught. Your work is safe.","The handoff expects revision 2. Your workspace is at "+sample.revision+". Nothing changed.","Stale plan rejected"]:messages[sample.phase];
    $("result-message").dataset.tone=m[0];$("result-title").textContent=m[1];$("result-detail").textContent=m[2];$("work-status").textContent=m[3];
    $("resume-work").disabled=sample.phase!=="selected";$("resume-work").hidden=!!sample.accepted;$("retry-work").hidden=!sample.accepted;
    $("select-current").disabled=!!sample.accepted||sample.phase==="selected";
    $("action-hint").textContent=sample.accepted?"Open Receipt to inspect or download the result.":sample.phase==="selected"?"You approve this sample state transition.":"Select the current handoff to continue.";
    $("receipt-json").textContent=sample.receipt?JSON.stringify(sample.receipt,null,2):"No receipt yet. Your workspace is unchanged.";
    $("receipt-explanation").textContent=sample.receipt?(sample.receipt.result==="RESUMED"?"This sample advanced once. Retries return these same receipt bytes.":"The rejected handoff left the workspace revision unchanged."):"Try a handoff to create a sample receipt.";
    $("download-receipt").disabled=!sample.receipt;
    $("event-list").replaceChildren(...sample.events.map((event,i)=>{const li=document.createElement("li");const title=document.createElement("span");title.textContent=event.title;const detail=document.createElement("small");detail.textContent=String(i+1).padStart(2,"0")+" / "+event.detail;li.append(title,detail);return li;}));
    document.querySelectorAll("[data-project]").forEach(button=>{const active=button.dataset.project===sample.project;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));});
  }
  for(const [id,event] of [["try-stale","stale"],["select-current","select"],["resume-work","resume"],["retry-work","retry"],["reset-demo","reset"]])$(id).addEventListener("click",()=>{sample=act(sample,event);render();if(event==="reset")showTab("handoff");});
  document.querySelectorAll("[data-project]").forEach(button=>button.addEventListener("click",()=>{sample=createSample(button.dataset.project);render();showTab("handoff");}));
  const tabs=["handoff","history","receipt"];
  for(const name of tabs){$("tab-"+name).addEventListener("click",()=>showTab(name));$("tab-"+name).addEventListener("keydown",event=>{let i=tabs.indexOf(name);if(event.key==="ArrowRight")i=(i+1)%3;else if(event.key==="ArrowLeft")i=(i+2)%3;else if(event.key==="Home")i=0;else if(event.key==="End")i=2;else return;event.preventDefault();showTab(tabs[i],true);});}
  $("download-receipt").addEventListener("click",()=>{if(!sample.receipt)return;const url=URL.createObjectURL(new Blob([JSON.stringify(sample.receipt,null,2)+"\n"],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="trajecta-sample-"+sample.project+"-receipt.json";document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  render();
}
