"""Read reported periods from financial tables. This module never opens a workbook."""
import re
import subprocess
from datetime import datetime
from financial_statements import read_chinese_tables
from parse_pdf import open_pypdf, extract_tables


NUMBER = r"(?:\(\d[\d,]*(?:\.\d+)?\)|-?\d[\d,]*(?:\.\d+)?|[–—])"
DATE = r"(\d{1,2} [A-Za-z]+ 20\d{2})"


def period(date, quarterly):
    day = datetime.strptime(date.title(), "%d %B %Y")
    return f"{(day.month + 2) // 3}Q{str(day.year)[2:]}" if quarterly else f"FY{day.year}"


def parse_disclosure(text):
    facts, issues, seen, gaps = {}, [], set(), []
    annual = re.search(r"FOR THE YEAR ENDED\s+" + DATE, text[:5000], re.I)
    interim = re.search(r"(?:THREE(?: AND NINE)? MONTHS|QUARTER) ENDED\s+" + DATE, text[:5000], re.I)
    if not annual and not interim:
        return [], ["Unsupported announcement period or layout"], []
    end = (annual or interim)[1].title()
    tencent = bool(re.search(r"Stock\s+Codes?:\s*0*700\s*\(HKD counter\)\s+and\s+80700\b", text[:3500], re.I))
    fy, quarter = period(end, False), period(end, True)

    def add(key, raw, page, unit="RMB mn", label=None):
        value = float(raw.replace(",", "").replace("(", "-").replace(")", "").replace("–", "0").replace("—", "0"))
        row = dict(period=key[0], metric=key[1], label=label or key[1], expected=value,
                   unit=unit, decimals=len(raw.rstrip(")").partition(".")[2]), page=page,
                   **({"issuer": {"code": "700", "market": "HK", "name": "Tencent"}} if tencent else {}))
        if key in facts and facts[key]["expected"] != value:
            issues.append(f"Conflicting published values: {key[0]} {key[1]} (page {page})")
        else:
            facts.setdefault(key, row)

    for page, body in enumerate(text.split("\f"), 1):
        if "RMB in millions" not in body and "RMB’Million" not in body:
            continue
        lines = body.splitlines()
        # Reconciliation columns carry footnote letters aligned with the values.
        # Only decode a known heading sequence with the right width and a tied total.
        if "Adjustments" in body and "Non-IFRS" in body:
            for group in re.split(r"(?i)(?=(?:Unaudited three months|Year) ended \d{1,2} [a-z]+ 20\d{2})", body):
                head = re.match(r"(Unaudited three months|Year) ended " + DATE, group, re.I)
                row = re.search(r"^Operating profit\s{2,}(.+)$", group, re.M)
                if not head or head[2].title() != end or not row:
                    continue
                p = period(end, "months" in head[1].lower())
                header = group[:row.start()]
                nums = row[1].split()
                # Anchor each concept to its visual column. Tokens may span
                # several header lines, so ordering by text reading order is unsafe.
                anchors = {"Share-based": "Share-based compensation", "Investee": "Investee companies",
                           "Amortisation": "Amortisation of intangible assets", "Impairment": "Impairment provisions",
                           "SSV": "SSV & CPP", "Income tax": "Income tax effects"}
                if re.search(r"\bOthers\b", header):
                    anchors["Others"] = "Others"
                positions = []
                for token, field in anchors.items():
                    positions_for_field = [m.start() for line in header.splitlines()
                                           for m in re.finditer(re.escape(token), line, re.I)]
                    if len(positions_for_field) == 1:
                        positions.append((positions_for_field[0], field))
                fields = ["reported", *(field for _, field in sorted(positions)), "non-IFRS"]
                if (len(positions) != len(anchors) or len({pos for pos, _ in positions}) != len(anchors)
                        or len(nums) != len(fields) or not all(re.fullmatch(NUMBER, n) for n in nums)):
                    issues.append(f"Unrecognized operating profit reconciliation: {p}, page {page}")
                    continue
                seen.add((p, "bridge"))
                for field, n in zip(fields, nums):
                    key = {"reported": "Operating profit", "non-IFRS": "Non-IFRS operating profit"}.get(field, "Operating adjustment / " + field)
                    add((p, key), n, page)
                bridge = [facts[(p, "Operating adjustment / " + f)]["expected"] for f in fields[1:-1]]
                if abs(facts[(p, "Operating profit")]["expected"] + sum(bridge) - facts[(p, "Non-IFRS operating profit")]["expected"]) > 1:
                    issues.append(f"Operating profit reconciliation does not add up: {p}, page {page}")
            continue
        # EPS footnote tables begin after the pair of year headings.
        if annual and re.search(r"\([ab]\)\s+(Basic|Diluted)\s*$", body, re.M):
            chunk = re.split(r"\([ab]\)\s+(?:Basic|Diluted)\s*\n", body)[-1]
            heading = re.search(r"^\s*" + end[-4:] + r"\s+20\d{2}\s*$", chunk, re.M)
            if not heading:
                continue
            prev = []
            for line in chunk[heading.end():].splitlines():
                if re.match(r"^\s*\d+\s+[A-Z]", line):
                    break
                m = re.match(r"^\s*(\S.*?)\s{2,}(" + NUMBER + r")\s+(" + NUMBER + r")\s*$", line)
                if not m:
                    if line.strip():
                        prev.append(line.strip())
                    continue
                label = " ".join([*prev, m[1]])
                prev = []
                if "Weighted average number" in label:
                    key = "Diluted weighted average shares" if "calculation of diluted" in label else "Basic weighted average shares"
                elif "Dilution effect arising" in label:
                    key = "Dilution effect on earnings"
                elif "for the calculation of diluted EPS" in label:
                    key = "Diluted earnings numerator"
                elif "Adjustments for share options" in label:
                    key = "Dilutive share awards"
                else:
                    continue
                add((fy, key), m[2], page, "mn shares" if "shares)" in label else "RMB mn", label)
                seen.add((fy, "EPS note"))
            continue
        # Only process current columns in the highlights and comparative income statement.
        if not re.search(r"^Revenues\s{2,}" + NUMBER, body, re.M):
            continue
        before = body[:re.search(r"^Revenues\s{2,}", body, re.M).start()]
        table = re.search(r"^\s*(Three months ended|Year ended)\b([^\n]*(?:\n[^\n]*){0,8})", before, re.M | re.I)
        if not table:
            continue
        first_day = re.search(r"\b(\d{1,2} [A-Za-z]+)\b", table[2])
        first_year = re.search(r"\b(20\d{2})\b", table[2])
        if not first_day or not first_year or first_day[1].title() + " " + first_year[1] != end:
            issues.append(f"Unresolved current-period column on page {page}")
            continue
        if table[1].lower().startswith("three"):
            p = quarter
        elif annual:
            p = fy
        else:
            continue
        seen.add((p, "income"))
        prev, eps = "", ""
        for line in body[re.search(r"^Revenues\s{2,}", body, re.M).start():].splitlines():
            label = line.strip()
            if "EPS (RMB per share)" in label:
                eps = "Non-IFRS EPS" if "Non-IFRS" in label else "EPS"
                prev = ""
                continue
            m = re.match(r"^\s*(\S.*?)\s{2,}(" + NUMBER + r")\s{2,}" + NUMBER, line)
            if not m:
                if label and re.search(r"[a-z]", label, re.I):
                    prev = label if not label.endswith(":") else ""
                continue
            label = (prev + " " + m[1]).strip()
            prev = ""
            if re.fullmatch(r"[–—-]\s*(basic|diluted)", label):
                add((p, eps + " " + label.split()[-1]), m[2], page, "RMB/share")
            elif not re.fullmatch(NUMBER, label):
                if label == "Equity holders of the Company":
                    label = "Profit attributable to equity holders of the Company"
                add((p, label), m[2], page)
    sections = [(quarter, "income"), (quarter, "bridge")]
    if annual:
        sections.extend([(fy, "income"), (fy, "bridge"), (fy, "EPS note")])
    for p, section in sections:
        if (p, section) not in seen:
            gaps.append(dict(period=p, metric=section, reason="Section not located in the supplied disclosure"))
    if annual:
        for key in ("Basic weighted average shares", "Diluted weighted average shares", "Diluted earnings numerator"):
            if (fy, key) not in facts:
                gaps.append(dict(period=fy, metric=key, reason="Metric not located in the EPS note"))
    return list(facts.values()), list(dict.fromkeys(issues)), gaps


