export function addUsage(...usages) {
  const out={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{}};
  for (const usage of usages.filter(Boolean)) {
    for (const key of ["input","output","cacheRead","cacheWrite","totalTokens"]) out[key]+=usage[key] || 0;
    for (const [key,value] of Object.entries(usage.cost || {})) out.cost[key]=(out.cost[key] || 0)+value;
  }
  return out;
}
