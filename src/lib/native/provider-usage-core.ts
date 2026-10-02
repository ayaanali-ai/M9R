/** Provider-reported counters only. Missing values stay unknown, never zero. */
export interface ReportedTurnUsage {
 inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;cacheWriteInputTokens:number|null;totalTokens:number|null;
}
export function reportedTurnUsage(raw:unknown):ReportedTurnUsage|null {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const source=raw as Record<string,unknown>;
 const read=(...keys:string[]):number|null=>{for(const key of keys){const value=source[key];if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0)return value;}return null;};
 const usage={inputTokens:read("inputTokens","input_tokens"),outputTokens:read("outputTokens","output_tokens"),cachedInputTokens:read("cachedInputTokens","cached_input_tokens","cache_read_input_tokens"),cacheWriteInputTokens:read("cacheWriteInputTokens","cache_creation_input_tokens"),totalTokens:read("totalTokens","total_tokens")};
 return Object.values(usage).some(value=>value!==null)?usage:null;
}
