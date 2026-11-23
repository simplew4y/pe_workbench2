"""Identify native check formulas and comparable periods on disclosed model rows."""
import json
import re
import sys
from openpyxl.utils import coordinate_to_tuple, get_column_letter
from openpyxl_safe import load_workbook_resilient


# A difference check has a referenced amount on the left and arithmetic
# on the right. A minus somewhere inside an arbitrary function is insufficient.
CELL = r"(?:(?:'[^']+'|[A-Z_][A-Z_0-9.]*)!)?(?:\$?[A-Z]{1,3}\$?[1-9][0-9]*|#REF!)"
TERM = rf"(?:{CELL}|SUM\({CELL}:{CELL}\)|[0-9]+(?:\.[0-9]+)?)"
DIFFERENCE = re.compile(rf"=\+?{CELL}(?:[+-](?:{TERM}|\({TERM}(?:[+-]{TERM})+\)))+", re.I)


def period_index(value):
    label = str(value).strip().upper()
    annual = re.fullmatch(r"(?:FY)?(20\d\d)[AE]?", label)
    if annual:
        return "year", int(annual[1])
    half = re.fullmatch(r"([12])H(\d{2}|20\d{2})[AE]?", label)
    if half:
        return "half", (2000 + int(half[2][-2:])) * 2 + int(half[1])
    quarterly = re.fullmatch(r"([1-4])Q(\d{2}|20\d{2})[AE]?", label)
    if quarterly:
        return "quarter", (2000 + int(quarterly[2][-2:])) * 4 + int(quarterly[1])
    return None


def check_tolerance(number_format):
    # Use the strictest displayed precision across numeric sections. Even a
    # whole-number display cannot excuse more than half a hundredth.
    tolerances = []
    for section in number_format.split(";")[:3]:
        fmt = re.sub(r'"[^"]*"|\\.|\[[^]]*\]|_.|\*.', "", section)
        if not fmt or fmt in ("-", "@"):
            continue
        if re.search(r"[A-Za-z/]|0,+(?![0#])", fmt):
            return None
        match = re.search(r"[0#][0#,]*(?:\.(0+))?", fmt)
        if not match:
            return None
        decimals = max(2, len(match[1] or ""))
        tolerances.append(0.5 * 10 ** -decimals / (100 if "%" in fmt else 1))
    return min(tolerances, default=None)


def layout(book, actuals):
    checks, comparisons, rules, tolerances = [], [], {}, {}
    for sheet in book.worksheets:
        items = [item for item in actuals if item["sheet"] == sheet.title]
        needed = {coordinate_to_tuple(i[k])[0] for i in items for k in ("header", "cell")}
        rows = {}
        for number, cells in enumerate(sheet.iter_rows(), 1):
            row = tuple(cell.value for cell in cells)
            if number in needed:
                rows[number] = row
            if any(isinstance(v, str) and v.strip().casefold() in
                   ("check", "balance check", "勾稽校验", "平衡校验") for v in row):
                for col, value in enumerate(row, 1):
                    if isinstance(value, str) and value.startswith("="):
                        ref = f"{sheet.title}!{get_column_letter(col)}{number}"
                        checks.append(ref)
                        # Numeric status codes (e.g. IF(condition,1,0)) need a
                        # declared meaning. Never infer a zero target for them.
                        expression = value.replace(" ", "")
                        if (re.fullmatch(rf"={CELL}(?:[+]{CELL})+", expression, re.I) or
                                DIFFERENCE.fullmatch(expression)) or re.fullmatch(r"=[+-]?0\.\d+", expression):
                            rules[ref] = "difference"
                            tolerance = check_tolerance(cells[col - 1].number_format or "General")
                            if tolerance is not None:
                                tolerances[ref] = tolerance
        for item in items:
            r, col = coordinate_to_tuple(item["cell"])
            if r not in rows:
                # A proposed disclosure-only row does not yet exist in the baseline.
                continue
            header, _ = coordinate_to_tuple(item["header"])
            periods = {}
            for j, value in enumerate(rows.get(header, ()), 1):
                key = period_index(value)
                if key:
                    periods.setdefault(key, []).append(j)
            current = period_index(item["period"])
            if not current or periods.get(current) != [col]:
                continue
            prior = periods.get((current[0], current[1] - 1), [])
            comparisons.append(dict(ref=f"{sheet.title}!{item['cell']}", metric=item["metric"],
                                    unit=item["unit"], period=item["period"], kind="actual",
                                    prior=f"{sheet.title}!{get_column_letter(prior[0])}{r}" if len(prior) == 1 else None))
            for (cadence, index), cols in periods.items():
                same_axis = cadence == current[0] and index > current[1]
                annual_forecast = (current[0] == "quarter" and cadence == "year"
                                   and index >= (current[1] - 1) // 4
                                   and str(rows[header][cols[0]-1]).upper().endswith("E"))
                if not (same_axis or annual_forecast) or len(cols) != 1:
                    continue
                j = cols[0]
                value = rows[r][j-1]
                if isinstance(value, (float, int)) or isinstance(value, str) and value.startswith("="):
                    comparisons.append(dict(ref=f"{sheet.title}!{get_column_letter(j)}{r}", metric=item["metric"],
                                            unit=item["unit"], storageScale=item.get("storageScale", 1),
                                            period=str(rows[header][j-1]), kind="forecast"))
    return dict(checks=checks, comparisons=comparisons, rules=rules, formatTolerances=tolerances)


if __name__ == "__main__":
    book, _ = load_workbook_resilient(sys.argv[1], read_only=True, data_only=False)
    try:
        print(json.dumps(layout(book, json.load(sys.stdin))))
    finally:
        book.close()
