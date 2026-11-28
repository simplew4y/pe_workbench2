import { esc } from "../shared/escape.js";

const metrics = new Map(Object.entries({
  Revenue: ["营业收入", "公司销售商品或提供服务取得的收入"],
  Sales: ["营业收入", "公司销售商品或提供服务取得的收入"],
  "Gross margin": ["毛利率", "每一元营业收入扣除营业成本后留下的比例"],
  "Operating margin": ["经营利润率", "经营利润占营业收入的比例"],
  Revenues: ["营业收入", "公司销售商品或提供服务取得的收入"],
  "Gross profit": ["毛利", "营业收入扣除营业成本后留下的利润"],
  "Operating profit": ["经营利润", "公司经营活动产生的利润"],
  "Profit after tax": ["税后利润", "公司扣除所得税后取得的利润"],
  "Attributable profit": ["归母净利润", "净利润中归属于母公司股东的部分"],
  "Pretax income": ["利润总额", "公司扣除所得税前的利润"],
  "EPS basic": ["基本每股收益", "按当期加权平均普通股数计算的每股盈利"],
  "EPS diluted": ["稀释每股收益", "考虑潜在普通股摊薄后计算的每股盈利"],
  "Cost of sales": ["营业成本", "与当期销售商品或服务直接对应的成本"],
  "Sales tax": ["税金及附加", "计入当期经营成本费用的相关税费"],
  "Selling expense": ["销售费用", "公司在推广和销售产品时发生的费用"],
  "Administrative expense": ["管理费用", "公司组织和管理经营活动发生的费用"],
  "R&D expense": ["研发费用", "当期计入损益的研究开发支出"],
  "Interest expense": ["利息费用", "公司为借款等融资支付或计提的利息"],
  "Interest income": ["利息收入", "公司从存款等计息资产取得的收入"],
  "Investment income": ["投资收益", "公司投资活动计入当期损益的收益或损失"],
  "Asset impairment": ["资产减值损失", "当期确认的资产价值减损，金额沿用模型的正负号"],
  "Disposal gain": ["资产处置收益", "出售或处置资产产生的净收益或损失"],
  "Income tax": ["所得税费用", "计入当期利润表的所得税"],
  "Minority income": ["少数股东损益", "合并净利润中归属于子公司其他股东的部分"],
  "Profit attributable to equity holders of the Company": ["归母净利润", "公司净利润中归属于母公司股东的部分"],
  "Non-IFRS profit attributable to equity holders of the Company": ["调整后归母净利润", "按公司披露的非国际财务报告准则口径调整后的归母盈利"],
  "Non-IFRS operating profit": ["调整后经营利润", "按公告列明的调整项目计算的经营利润"],
  "Non-IFRS EPS basic": ["调整后基本每股收益", "按公司披露的调整后盈利计算的基本每股收益"],
  "Non-IFRS EPS diluted": ["调整后稀释每股收益", "按公司披露的调整后盈利和摊薄股数计算的每股收益"],
  "Basic weighted average shares": ["基本加权平均股数", "按流通时间加权的普通股数量，用于计算基本每股收益"],
  "Diluted weighted average shares": ["稀释加权平均股数", "计入潜在摊薄股份后的加权平均股数，用于计算稀释每股收益"],
  "Diluted earnings numerator": ["计算稀释每股收益的盈利", "考虑稀释性工具影响后，用作每股收益分子的盈利金额"],
  "Dilution effect on earnings": ["摊薄对盈利的影响", "计算稀释每股收益时对盈利分子的调整额"],
  "Dilutive share awards": ["股份奖励产生的摊薄股数", "股份奖励可能新增的普通股数量"],
  "Gross profits": ["毛利"], "OP income": ["营业利润"], "Operating income": ["营业利润"], "Non-OP": ["非经营损益"],
  "Others": ["其他项目"], "Tax rate": ["所得税率"],
}));

const adjustmentNames = {
  "Share-based compensation":"股份支付", "Amortisation of intangible assets":"无形资产摊销",
  "Investee companies":"被投资公司", "Impairment provisions":"减值准备",
  "SSV & CPP":"SSV 及 CPP 项目", "Others":"其他项目", "Income tax effects":"所得税影响"
};
for (const [key, name] of Object.entries(adjustmentNames)) {
  metrics.set("Operating adjustment / " + key, [name + "调整额", "将报告经营利润调节至公司披露的调整后口径时，归入" + name + "的金额"]);
}