def explicit_period_tables(path):
    """Read explicitly labelled period and unit columns in ruled disclosures."""
    facts, gaps = {}, []
    for table in extract_tables(path, None, complete=True):
        header, *rows = table["data"]
        units = [i for i, label in enumerate(header) if label.casefold() in ("unit", "单位")]
        if len(units) != 1 or header[0].casefold() not in ("metric", "item", "科目", "项目", "指标"):
            continue
        periods = [(i, label.upper()) for i, label in enumerate(header)
                   if re.fullmatch(r"FY20\d{2}|[1-4]Q\d{2}", label, re.I)]
        for col, period_name in periods:
            for row in rows:
                label = row[0] if row else ""
                raw = row[col] if len(row) > col else ""
                unit = row[units[0]] if len(row) > units[0] else ""
                if not label or not unit or not re.fullmatch(NUMBER, raw) or raw in ("–", "—"):
                    gaps.append(dict(period=period_name, metric=label or "未命名行", reason="缺少单位或数值"))
                    continue
                key = period_name, label
                value = float(raw.replace(",", "").replace("(", "-").replace(")", ""))
                fact = dict(period=period_name, metric=label, expected=value, unit=unit,
                            decimals=len(raw.rstrip(")").partition(".")[2]), page=table["page"])
                if key in facts and (facts[key]["expected"], facts[key]["unit"]) != (value, unit):
                    return [], ["Conflicting disclosure rows: " + label], gaps
                facts.setdefault(key, fact)
    return list(facts.values()), [], gaps


