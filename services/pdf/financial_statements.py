"""Read labelled Chinese financial statement tables into period-scoped facts."""
import re
from decimal import Decimal
from unicodedata import east_asian_width

AMOUNT = r"-?\d[\d,]*(?:\.\d+)?"
NUM = re.compile(r"(?<!\S)(\(" + AMOUNT + r"\)|" + AMOUNT + r")(?=\s|附註|$)")
QUARTERS = {"一": 1, "二": 2, "三": 3, "四": 4}
HK = {
    "來自客戶合同的收入": "Revenue", "客戶合同收入": "Revenue", "毛利": "Gross profit",
    "經營虧損": "Operating profit", "經營利潤": "Operating profit",
    "期內利潤╱（虧損）": "Profit after tax", "年內（虧損）╱利潤": "Profit after tax",
    "研發開支": "R&D expense", "行政開支": "Administrative expense", "銷售及營銷開支": "Selling expense",
}
CN = {
    "营业收入": "Revenue", "利润总额": "Pretax income", "归属于上市公司股东的净利润": "Attributable profit",
    "基本每股收益（元/股）": "EPS basic", "稀释每股收益（元/股）": "EPS diluted",
}
FLOWS = {
    "营业成本": "Cost of sales", "税金及附加": "Sales tax", "销售费用": "Selling expense",
    "管理费用": "Administrative expense", "研发费用": "R&D expense", "利息费用": "Interest expense",
    "利息收入": "Interest income", "投资收益": "Investment income", "资产处置收益": "Disposal gain",
    "资产减值损失": "Asset impairment", "所得税费用": "Income tax", "少数股东损益": "Minority income",
}


def column_centres(line, spans):
    # Poppler aligns Chinese glyphs to two display columns.
    def width(value):
        return sum(2 if east_asian_width(c) in ("W", "F") else 1 for c in value)
    return [width(line[:start]) + width(line[start:end])/2 for start, end in spans]