function periodName(period = "") {
  return period.replace(/^([1-4])Q(\d{2})$/, "20$2 年第 $1 季度")
    .replace(/^([12])H(\d{2})$/, (_, h, y) => "20" + y + " 年" + (h === "1" ? "上半年" : "下半年"))
    .replace(/^FY(20\d\d)$/, "$1 年度");
}

function changeValues(change, row, percent) {
  const unit = row?.unit || "";
  const yi = ["RMB mn", "CNY mn"].includes(unit) && Math.max(Math.abs(change.from || 0), Math.abs(change.to || 0)) >= 100;
  const units = {"RMB mn": "百万元", "CNY mn": "百万元", "RMB/share": "元/股", "HKD/share": "港元/股", "mn shares": "百万股"};
  const suffix = yi ? "亿元" : percent ? "%" : units[unit] || unit;
  const scale = yi ? 0.01 : percent ? 100 : 1 / (row?.storageScale || 1);
  const format = (value, digits) => typeof value === "number"
    ? (value * scale).toLocaleString("zh-CN", { maximumFractionDigits: digits }) + suffix
    : value == null ? "空白" : String(value);
  let digits = yi ? 2 : 6;
  if (typeof change.from === "number" && typeof change.to === "number" && change.from !== change.to &&
      format(change.from, digits) === format(change.to, digits)) digits = 15;
  return [format(change.from, digits), format(change.to, digits)];
}

