"""Map a completed source inventory onto supported income-statement row labels."""
import json
import re
import sys
from collections import defaultdict
from openpyxl.utils import get_column_letter, coordinate_to_tuple
from openpyxl_safe import load_workbook_resilient
from parse_workbook import MAX_COLS, period_band, row_text_labels


# Keys are disclosure concepts. Aliases are model labels, never coordinates or values.
LABELS = {
    "Gross profit": "Gross profit",
    "Operating profit": "Operating profit, GAAP, new def",
    "Non-IFRS operating profit": "Operating profit, non-GAAP, new def",
    "Selling and marketing expenses": "Sales and marketing",
    "General and administrative expenses": "General and administrative",
    "Other gains/(losses), net": "Other gains, net - new def",
    "Profit attributable to equity holders of the Company": "Net profit, GAAP",
    "Non-IFRS profit attributable to equity holders of the Company": "Net profit, non-GAAP",
    "EPS basic": "GAAP EPS, basic (Rmb)",
    "EPS diluted": "GAAP EPS, diluted (Rmb)",
    "Non-IFRS EPS diluted": "Non-GAAP EPS, diluted (Rmb)",
    "Basic weighted average shares": "Basic shares, weighted average (mn)",
    "Diluted weighted average shares": "Diluted shares, weighted average (mn)",
    "Operating adjustment / Share-based compensation": "Share-based compensation",
    "Operating adjustment / Amortisation of intangible assets": "Amortization of intangibles",
    "Operating adjustment / SSV & CPP": "SSV & CPP",
    "Operating adjustment / Others": "Others",
}


def mapped_inventory(book, inventory):
    # Look for the consolidated statement and a coherent set of RMB EPS labels.
    sheets = []
    for ws in book:
        for number, hdr in enumerate(ws.iter_rows(max_row=10, max_col=8, values_only=True), 1):
            if any(label.upper() == "CONSOLIDATED INCOME STATEMENT" for label in row_text_labels(hdr)):
                sheets.append((ws, number))
                break
    mapped, gaps = [], []
    if len(sheets) != 1:
        return [], [dict(f, reason="Income statement missing or ambiguous") for f in inventory], []
    ws, header = sheets[0]
    rows = list(ws.iter_rows(max_row=min(ws.max_row, 500), max_col=min(ws.max_column, MAX_COLS), values_only=True))
    columns = defaultdict(list)
    for col, (_, token, raw) in period_band(header, rows[header - 1]).items():
        # The write-time check accepts a period label on its own.
        if token == raw:
            period = token.upper().replace(" ", "").removeprefix("FY").rstrip("AE")
            columns[period].append(col)
    annual = [col for period, cols in columns.items() if period.isdecimal() for col in cols]
    labels = defaultdict(list)
    for number, row in enumerate(rows, 1):
        for label in row_text_labels(row[:8]):
            if label.startswith("SSV & CPP ("):
                label = "SSV & CPP"
            if not labels[label] or labels[label][-1] != number:
                labels[label].append(number)
    # The same adjustment label can also occur in the net profit reconciliation.
    op, adj = labels[LABELS["Operating profit"]], labels[LABELS["Non-IFRS operating profit"]]
    for fact in inventory:
        p, key = fact["period"], fact["metric"]
        cols = columns[p.removeprefix("FY")]
        matches = labels[LABELS.get(key)]
        # A section title may repeat the total's text. A title with an entirely
        # empty period axis cannot be the reported numeric line.
        if key.startswith("Operating adjustment / "):
            matches = [r for r in matches if op[0] < r < adj[0]] if len(op) == len(adj) == 1 else []
        elif len(matches) > 1:
            matches = [r for r in matches if any(rows[r-1][c-1] is not None for c in annual)]
        if len(cols) != 1 or len(matches) != 1:
            gaps.append(dict(fact, reason="Period column missing or ambiguous" if len(cols) != 1 else "Row missing or ambiguous"))
            continue
        col, row = cols[0], matches[0]
        letter = get_column_letter(col)
        actual = dict(sheet=ws.title, cell=letter+str(row), header=letter+str(header),
                      metric=key, period=p, unit=fact["unit"], expected=fact["expected"],
                      decimals=fact["decimals"], source=fact["source"]+"#page="+str(fact["page"]),
                      mode="check" if key in ("Operating profit", "Non-IFRS operating profit") else "actual")
        mapped.append(actual)
    conversions = []
    required = ("Diluted EPS, GAAP (HK$)", "Rmb/US$, average",
                LABELS["Diluted weighted average shares"], LABELS["Profit attributable to equity holders of the Company"])
    if any(len(labels[name]) != 1 for name in required):
        return mapped, gaps, conversions
    destination_row, rate_row, shares_row, profit_row = (labels[name][0] for name in required)
    for base in mapped:
        if base["metric"] != "EPS diluted" or base["unit"] != "RMB/share":
            continue
        _, column = coordinate_to_tuple(base["cell"])
        letter = get_column_letter(column)
        destination, rate = letter + str(destination_row), letter + str(rate_row)
        old = str(rows[destination_row-1][column-1]).upper().replace("$", "").replace(ws.title.upper()+"!", "")
        numerator, denominator = letter + str(profit_row), letter + str(shares_row)
        # Reuse the exact conversion already in this workbook. Both supported
        # expressions first compute RMB EPS and then apply the same FX terms.
        pattern = rf"=\+?(?:{numerator}/{denominator}|{base['cell']})\*(\d+(?:\.\d+)?)/{rate}"
        match = re.fullmatch(pattern, old)
        if match:
            conversions.append(dict(base=base, cell=destination, rate=rate, multiplier=match[1]))
    return mapped, gaps, conversions


if __name__ == "__main__":
    workbook, _ = load_workbook_resilient(sys.argv[1], data_only=False, read_only=True)
    try:
        mapped, gaps, conversions = mapped_inventory(workbook, json.load(sys.stdin))
        print(json.dumps(dict(actuals=mapped, gaps=gaps, conversions=conversions)))
    finally:
        workbook.close()
