"""Bind statutory flows to one income statement and preserve the model's historical identities."""
import re
from collections import defaultdict
from decimal import Decimal
from openpyxl.formula.translate import Translator
from openpyxl.utils import get_column_letter
from parse_workbook import period_band


# Model labels, scoped to the income statement and its financial rows.
LABELS = {
    "Revenue": ("Revenue", "Revenues", "Sales"), "Gross profit": ("Gross profits", "Gross profit", "Gross profit/(loss)"),
    "Operating profit": ("Operating profit", "Profit / (Loss) from operation", "Operating income"),
    "Profit after tax": ("Net profit / (loss) after tax", "Profit after tax"),
    "Attributable profit": ("Net income attributable to shareholders", "Net income"),
    "Pretax income": ("Pretax income", "Profit / (Loss) before income tax"),
    "Cost of sales": ("COGS", "Cost of sales"), "Sales tax": ("Sales tax",),
    "Selling expense": ("Selling", "Sales expense"), "Administrative expense": ("G&A", "G&A expense"),
    "R&D expense": ("R&D", "R&D expense"), "Interest expense": ("Interest expense",),
    "Interest income": ("Interest income",), "Investment income": ("Investment income (net)",),
    "Asset impairment": ("Impairment loss (net)",), "Disposal gain": ("Disposal (net)",),
    "Income tax": ("Tax", "Income tax expense"), "Minority income": ("Minority", "Minority interest expense"),
    "EPS basic": ("EPS (basic)", "Basic EPS (Rmb)"), "EPS diluted": ("EPS (diluted)", "Diluted EPS (Rmb)"),
}
STATEMENT = re.compile(r"^(?:P\s*&\s*L|income statement|profit and loss|合并利润表)(?:\s*\(.*\))?$", re.I)
MILLIONS = re.compile(r"(?:RMB|CNY)\s*(?:mn|million)s?\b|人民币百万元", re.I)


def issuer_matches(book, issuer, filename):
    identity = [re.sub(r"\.xlsx$", "", filename, flags=re.I)]
    for sheet in book.worksheets:
        if re.search("cover|封面",sheet.title,re.I):
            identity.extend(str(v) for row in sheet.iter_rows(max_row=15,max_col=8,values_only=True) for v in row if isinstance(v,str))
        else:
            header = list(sheet.iter_rows(max_row=8, max_col=3, values_only=True))
            if any(str(v).strip().casefold() == "consolidated income statement" for row in header for v in row):
                identity.append(str(header[0][1] or ""))
    titles = " ".join(identity).replace("+"," ").replace("_"," ")
    tickers = {(str(int(n)), "HK" if market.upper()=="HK" else "CN") for n,market in
               re.findall(r"(?<!\d)(\d{3,6})\.(HK|SS|SH|SZ)\b",titles,re.I)}
    code = str(int(issuer["code"])) if issuer.get("code") else ""
    name = issuer.get("name", "").strip().casefold()
    name_ok = bool(name) and any(name == value.strip().casefold() for value in identity)
    return tickers == {(code, issuer.get("market"))} if tickers else name_ok


