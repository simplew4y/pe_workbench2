// Held-out checks. Import only in the grading process, outside the agent project.
const release = "https://static.www.tencent.com/uploads/2026/03/18/f78591955e05a6db4e31e128bdaefefa.pdf";
export const facts = [];
function fact(col, row, metric, expected, mode = "check", unit = "百万元人民币", decimals = 0, formula) {
  facts.push({ sheet: "IS", cell: col + row, header: col + "3", period: col === "AD" ? "FY2025" : "4Q25",
    metric, expected, mode, unit, decimals, source: release +
      (row === 194 ? " · 公告人民币 EPS 按原模型汇率折算" : row === 186 || row === 198 || row === 199 ?
        " · 每股盈利附注" : " · 综合收益表、每股盈利及非国际财务报告准则调节表"), ...(formula ? { formula } : {}) });
}
for (const [col, gross, sales, admin, other, operating, sbc, amort, ssv, adjusted, net, nonNet] of [
  ["AD", 422593, -41727, -136127, -3177, 241562, 31859, 6345, 890, 280656, 224842, 259626],
  ["EF", 108289, -12983, -36283, 1315, 60338, 7210, 1594, 376, 69518, 58260, 64694],
]) {
  for (const [row, label, value, mode] of [
    [99, "毛利", gross, "actual"], [125, "销售及市场推广开支", sales, "actual"],
    [126, "一般及行政开支", admin, "actual"], [130, "其他收益（亏损）净额", other, "actual"],
    [133, "经营利润", operating, "check"], [135, "经营利润调节 · 股份酬金", sbc, "actual"],
    [136, "经营利润调节 · 无形资产摊销", amort, "actual"],
    [137, "经营利润调节 · SSV 与共同富裕", ssv, col === "AD" ? "actual" : "check"],
    [138, "经营利润调节 · 其他", 0, col === "AD" ? "actual" : "check"],
    [139, "非 IFRS 经营利润", adjusted, "check"], [165, "归母净利润", net, "actual"],
    [180, "非 IFRS 归母净利润", nonNet, "actual"],
  ]) fact(col, row, label, value, mode);
}
fact("AD", 198, "基本加权平均股数", 9085, "actual", "百万股");
fact("AD", 199, "摊薄加权平均股数", 9244, "actual", "百万股");
fact("AD", 186, "摊薄时扣减的应占利润", 1572, "actual");
fact("AD", 187, "基本 EPS", 24.749, "check", "人民币/股", 3);
fact("AD", 188, "摊薄 EPS", 24.153, "formula", "人民币/股", 3, "=(AD165-AD186)/AD199");
fact("AD", 189, "非 IFRS 摊薄 EPS", 27.877, "actual", "人民币/股", 3);
fact("EF", 187, "基本 EPS", 6.433, "actual", "人民币/股", 3);
fact("EF", 188, "摊薄 EPS", 6.276, "actual", "人民币/股", 3);
fact("EF", 189, "非 IFRS 摊薄 EPS", 6.966, "actual", "人民币/股", 3);
fact("AD", 194, "港元摊薄 EPS", 24.153 * 7.8 / 7.3, "formula", "港元/股", 2, "=AD188*7.8/AD245");
fact("EF", 194, "港元摊薄 EPS", 6.276 * 7.8 / 7.1, "formula", "港元/股", 2, "=EF188*7.8/EF245");