export function describeModelChanges(payload, approval) {
  const actuals = new Map((payload.actuals || []).map(row => [row.sheet + "!" + row.cell, row]));
  const proposed = new Map(payload.changes.map(change => [change.ref, change.to]));
  const edits = new Map((payload.edits || []).map(edit => [edit.sheet + "!" + edit.cell, edit]));
  const labels = approval?.rowLabels || {};
  return payload.changes.map(change => {
    const row = actuals.get(change.ref);
    const edit = edits.get(change.ref);
    const coord = /^(.*)!\$?([A-Z]+)\$?(\d+)$/i.exec(change.ref);
    const formula = typeof change.to === "string" && change.to.startsWith("=");
    const originalLabel = labels[change.ref] || change.metric || change.ref;
    const baseMetric = (row?.metric || originalLabel).replace(/ \(HKD\)$/, "");
    const [name, definition] = metrics.get(baseMetric) || [row?.evidence?.split("；")[0] || originalLabel];
    const period = row?.period || (edit && [...actuals.values()].find(a => a.sheet === edit.sheet &&
      a.cell.match(/^[A-Z]+/)?.[0] === edit.cell.match(/^[A-Z]+/)?.[0])?.period);
    let title = [periodName(period), name + (row?.metric?.endsWith(" (HKD)") ? "（港元）" : "")].filter(Boolean).join(" · ");
    let explanation = definition || (change.reason && change.reason !== change.source ? change.reason : "");
    const arithmetic = (edit || row?.mode === "formula") && formula && /^=(\$?[A-Z]+\$?\d+)([-/])(\$?[A-Z]+\$?\d+)$/.exec(change.to);
    const ratio = arithmetic?.[2] === "/";
    const percent = !!approval?.percentRefs?.includes(change.ref);
    const sheet = edit?.sheet || coord?.[1];
    const left = arithmetic && arithmetic[1].replaceAll("$", "");
    const right = arithmetic && arithmetic[3].replaceAll("$", "");
    const operandName = cell => {
      const ref = sheet + "!" + cell;
      const label = actuals.get(ref)?.metric || labels[ref];
      return metrics.get(label)?.[0] || label || cell;
    };
    if ((edit || row?.mode === "formula") && formula) {
      const expression = change.to.slice(1).replace(/SUM\((\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)\)/g,
        (_, first, last) => "（" + first + "至" + last + "各项之和）")
        .replace(/\$?([A-Z]+)\$?(\d+)/g, (_, col, n) => operandName(col + n))
        .replaceAll("-", " 减去 ").replaceAll("/", " 除以 ");
      if (edit && ratio && percent) {
        title = [periodName(period), operandName(left) + "占" + operandName(right) + "的比例"].filter(Boolean).join(" · ");
      } else if (edit && !labels[change.ref]) {
        title = [periodName(period), "同季公式"].filter(Boolean).join(" · ");
      }
      explanation = [definition, "按本期模型数据计算：" + expression].filter(Boolean).join("。");
    } else if (edit && !row) {
      title = "披露列标题";
      explanation = edit.note;
    }
    // A local difference or ratio of two disclosed inputs has a known result before Excel runs.
    // Other formulas remain formulas until the approved workbook is recalculated.
    const leftRef = sheet + "!" + left, rightRef = sheet + "!" + right;
    const leftBasis = actuals.get(leftRef), rightBasis = actuals.get(rightRef);
    const x = proposed.get(leftRef), y = proposed.get(rightRef);
    const sameUnits = leftBasis?.unit && leftBasis.unit === rightBasis?.unit && leftBasis.storageScale === rightBasis.storageScale;
    const projected = edit && arithmetic && sameUnits && Number.isFinite(x) && Number.isFinite(y) && (!ratio || y !== 0)
      ? (ratio ? x / y : x - y) : undefined;
    const valueBasis = row || (!ratio && arithmetic ? leftBasis : undefined);
    const [before, after] = changeValues(Number.isFinite(projected) ? {...change, to:projected} : change, valueBasis, percent);
    const verb = (approval?.status || payload.status) === "applied" ? "已" : "拟";
    let action = change.from == null && !change.formulaCell ? verb + "新增 " + after : verb + "从 " + before + " 改为 " + after;
    if (formula) action = (change.from == null ? "" : "原值 " + before + "，") + verb + (change.from == null && !change.formulaCell ? "新增公式" : "改用公式计算") +
      (Number.isFinite(projected) ? "，按本提案输入为 " + after : "");
    if (row?.mode === "formula" && Number.isFinite(row.expected)) {
      const expected = changeValues({...change, to:row.expected}, row, percent)[1];
      action += "，待核对值 " + expected;
    }
    if (change.formulaCell && change.from == null && !formula) action = "原公式缺少缓存值，" + verb + "填入 " + after;
    const location = coord ? coord[1] + " 表 · 第 " + coord[3] + " 行，" + coord[2] + " 列（" + coord[2] + coord[3] + "）" : change.ref;
    const page = /#page=(\d+)/.exec(change.source || "")?.[1];
    const cumulative = /^([1-4])Q(\d{2})$/.exec(row?.period || "");
    let derivation = "";
    if (cumulative && row.sourcePeriod === (Number(cumulative[1]) * 3) + "M" + cumulative[2]) {
      const quarters = ["", "", "第一季度", "前两个季度", "前三个季度"];
      derivation = quarters[cumulative[1]] ? "本季金额由公告累计数扣除" + quarters[cumulative[1]] + "实绩得到" : "取第一季度累计数";
    }
    const notes = [row?.scope, derivation,
      row?.caption ? "与原预测并列展示" : "", page ? "公告第 " + page + " 页" : "",
      change.formulaCell && !formula ? "原公式将被替换" : "", !change.bindingVerified ? "映射未验证" : ""].filter(Boolean);
    const detail = [change.previousFormula && "原公式 " + change.previousFormula, formula && "新公式 " + change.to,
      "原始值 " + (change.from ?? "空白") + " → " + (change.to ?? "空白"), row?.unit && "公告单位 " + row.unit, row?.evidence, change.source].filter(Boolean).join(" · ");
    return { title, explanation, action, location:[location, ...notes].join(" · "), detail };
  });
}

export function modelChangesHTML(payload, approval) {
  return describeModelChanges(payload, approval).map(({title, explanation, action, location, detail}) =>
    '<li class="ap-change"><strong>' + esc(title) + '</strong>' +
    (explanation ? '<span>' + esc(explanation) + '。</span>' : '') + '<b>' + esc(action) + '</b><small>' +
    esc(location) + '</small><details><summary>查看原始记录</summary>' + esc(detail) + '</details></li>'
  ).join("");
}