def read_chinese_tables(text):
    pages = text.split("\f")
    cover = pages[0]
    title = re.search(r"截至\s*(20\d\d)\s*年\s*(\d+)\s*月\s*\d+\s*日止(六個月|年度)", cover)
    quarter = re.search(r"(20\d\d)\s*年\s*第([一二三四])季度报告", cover)
    if "业绩预告" in cover[:600]:
        interval = re.search(r"(20\d\d)\s*年\s*1\s*月\s*1\s*日至.*?(\d+)\s*月\s*\d+\s*日", cover)
        gaps = []
        for m in re.finditer(r"预计([^，。\n]+?)约为人民币\s*([\d,.]+)\s*亿元至\s*([\d,.\s]+?)\s*亿元", cover):
            gaps.append(dict(period=f"{interval[2]}M{interval[1][-2:]}" if interval else "", metric=m[1], page=1,
                             reason=f"累计预告区间 {m[2]}–{m[3].strip()} 亿元，不能作为单季实绩"))
        return [], ["业绩预告仅供比较，须使用正式披露的实绩写回"], gaps
    if not (title or quarter):
        return None
    code = re.search(r"(股份代號|证券代码)\s*[：:]\s*(\d{4,6})",cover)
    name = re.search(r"^([^\n（]{2,70})（「本公司」）",cover,re.M)
    short = re.search(r"证券简称[：:]\s*(\S+)",cover)
    issuer = dict(code=code[2] if code else "", market=("HK" if code and code[1]=="股份代號" else "CN"),
                  name=name[1].strip() if name else short[1] if short else "")
    audit = "未经审计" if re.search(r"未經審計|未经审计|是否(?:经过|经)?审计[^\n]*\s*□是\s*√否",cover) else "已审计" if "經審計" in cover else "未确认"
    facts, issues, gaps = {}, [], []

    def add(metric, raw, scale, page, period, basis, scope, printed, prior=None, unit="RMB mn", ytd=None):
        def number(token):
            return Decimal(token.replace(",", "").replace("(", "-").replace(")", "")) * scale
        value = number(raw)
        item = dict(metric=metric, expected=float(value), decimals=max(0, -value.as_tuple().exponent),
                    period=period, unit=unit, page=page, basis=basis, scope=scope, label=printed, issuer=issuer, audit=audit)
        if ytd is not None:
            item["yearToDateReported"] = float(number(ytd))
        if prior:
            item["priorReported"] = float(number(prior))
        key = (period, metric, scope, basis)
        if key in facts and facts[key]["expected"] != item["expected"]:
            issues.append(f"披露表内存在不一致的{metric}，请核对第{page}页")
        else:
            facts.setdefault(key, item)

    if title:
        year, month, kind = title.groups()
        if kind == "年度" and month == "12":
            period = "FY" + year
        elif kind == "六個月" and month == "6":
            period = "1H" + year[-2:]
        else:
            return [], ["财年与日历年期间需要确认"], []
        # Use the reported year first and its comparative second, with the unit printed in the same table.
        for page, body in enumerate(pages, 1):
            if page != 1 and not re.match(r"\s*(?:簡明)?合併損益表",body):
                continue
            if not re.search(year + r"年\s+" + str(int(year)-1) + r"年", body) or "人民幣千元" not in body:
                continue
            if not any(x in body for x in ("財務業績摘要", "研發開支", "經營虧損")):
                continue
            scope = "合并"
            for line in body.splitlines():
                compact = "".join(line.split())
                if compact == "終止經營業務":
                    scope = "终止经营"
                elif compact == "持續經營業務":
                    scope = "持续经营"
                nums = list(NUM.finditer(line))
                if len(nums) < 2:
                    continue
                label = "".join(line[:nums[0].start()].split())
                if len(nums) == 3 and re.search(r"附註\s+人民幣千元", body) and re.fullmatch(r"\d{1,2}", nums[0][1]):
                    nums = nums[1:]
                clean = re.sub(r"^持續經營業務的?", "", label)
                if clean not in HK and label and len(label)<60 and "經營業務" != label:
                    gaps.append(dict(period=period,metric=label,page=page,reason="披露表中的其他科目，未自动写回"))
                if clean in HK:
                    metric = HK[clean]
                    local = "持续经营" if label.startswith("持續經營業務") else scope
                    if metric == "Profit after tax" and scope == "终止经营" and clean == label:
                        # The statement has first presented the separate discontinued result.
                        if not re.search(r"終止經營業務(?:利潤|虧損)", body[:body.find(line)]):
                            continue
                        local = "合并"
                    # A statement may continue the scope from its preceding page.
                    if period.startswith("1H") and "持續經營業務" in text[:5000] and local == "合并" and metric != "Profit after tax":
                        continue
                    add(metric, nums[0][1], Decimal(".001"), page, period, "period", local, label, nums[1][1])
    else:
        year, q = quarter[1], QUARTERS[quarter[2]]
        p = f"{q}Q{year[-2:]}"
        statement = summary = False
        for page, body in enumerate(pages, 1):
            if "主要会计数据和财务指标" in body:
                summary_page, summary_order = page, None
                axis = next((s for s in body.splitlines() if "本报告期" in s and "年初至报告期末" in s and "本报告期比" not in s), "")
                summary = (bool(axis) and
                           re.search(r"单位[：:]\s*元\s+币种[：:]\s*人民币", body))
            lines = body.splitlines()
            for i, line in enumerate(lines):
                if line.strip() == "合并利润表":
                    section = "\n".join(lines[i:i+10])
                    heading = next((row for row in lines[i:i+10] if year in row and str(int(year)-1) in row), "")
                    statement = bool(heading and re.search(rf"{year}\s*年\s*1\s*[-—－至]\s*{q*3}\s*月", section)
                                     and re.search(r"单位[：:]\s*元\s+币种[：:]\s*人民币", section))
                    if statement:
                        current_year_column = int(heading.index(year) > heading.index(str(int(year)-1)))
                    else:
                        gaps.append(dict(period=p, metric="合并利润表", page=page, reason="累计区间、金额单位或两年列头无法核对"))
                    summary = False
                    continue
                if line.strip() in ("合并现金流量表", "母公司利润表", "合并资产负债表"):
                    statement = summary = False
                if summary and re.search("非经常性损益项目和金额|报告期末比", line):
                    summary = False
                if statement and re.search(r"20\d{2}\s*年", line):
                    continue
                nums = list(NUM.finditer(line))
                if not nums:
                    continue
                label = line[:nums[0].start()].strip()
                prev = lines[i-1].strip() if i else ""
                following = lines[i+1].strip() if i+1 < len(lines) else ""
                if summary:
                    if label.startswith("不适用"):
                        label = prev + following
                        gaps.append(dict(period=p, metric=label, page=page, reason="单季度未披露独立金额"))
                        continue
                    label = label or (prev + following)
                    if label not in CN:
                        if label and len(line[nums[0].start():].split())==4:
                            gaps.append(dict(period=p,metric=label,page=page,reason="披露摘要科目尚未映射"))
                        continue
                    # Quarter, YoY, YTD, YoY. Keep non-applicable markers in position.
                    tokens = line[nums[0].start():].split()
                    if len(tokens) != 4:
                        gaps.append(dict(period=p,metric=label,page=page,reason="单季与累计金额列不完整"))
                        continue
                    # Locate both values by their full period headers, independently of column order.
                    headers = column_centres(axis, [(axis.index(h),axis.index(h)+len(h)) for h in ("本报告期","年初至报告期末")])
                    spans = [m.span() for m in re.finditer(r"\S+",line) if m.start()>=nums[0].start()]
                    centres = column_centres(line, spans)
                    selected = [min(range(len(centres)),key=lambda j:abs(centres[j]-h)) for h in headers]
                    if page != summary_page and summary_order is not None:
                        selected = summary_order
                    current_index, ytd_index = selected
                    if current_index==ytd_index:
                        gaps.append(dict(period=p,metric=label,page=page,reason="单季与累计列坐标重叠"))
                        continue
                    if not re.fullmatch(AMOUNT,tokens[current_index]) or not re.fullmatch(AMOUNT,tokens[ytd_index]):
                        gaps.append(dict(period=p,metric=label,page=page,reason="本期或累计金额未披露可用数值"))
                        continue
                    if summary_order is not None and selected != summary_order:
                        gaps.append(dict(period=p,metric=label,page=page,reason="金额列位置与表头不一致"))
                        continue
                    summary_order = selected
                    metric = CN[label]
                    per_share = metric.startswith("EPS")
                    add(metric, tokens[current_index], Decimal(1) if per_share else Decimal(".000001"), page, p,
                        "period", "合并", label, unit="RMB/share" if per_share else "RMB mn", ytd=None if per_share else tokens[ytd_index])
                elif statement and len(nums) == 2:
                    raw_label = (label or prev)
                    normalized = re.sub(r"^(?:[0-9]+\.|其中：|减：|加：)", "", raw_label).strip()
                    normalized = re.split(r"[（(]", normalized)[0].strip()
                    if normalized and normalized not in FLOWS and not normalized.startswith(("其中","项目")):
                        gaps.append(dict(period=p,metric=normalized,page=page,reason="累计利润表披露，未作单季写回"))
                    if normalized in FLOWS:
                        add(FLOWS[normalized], nums[current_year_column][1], Decimal(".000001"), page, p, "yearToDate", "合并", raw_label)
    return list(facts.values()), list(dict.fromkeys(issues)), gaps
