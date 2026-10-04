import assert from "node:assert/strict";
import test from "node:test";
import {effectiveRunSettings,validateRunSettings} from "../src/lib/agent-run-settings.ts";
import {FREE_WORKSPACE_MEMORY_BYTES,memoryAllowance,normalizeMemoryNote} from "../src/lib/shared-memory-core.ts";
import {reportedTurnUsage} from "../src/lib/native/provider-usage-core.ts";
const options={models:[{id:"vendor/model",label:"Model",efforts:[{id:"low",label:"Low"}]}],efforts:[{id:"low",label:"Low"}]};
test("effort support is selected per model, never borrowed from the default",()=>{
 assert.throws(()=>validateRunSettings({model:"other",effort:"low"},{...options,models:[...options.models,{id:"other",label:"Other",efforts:[{id:"high",label:"High"}]}]}));
 assert.throws(()=>validateRunSettings({model:"unknown-support",effort:"low"},{...options,models:[{id:"unknown-support",label:"Unknown"}]}));
});
test("usage records retain provider counters and never invent absent tokens",()=>{
 assert.equal(reportedTurnUsage({cost:0.1}),null);
 assert.equal(reportedTurnUsage({input_tokens:-1,output_tokens:1.1}),null);
 assert.deepEqual(reportedTurnUsage({input_tokens:0,output_tokens:12,cache_read_input_tokens:4}),{inputTokens:0,outputTokens:12,cachedInputTokens:4,cacheWriteInputTokens:null,totalTokens:null});
 assert.equal(reportedTurnUsage({inputTokens:32,totalTokens:40})?.totalTokens,40);
});
test("run settings accept only this connection's reported choices",()=>{
 assert.deepEqual(validateRunSettings({model:"vendor/model",effort:"low"},options),{model:"vendor/model",effort:"low"});
 assert.throws(()=>validateRunSettings({model:"other/provider",effort:"low"},options));
 assert.throws(()=>validateRunSettings({model:null,effort:"extreme"},options));
 assert.deepEqual(validateRunSettings({model:null,effort:null},{models:null,efforts:null}),{model:null,effort:null});
 assert.throws(()=>validateRunSettings({model:"vendor/model"},options));
});
test("channel defaults distinguish explicit provider default from inheritance",()=>{
 const defaults={model:"vendor/model",effort:"low"};
 assert.deepEqual(effectiveRunSettings(defaults),defaults);
 assert.deepEqual(effectiveRunSettings(defaults,{model:null,effort:null}),{model:null,effort:null});
 assert.notEqual(effectiveRunSettings(defaults),defaults);
});
test("workspace free pool is 10 MiB and remains readable above quota",()=>{
 assert.equal(FREE_WORKSPACE_MEMORY_BYTES,10485760);
 assert.equal(memoryAllowance(FREE_WORKSPACE_MEMORY_BYTES).limitReached,true);
 assert.equal(memoryAllowance(FREE_WORKSPACE_MEMORY_BYTES+1).remainingBytes,0);
 assert.throws(()=>memoryAllowance(-1));
 assert.throws(()=>memoryAllowance(NaN));
});
test("shared note validation uses UTF-8 bytes and normalized deduplication",()=>{
 const first=normalizeMemoryNote({title:" Decision ",body:" We agreed. "});
 assert.equal(first.contentHash,normalizeMemoryNote({title:"Decision",body:"We agreed."}).contentHash);
 assert.throws(()=>normalizeMemoryNote({title:"Decision",body:"😀".repeat(16385)}));
 assert.throws(()=>normalizeMemoryNote({title:" ",body:"Valid"}));
 assert.throws(()=>normalizeMemoryNote({title:"Valid",body:" "}));
 assert.ok(normalizeMemoryNote({title:"Valid",body:"hello ".repeat(10922)}).body.length > 60000);
});
