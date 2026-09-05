import test from "node:test";
import assert from "node:assert/strict";
import {act,createSample,projects} from "../site.js";

for(const project of Object.keys(projects)){
  test(project+": old handoff never changes revision; accepted retry preserves original receipt",()=>{
    let state=createSample(project);
    assert.equal(act(state,"resume"),state);
    state=act(state,"stale");
    assert.equal(state.revision,3);
    assert.equal(state.receipt.result,"REVISION_CONFLICT");
    state=act(state,"select");
    assert.equal(state.revision,3);
    state=act(state,"resume");
    assert.equal(state.revision,4);
    const receipt=JSON.stringify(state.receipt);
    state=act(state,"retry");
    assert.equal(JSON.stringify(state.receipt),receipt);
    assert.equal(state.revision,4);
    assert.equal(state.receipt.simulation,true);
    state=act(state,"stale");
    assert.equal(state.revision,4);
    state=act(state,"retry");
    assert.equal(JSON.stringify(state.receipt),receipt);
    const reset=act(state,"reset");
    assert.equal(reset.revision,3);
    assert.equal(reset.receipt,null);
    assert.equal(reset.events.length,1);
  });
}
test("sample projects start independently and unknown project IDs are rejected",()=>{
 const used=act(act(createSample(),"select"),"resume");
 const fresh=createSample("bugfix");
 assert.equal(fresh.revision,3);
 assert.equal(used.revision,4);
 assert.throws(()=>createSample("__proto__"));
});
