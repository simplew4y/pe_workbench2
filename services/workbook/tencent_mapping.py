"""Bind Tencent's audited results to its consolidated research workbook layout."""
from collections import defaultdict
from openpyxl.utils import get_column_letter
from parse_workbook import period_band, row_text_labels

INPUTS = {
    "Revenues": ("Total revenues", "RMB mn"),
    "Gross profit": ("Gross profit", "RMB mn"),
    "Operating profit": ("Operating profit, GAAP, new def", "RMB mn"),
    "Profit attributable to equity holders of the Company": ("Net profit, GAAP", "RMB mn"),
    "Non-IFRS profit attributable to equity holders of the Company": ("Net profit, non-GAAP", "RMB mn"),
    "Basic weighted average shares": ("Basic shares, weighted average (mn)", "mn shares"),
    "Diluted weighted average shares": ("Diluted shares, weighted average (mn)", "mn shares"),
}
BRIDGE = {
    "Operating adjustment / Share-based compensation": "Share-based compensation",
    "Operating adjustment / Amortisation of intangible assets": "Amortization of intangibles",
    "Operating adjustment / SSV & CPP": "SSV & CPP",
    "Operating adjustment / Others": "Others",
}
EPS = {
    "EPS basic": "GAAP EPS, basic (Rmb)",
    "EPS diluted": "GAAP EPS, diluted (Rmb)",
    "Non-IFRS EPS diluted": "Non-GAAP EPS, diluted (Rmb)",
}
NUMERATOR = "Diluted earnings numerator"
NUMERATOR_LABEL = "Disclosed diluted earnings numerator (RMB mn)"


def map_tencent_statement(book, ws, header, inventory, edits, outputs):
    rows = list(ws.values)
    if "Year to 31 Dec, Rmb mn" not in rows[header][:8]:
        return [], [dict(f, reason="损益表缺少人民币百万元单位") for f in inventory], []
    axis = period_band(header, rows[header - 1])
    columns = defaultdict(list)
    for col, (_, label, _) in axis.items():
        columns[label.upper().removeprefix("FY").rstrip("AE")].append(col)
    labels = defaultdict(list)
    for number, row in enumerate(rows, 1):
        for label in set(row_text_labels(row[:4])):
            labels["SSV & CPP" if label.startswith("SSV & CPP (") else label].append(number)
    gaap = labels["Operating profit, GAAP, new def"]
    adjusted = labels["Operating profit, non-GAAP, new def"]
    unique = lambda label: labels[label][0] if len(labels[label]) == 1 else None
    by_metric = {(f["period"], f["metric"]): f for f in inventory}
    planned = {}
    mapped, gaps = [], []
    if "SOTP" in book.sheetnames:
        sheet = book["SOTP"]
        if (sheet["B134"].value == "NAV" and sheet["J2"].value == "HK$/sh" and
                sheet["J134"].data_type == "f"):
            outputs.append(dict(sheet="SOTP", cell="J134", label="SOTP 公式估值（HKD/股）"))
            if isinstance(sheet["H1"].value, (int, float)) and sheet["H1"].value != 0 and sheet["B2"].value == "SUM of PARTS":
                edits.append(dict(sheet="SOTP", cell="H1", value="=J134", note="恢复首页显示与 SOTP 估值公式的链接"))
                outputs.append(dict(sheet="SOTP", cell="H1", label="首页估值（HKD/股）", formula="=J134"))

    def edit(address, value, note):
        if ws[address].value != value:
            edits.append(dict(sheet=ws.title, cell=address, value=value, note=note))

    def extra_row(label):
        if label not in planned:
            existing = unique(label)
            planned[label] = existing or max([ws.max_row, *planned.values()]) + 1
            if not existing:
                edit("B" + str(planned[label]), label, "注明公告输入或仅披露指标")
        return planned[label]

    def choose_row(metric):
        if metric in BRIDGE:
            candidates = [r for r in labels[BRIDGE[metric]] if len(gaap) == len(adjusted) == 1 and gaap[0] < r < adjusted[0]]
            return candidates[0] if len(candidates) == 1 else None
        if metric == "Revenues":
            candidates = [r for r in labels["Total revenues"] if len(gaap) == 1 and r < gaap[0]]
            return min(candidates, default=None)
        if metric == "Gross profit":
            candidates = [r for r in labels["Gross profit"] if len(gaap) == 1 and r < gaap[0]]
            return max(candidates, default=None)
        if metric == "Non-IFRS operating profit":
            return unique("Operating profit, non-GAAP, new def")
        if metric == "Non-IFRS EPS basic":
            return extra_row("Disclosed Non-IFRS EPS basic (RMB/share)")
        if metric == NUMERATOR:
            return extra_row(NUMERATOR_LABEL)
        return unique(INPUTS[metric][0]) if metric in INPUTS else unique(EPS[metric]) if metric in EPS else None

    supplemental = {}
    for fact in inventory:
        period, metric = fact["period"], fact["metric"]
        column = columns[period.removeprefix("FY")]
        if len(column) > 1:
            gaps.append(dict(fact, reason="同一期间有多个列头"))
            continue
        row = choose_row(metric)
        if not row:
            gaps.append(dict(fact, reason="没有确认的同口径科目"))
            continue
        unit = INPUTS.get(metric, (None, "RMB/share" if "EPS" in metric else "RMB mn"))[1]
        if unit != fact["unit"]:
            gaps.append(dict(fact, reason="公告单位和模型科目不一致"))
            continue
        mode, formula, caption = "actual", None, None
        if not column:
            if not period.startswith(("1Q", "2Q", "3Q", "4Q", "1H", "2H")):
                gaps.append(dict(fact, reason="模型没有对应年度"))
                continue
            caption = period + " [披露·合并]"
            if caption not in supplemental:
                existing = [i for i, v in enumerate(rows[header-1], 1) if v == caption]
                supplemental[caption] = existing[0] if len(existing) == 1 else max([ws.max_column, *supplemental.values()]) + 1
                edit(get_column_letter(supplemental[caption]) + str(header), caption, "新增披露列，保留原全年预测")
            column = [supplemental[caption]]
        letter = get_column_letter(column[0])
        if metric in EPS and not caption:
            shares = "Basic weighted average shares" if metric == "EPS basic" else "Diluted weighted average shares"
            if metric == "EPS diluted" and (period, NUMERATOR) in by_metric and (period, shares) in by_metric:
                mode = "formula"
                formula = f"={letter}{extra_row(NUMERATOR_LABEL)}/{letter}{choose_row(shares)}"
            elif (period, shares) in by_metric and metric == "EPS basic":
                mode = "check"
            else:
                # The announcement provides EPS but lacks the corresponding model numerator or denominator.
                row = extra_row("Disclosed " + metric + " (RMB/share)")
        if metric == "Non-IFRS operating profit" and not caption:
            mode = "check"
        mapped.append(dict(sheet=ws.title, cell=letter+str(row), header=letter+str(header),
                           metric=metric, period=period, unit=unit, expected=fact["expected"],
                           decimals=fact["decimals"], source=fact["source"]+"#page="+str(fact["page"]),
                           mode=mode, **({"formula": formula} if formula else {}),
                           **({"caption": caption} if caption else {})))
    return mapped, gaps, []
