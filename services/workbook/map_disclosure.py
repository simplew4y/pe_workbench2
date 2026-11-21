"""Map a completed source inventory onto supported income-statement row labels."""
import json
import re
import sys
from openpyxl.utils import get_column_letter
from openpyxl_safe import load_workbook_resilient


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
        for hdr in ws.iter_rows(max_row=10, values_only=True):
            if any(str(v).strip().upper() == "CONSOLIDATED INCOME STATEMENT" for v in hdr[:8]):
                sheets.append(ws)
                break
    mapped, gaps = [], []
    if len(sheets) != 1:
        return [], [dict(f, reason="Income statement missing or ambiguous") for f in inventory], []
    ws = sheets[0]
    rows = list(ws.iter_rows(max_row=min(ws.max_row, 500), max_col=min(ws.max_column, 512), values_only=True))
    header = next(i for i, r in enumerate(rows[:10]) if any(str(v).strip().upper() == "CONSOLIDATED INCOME STATEMENT" for v in r[:8]))
    labels = [[str(v).strip() for v in r[:8] if isinstance(v, str) and not v.startswith("=")] for r in rows]
    def locate(label, start=0, stop=None):
        return [i for i in range(start, len(rows) if stop is None else stop)
                if any(s == label or (label == "SSV & CPP" and s.startswith(label + " (")) for s in labels[i])]
    # The same adjustment label can also occur in the net profit reconciliation.
    op, adj = locate(LABELS["Operating profit"]), locate(LABELS["Non-IFRS operating profit"])
    for fact in inventory:
        p, key = fact["period"], fact["metric"]
        cols = [i for i, v in enumerate(rows[header]) if str(v).upper().rstrip("AE") == p.removeprefix("FY")]
        label = LABELS.get(key)
        matches = locate(label) if label else []
        # A section title may repeat the total's text. A title with an entirely
        # empty period axis cannot be the reported numeric line.
        if len(matches) > 1:
            axis = [i for i, v in enumerate(rows[header]) if str(v).upper().rstrip("AE").isdigit()
                    and len(str(v).upper().rstrip("AE")) == 4]
            matches = [i for i in matches if any(rows[i][j] is not None for j in axis)]
        if key.startswith("Operating adjustment / "):
            matches = locate(label, op[0]+1, adj[0]) if label and len(op) == len(adj) == 1 else []
        if len(cols) != 1 or len(matches) != 1:
            gaps.append(dict(fact, reason="Period column missing or ambiguous" if len(cols) != 1 else "Row missing or ambiguous"))
            continue
        col, row = cols[0], matches[0]
        letter = get_column_letter(col+1)
        actual = dict(sheet=ws.title, cell=letter+str(row+1), header=letter+str(header+1),
                      metric=key, period=p, unit=fact["unit"], expected=fact["expected"],
                      decimals=fact["decimals"], source=fact["source"]+"#page="+str(fact["page"]),
                      mode="check" if key in ("Operating profit", "Non-IFRS operating profit") else "actual")
        mapped.append(actual)
    conversions = []
    for base in mapped:
        if base["metric"] != "EPS diluted" or base["unit"] != "RMB/share":
            continue
        letter = re.match(r"[A-Z]+", base["cell"])[0]
        column = next(i for i in range(len(rows[header])) if get_column_letter(i+1) == letter)
        destinations = locate("Diluted EPS, GAAP (HK$)")
        rates = locate("Rmb/US$, average")
        shares = locate(LABELS["Diluted weighted average shares"])
        profits = locate(LABELS["Profit attributable to equity holders of the Company"])
        if not all(len(options) == 1 for options in (destinations, rates, shares, profits)):
            continue
        destination = letter + str(destinations[0]+1)
        rate = letter + str(rates[0]+1)
        old = str(rows[destinations[0]][column]).upper().replace("$", "").replace(ws.title.upper()+"!", "")
        numerator, denominator = letter+str(profits[0]+1), letter+str(shares[0]+1)
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