def read_tencent_chinese(path):
    """Read Tencent's Traditional Chinese HKEX highlights, bridges and EPS notes."""
    from parse_pdf import open_pdfplumber

    with open_pdfplumber(path) as pdf:
        pages = [page.extract_text(layout=True) or "" for page in pdf.pages]
    cover = "".join(pages[0].split())
    if not re.search(r"股份代號[：:]0*700[（(]港幣櫃台", cover):
        return None
    annual = re.search(r"截至([二零〇一三四五六七八九]{4})年十二月三十一日止年度", cover)
    if not annual:
        return None
    digits = str.maketrans("零〇一二三四五六七八九", "00123456789")
    year = annual[1].translate(digits)
    fy, quarter = "FY" + year, "4Q" + year[-2:]
    facts, issues = {}, []

    def add(period, metric, raw, page, unit="RMB mn"):
        value = float(raw.replace(",", "").replace("(", "-").replace(")", "").replace("–", "0").replace("—", "0"))
        item = dict(period=period, metric=metric, label=metric, expected=value, unit=unit,
                    decimals=len(raw.rstrip(")").partition(".")[2]), page=page,
                    issuer={"code": "700", "market": "HK", "name": "Tencent"})
        previous = facts.setdefault((period, metric), item)
        if previous["expected"] != value:
            issues.append(f"{period} {metric} 的披露值不一致（第 {page} 页）")

    labels = {
        "收入": "Revenues", "毛利": "Gross profit", "經營盈利": "Operating profit",
        "本公司權益持有人應佔盈利": "Profit attributable to equity holders of the Company",
        "非國際財務報告準則經營盈利": "Non-IFRS operating profit",
        "非國際財務報告準則本公司權益持有人應佔盈利": "Non-IFRS profit attributable to equity holders of the Company",
    }
    for i, body in enumerate(pages[:2], 1):
        if "人民幣百萬元" not in body:
            continue
        period = quarter if i == 1 else fy
        eps, pending = "EPS", ""
        for line in body.splitlines():
            parts = line.strip().split()
            values = [part for part in parts if re.fullmatch(NUMBER, part)]
            label = "".join(parts[:parts.index(values[0])]) if values else "".join(parts)
            if "每股盈利" in label:
                eps = "Non-IFRS EPS" if label.startswith("非國際") else "EPS"
            if label == "非國際財務報告準則本公司":
                pending = label
            if values and label:
                label, pending = pending + label, ""
                if label in labels:
                    add(period, labels[label], values[0], i)
                elif label in ("－基本", "－攤薄"):
                    add(period, eps + (" basic" if label.endswith("基本") else " diluted"), values[0], i, "RMB/share")

    year_zh = annual[1]
    bridge_columns = ("Share-based compensation", "Investee companies", "Amortisation of intangible assets",
                      "Impairment provisions", "SSV & CPP", "Others", "Income tax effects")
    for page, body in enumerate(pages, 1):
        compact = "".join(body.split())
        if "人民幣百萬元" not in compact:
            continue
        # Figures are read only from the current year's first bridge and its known column order.
        bridge = re.search(r"^\s*經營盈利\s+(.+)$", body, re.M)
        head = "".join(body[:bridge.start()].split()) if bridge else ""
        _, found, columns_text = head.rpartition(year_zh + "年十二月三十一日止")
        if (bridge and found and
                all(label in columns_text for label in ("已報告", "股份酬金", "攤銷", "SSV", "所得稅"))):
            period = quarter if columns_text.startswith("三個月") else fy
            numbers = bridge[1].split()
            columns = bridge_columns if "其他" in columns_text else tuple(name for name in bridge_columns if name != "Others")
            if len(numbers) == len(columns) + 2 and all(re.fullmatch(NUMBER, n) for n in numbers):
                add(period, "Operating profit", numbers[0], page)
                add(period, "Non-IFRS operating profit", numbers[-1], page)
                for label, value in zip(columns, numbers[1:-1]):
                    add(period, "Operating adjustment / " + label, value, page)
                bridge_total = sum(facts[(period, metric)]["expected"] for metric in
                                   ("Operating profit", *("Operating adjustment / " + label for label in columns)))
                if abs(bridge_total - facts[(period, "Non-IFRS operating profit")]["expected"]) > 1:
                    issues.append(f"{period} 非 IFRS 经营盈利加回对账失败（第 {page} 页）")
        if year_zh not in compact or not re.search(r"\([ab]\)\s*(?:基本|攤薄)", body):
            continue
        pending = ""
        for line in body.splitlines():
            tokens = line.strip().split()
            if not tokens:
                continue
            if len(tokens) >= 2 and all(re.fullmatch(NUMBER, n) for n in tokens[-2:]):
                label = pending + "".join(tokens[:-2])
                pending = ""
                if "為計算每股攤薄盈利的普通股的加權平均數" in label:
                    add(fy, "Diluted weighted average shares", tokens[-2], page, "mn shares")
                elif "為計算每股攤薄盈利的本公司" in label:
                    add(fy, "Diluted earnings numerator", tokens[-2], page)
                elif "獎勵產生的攤薄影響" in label:
                    add(fy, "Dilution effect on earnings", tokens[-2], page)
                elif "加權平均數（百萬股計）" in label and "普通股" in label:
                    add(fy, "Basic weighted average shares", tokens[-2], page, "mn shares")
            else:
                pending += "".join(tokens)
                pending = pending[-140:]
    required = [(fy, name) for name in ("Basic weighted average shares", "Diluted weighted average shares",
                                        "Diluted earnings numerator", "Operating adjustment / SSV & CPP")]
    gaps = [dict(period=p, metric=m, reason="未从公告确认该项目") for p, m in required if (p, m) not in facts]
    return list(facts.values()), list(dict.fromkeys(issues)), gaps


