"""Read reported periods from financial tables. This module never opens a workbook."""
import re
import subprocess
from datetime import datetime
from parse_pdf import open_pypdf


NUMBER = r"(?:\(\d[\d,]*(?:\.\d+)?\)|-?\d[\d,]*(?:\.\d+)?|[–—])"
DATE = r"(\d{1,2} [A-Za-z]+ 20\d{2})"


def period(date, quarterly):
    day = datetime.strptime(date.title(), "%d %B %Y")
    return f"{(day.month + 2) // 3}Q{str(day.year)[2:]}" if quarterly else f"FY{day.year}"


def parse_disclosure(text):
    facts, issues, seen, gaps = {}, [], set(), []
    annual = re.search(r"FOR THE YEAR ENDED\s+" + DATE, text[:5000], re.I)
    interim = re.search(r"(?:THREE MONTHS|QUARTER) ENDED\s+" + DATE, text[:5000], re.I)
    if not annual and not interim:
        return [], ["Unsupported announcement period or layout"], []
    end = (annual or interim)[1].title()
    fy, quarter = period(end, False), period(end, True)

    def add(key, raw, page, unit="RMB mn", label=None):
        value = float(raw.replace(",", "").replace("(", "-").replace(")", "").replace("–", "0").replace("—", "0"))
        row = dict(period=key[0], metric=key[1], label=label or key[1], expected=value,
                   unit=unit, decimals=len(raw.rstrip(")").partition(".")[2]), page=page)
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
                fields = ["reported", "Share-based compensation", "Investee companies",
                          "Amortisation of intangible assets", "Impairment provisions", "SSV & CPP"]
                if re.search(r"\bOthers\b", header):
                    fields.append("Others")
                fields.extend(["Income tax effects", "non-IFRS"])
                if (not all(word in header for word in ("Share-based", "Amortisation", "Impairment", "SSV", "CPP", "effects"))
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
        before = body[:body.index("\nRevenues")]
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
        for line in body[body.index("\nRevenues"):].splitlines():
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


def read_disclosure(path):
    try:
        reader = open_pypdf(path)
        text = "\f".join(page.extract_text(extraction_mode="layout") for page in reader.pages)
    except Exception:
        # Older pypdf releases and some PDFs require the original layout reader.
        text = ""
    facts, issues, gaps = parse_disclosure(text)
    if facts and (issues or not gaps):
        return facts, issues, gaps
    try:
        layout = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"],
                                capture_output=True, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        if not text:
            raise
        return facts, issues, gaps
    fallback = parse_disclosure(layout.stdout.decode("utf-8"))
    if any(fact not in fallback[0] for fact in facts):
        return facts, ["Layout readers disagree on the disclosed facts"], gaps
    return fallback


if __name__ == "__main__":
    import json
    import sys
    facts, issues, gaps = read_disclosure(sys.argv[1])
    print(json.dumps(dict(facts=facts, issues=issues, sourceGaps=gaps)))