def map_statements(book, cached, facts, filename="", reported=None):
    reported = reported or {}
    issuer = facts[0].get("issuer", {})
    if not issuer_matches(book, issuer, filename) or any(f.get("issuer", {}) != issuer for f in facts):
        return [], [dict(f,reason="公告发行人与原模型名称或封面证券代码未能核对") for f in facts], []

    candidates = []
    for sheet in book.worksheets:
        top = list(sheet.iter_rows(max_row=8, values_only=True))
        text = [v.strip() for row in top for v in row[:3] if isinstance(v, str)]
        if not any(STATEMENT.fullmatch(v) for v in text) or not any(MILLIONS.search(v) for v in text):
            continue
        for n, row in enumerate(top, 1):
            band = period_band(n, row)
            if len(band) >= 2:
                candidates.append((sheet, n, band))
                break
    if len(candidates) != 1:
        return [], [dict(f, reason="缺少唯一的合并损益表及金额单位") for f in facts], []
    ws, header, axis = candidates[0]
    values = cached[ws.title]
    rows = list(ws.values)
    labels = defaultdict(list)
    first_col = min(axis)
    # Stop at the next section with another dated axis; expense and margin schedules can repeat labels.
    in_statement = False
    for n, row in enumerate(rows[header:], header+1):
        if len(period_band(n, row)) >= 2 and all(isinstance(v, (str, int, type(None))) for v in row):
            break
        names = [v.strip().casefold() for v in row[:first_col-1] if isinstance(v,str)]
        if in_statement and not names:
            break
        in_statement |= any(v in ("revenue", "revenues", "sales") for v in names)
        for v in row[:first_col-1]:
            if isinstance(v, str):
                labels[v.strip().casefold()].append(n)
    columns = defaultdict(list)
    for c, (_, token, raw) in axis.items():
        columns[token.upper().rstrip("AE").removeprefix("FY")].append(c)
    # Tie the already reported quarters to an independent current-quarter and YTD amount.
    # A stale/restated or differently scoped first half invalidates cumulative subtraction.
    def actual_quarter(c, row):
        label = str(ws.cell(header,c).value).strip().upper()
        if re.fullmatch(r"[1-4]Q(?:\d{2}|20\d{2})(?:A| ACTUAL)?",label):
            return True
        record = reported.get(ws.title + "!" + ws.cell(row, c).coordinate, {})
        expected = record.get("expected")
        value = values.cell(row, c).value
        return (record.get("period") == label.removesuffix("E") and
                record.get("scope") == "合并" and record.get("issuer") == issuer and
                isinstance(expected, (float, int)) and isinstance(value, (float, int)) and
                abs(expected - value) < 1e-8)

    tied = 0
    for f in facts:
        if "yearToDateReported" not in f:
            continue
        period = f["period"]
        matched = {n for name in LABELS.get(f["metric"], ()) for n in labels[name.casefold()]}
        if len(matched) != 1 or not columns[period]:
            continue
        row = matched.pop()
        prev = [columns[f"{q}Q{period[2:]}"] for q in range(1, int(period[0]))]
        if not all(len(cc) == 1 and actual_quarter(cc[0],row) for cc in prev):
            continue
        history = [values.cell(row,cc[0]).value for cc in prev]
        if not all(isinstance(v,(int,float)) for v in history):
            continue
        residual = sum(Decimal(str(v)) for v in history) + Decimal(str(f["expected"])) - Decimal(str(f["yearToDateReported"]))
        if abs(residual) > Decimal(1).scaleb(-f["decimals"]):
            return [], [dict(item, reason=f["metric"] + " 期初至今与已披露各季合计不符，请核对主体、重述及口径") for item in facts], []
        tied += 1
    mapped, gaps, edits = [], [], {}
    used = {}
    planned = {}
    def edit(addr, value, why):
        if ws[addr].value != value:
            edits[addr] = dict(sheet=ws.title, cell=addr, value=value, note=why)

    for f in facts:
        metric, period = f["metric"], f["period"]
        matches = set(n for name in LABELS.get(metric, ()) for n in labels[name.casefold()])
        if len(matches) != 1:
            gaps.append(dict(f, reason="损益表缺少唯一同义科目"))
            continue
        r = matches.pop()
        if metric == "Attributable profit" and str(rows[r-1][first_col-2]).strip().lower()=="net income":
            # A generic net income row must actually deduct non-controlling interests.
            minority = labels["minority"]
            if len(minority) != 1 or not any(re.search(rf"-\$?[A-Z]+\$?{minority[0]}\b", str(v)) for v in rows[r-1]):
                gaps.append(dict(f, reason="净利润归属口径无法确认"))
                continue
        cols = columns[period.removeprefix("FY")]
        col = cols[0] if len(cols)==1 else None
        if len(cols)>1:
            gaps.append(dict(f, reason="目标期间有多个列头"))
            continue
        old = ws.cell(r,col).value if col else None
        native_quarter = bool(col and "Q" in period and f["scope"]=="合并" and
                              str(ws.cell(header,col).value).upper().endswith("E"))
        amount = Decimal(str(f["expected"]))
        decimals = f["decimals"]
        evidence = f["label"]
        if f["basis"]=="yearToDate":
            q = int(period[0])
            preceding = [columns[f"{i}Q{period[2:]}"] for i in range(1,q)]
            if not tied or not native_quarter or not all(len(cc)==1 and actual_quarter(cc[0],r) for cc in preceding):
                gaps.append(dict(f, reason="累计数缺少同口径已披露季度"))
                continue
            prior = [values.cell(r,cc[0]).value for cc in preceding]
            if not all(isinstance(v,(float,int)) for v in prior):
                gaps.append(dict(f, reason="前序季度缺失数值"))
                continue
            # The source carries positive interest expense; this row uses a signed deduction.
            history = prior or [values.cell(r,c).value for c in axis if c<col and actual_quarter(c,r)]
            history = [v for v in history if isinstance(v,(int,float)) and v!=0]
            if metric=="Interest expense" and (not history or min(history)<0<max(history)):
                gaps.append(dict(f,reason="利息费用的模型符号无法确认"))
                continue
            sign = -1 if metric=="Interest expense" and all(v<0 for v in history) else 1
            if metric in ("Cost of sales","R&D expense","Administrative expense","Selling expense","Income tax") and history and all(v<0 for v in history):
                sign = -1
            amount = round(sign*amount - sum(Decimal(str(v)) for v in prior), decimals)
            evidence += "；累计数按模型符号扣除 " + "、".join(ws.cell(r,cc[0]).coordinate for cc in preceding)
        dest = ws.cell(r,col).coordinate if col else None
        compare = dest
        mode = "actual"
        if native_quarter:
            if metric in ("EPS basic","EPS diluted") and isinstance(old,str) and old.startswith("="):
                dest = None
            if metric=="Attributable profit" and isinstance(old,str) and old.startswith("="):
                mode = "check"
        elif (col and period.startswith("FY") and f["scope"]=="合并" and metric in
              ("R&D expense","Administrative expense","Selling expense") and isinstance(old,str)):
            # Follow the signed local input behind the statement line. Preserve its native check.
            pointer = re.fullmatch(r"=(-?)([A-Z]+[1-9]\d*)", old)
            if pointer and isinstance(ws[pointer[2]].value,(int,float)) and ws[pointer[2]].column==col:
                dest = pointer[2]
                amount = -amount if pointer[1] else amount
                evidence += "；沿用损益表到费用输入的原公式 " + old
            else:
                dest = None
        else:
            dest = None
        supplemental = dest is None
        caption = f'{period} [披露·{f["scope"]}]'
        if supplemental:
            if f["basis"]=="yearToDate":
                gaps.append(dict(f,reason="累计数不可直接替代本期实绩"))
                continue
            if caption not in planned:
                existing = [i for i,v in enumerate(rows[header-1],1) if v==caption]
                planned[caption] = existing[0] if len(existing)==1 else max([ws.max_column,*planned.values()])+1
            col = planned[caption]
            dest = get_column_letter(col)+str(r)
            edit(get_column_letter(col)+str(header),caption,"单列同期间、同口径的公告实绩，与原预测并列")
        item = dict(sheet=ws.title,cell=dest,header=get_column_letter(col)+str(header),metric=metric,period=period,
                    unit=f["unit"],expected=float(amount),decimals=decimals,mode=mode,
                    source=f['source']+'#page='+str(f['page']), evidence=evidence,scope=f["scope"],disclosed=f["expected"],
                    issuer=issuer, sourcePeriod=(f"{int(period[0])*3}M{period[2:]}" if f["basis"]=="yearToDate" else period),
                    **({"caption":caption} if supplemental else {}),
                    **({"priorReported":f['priorReported']} if 'priorReported' in f else {}))
        if supplemental and compare and f["scope"]=="合并":
            item["forecastRef"] = ws.title+"!"+compare
        mapped.append(item)
        if native_quarter and not supplemental:
            used[r] = col
    if used:
        # Restore same-period arithmetic followed by *both* preceding actual quarters. This reverses
        # forecast drivers (e.g. tax rate -> tax) into historic ratios (tax / pretax), without
        # copying period-specific hardcodes, estimates, references to other sheets or time lags.
        col = next(iter(used.values()))
        prior_cols = [col-2,col-1]
        if len(set(used.values()))==1 and min(prior_cols)>=1 and all(
                actual_quarter(c, row) for c in prior_cols for row in used):
            recorded = {i["cell"] for i in mapped if i["mode"]!="check"}
            letter = get_column_letter(col)
            for r in range(header+1,len(rows)+1):
                if r > header+1 and len(period_band(r,rows[r-1]))>=2:
                    break
                current = ws.cell(r,col)
                if current.coordinate in recorded or current.value is None:
                    continue
                expressions = []
                for c in prior_cols:
                    src = ws.cell(r,c)
                    if not isinstance(src.value,str) or not src.value.startswith("="):
                        break
                    translated = Translator(src.value,origin=src.coordinate).translate_formula(current.coordinate)
                    refs = re.findall(r"\$?([A-Z]+)\$?(\d+)",translated)
                    if not refs or any(a!=letter for a,_ in refs) or not re.fullmatch(r"=[A-Z0-9$+*/():-]+",translated):
                        break
                    # Only restore additive residuals, differences and rates. Avoid scenario logic.
                    if re.search(r"[A-Z]{2,}(?![A-Z0-9])",translated.replace("SUM(","(")):
                        break
                    expressions.append(translated)
                if len(expressions)==2 and expressions[0]==expressions[1] and any(
                        int(num) in used for _,num in re.findall(r"\$?([A-Z]+)\$?(\d+)",expressions[0])):
                    edit(current.coordinate,expressions[0],"沿用前两期实绩列一致的同季算式")
                    used[r] = col
    return mapped, gaps, list(edits.values())