def read_disclosure(path):
    try:
        reader = open_pypdf(path)
        text = "\f".join(page.extract_text(extraction_mode="layout") for page in reader.pages)
    except Exception:
        # Older pypdf releases and some PDFs require the original layout reader.
        text = ""
    if re.search(r"公司|集團|集团", text[:2500]) or not text:
        try:
            layout = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"],
                                    capture_output=True, check=True, timeout=60).stdout.decode("utf-8")
        except (OSError, subprocess.SubprocessError):
            layout = text
        chinese = read_chinese_tables(layout)
        if chinese is not None:
            return chinese
    facts, issues, gaps = parse_disclosure(text)
    if not facts:
        try:
            translated = read_tencent_chinese(path)
        except (ImportError, RuntimeError):
            translated = None
        if translated and translated[0]:
            return translated
        structured = explicit_period_tables(path)
        if structured[0] or structured[1]:
            return structured
    if facts and (issues or not gaps):
        return facts, issues, gaps
    try:
        layout = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"],
                                capture_output=True, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        if not text:
            raise
        return facts, issues, gaps
    laid_out = layout.stdout.decode("utf-8")
    fallback = read_chinese_tables(laid_out) or parse_disclosure(laid_out)
    if any(fact not in fallback[0] for fact in facts):
        return facts, ["Layout readers disagree on the disclosed facts"], gaps
    return fallback


if __name__ == "__main__":
    import json
    import sys
    facts, issues, gaps = read_disclosure(sys.argv[1])
    print(json.dumps(dict(facts=facts, issues=issues, sourceGaps=gaps)))
