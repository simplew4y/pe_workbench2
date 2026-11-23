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
    "Revenues": "Total revenues",
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


def unit_key(text):
    value = re.sub(r"[\s(),’']", "", str(text).casefold())
    aliases = {"rmbinmillions": "cny mn", "rmbmillion": "cny mn", "rmbmn": "cny mn",
               "cnymn": "cny mn", "人民币百万元": "cny mn", "百万元人民币": "cny mn",
               "rmb/share": "cny/share", "cny/share": "cny/share"}
    return aliases.get(value, value)


def exact_rows(book, inventory):
    """Match one named row, its units and a period in the same header band."""
    candidates = defaultdict(list)
    by_label = defaultdict(list)
    for fact in inventory:
        by_label[fact["metric"].casefold()].append(fact)
    for ws in book.worksheets:
        header = {}
        header_units = []
        for number, cells in enumerate(ws.iter_rows(), 1):
            row = [c.value for c in cells]
            band = period_band(number, row)
            # A financial amount can equal a calendar year. Require a coherent
            # axis, with no data values/formulas interleaved among its periods.
            explicit = any(isinstance(row[c-1], str) and re.search(r"FY|Q|[AE]$", row[c-1], re.I)
                           for c in band)
            # Plain years are indistinguishable from amounts on a metric row.
            # Only accept a bare-year axis under headings / unit labels.
            heading_only = band and all(v is None or re.fullmatch(
                r"metric|item|unit|year|年度|科目|单位|(?:RMB|CNY|USD|HKD)\s+(?:mn|bn|m|million|billion)",
                str(v).strip(), re.I) for v in row[:min(band)-1])
            if (band and (explicit or (len(band) > 1 and heading_only))
                    and all(v is None or j in band for j, v in enumerate(row[min(band)-1:], min(band)))):
                header = band
                header_units = [v for v in row[:min(band)-1] if isinstance(v, str)]
                continue
            for label in row_text_labels(row[:min(header)-1] if header else ()):
                for fact in by_label.get(label.casefold(), []):
                    for col, (head, token, _) in header.items():
                        period = token.upper().rstrip("AE").removeprefix("FY")
                        if period != fact["period"].removeprefix("FY"):
                            continue
                        prefix = [v for v in row[:min(header)-1] if isinstance(v, str) and v != label]
                        units = prefix or header_units
                        if unit_key(fact["unit"]) not in {unit_key(v) for v in units}:
                            continue
                        siblings = [c for c, (_, name, _) in header.items()
                                    if ("Q" in token.upper()) == ("Q" in name.upper())]
                        if all(row[c-1] is None for c in siblings):
                            continue
                        format_codes = re.sub(r'"[^"]*"|\\.|_.|\*.', "", cells[col-1].number_format)
                        sections = format_codes.split(";")[:3]
                        scales = {"%" in section for section in sections if section}
                        if len(scales) > 1 or any(section.count("%") > 1 for section in sections):
                            continue
                        percent = scales == {True}
                        if percent and fact["unit"] not in ("%", "％"):
                            continue
                        scale = 0.01 if percent else 1
                        letter = get_column_letter(col)
                        candidates[(fact["metric"], fact["period"])].append(dict(
                            sheet=ws.title, cell=letter+str(number), header=letter+str(head),
                            metric=fact["metric"], period=fact["period"], unit=fact["unit"],
                            expected=fact["expected"] * scale, decimals=fact["decimals"] + (2 if percent else 0),
                            **({"storageScale": scale} if percent else {}),
                            source=fact["source"]+"#page="+str(fact["page"]),
                            mode="check" if str(row[col-1]).startswith("=") else "actual"))
    mapped, gaps = [], []
    for fact in inventory:
        items = candidates[(fact["metric"], fact["period"])]
        if len(items) == 1:
            mapped.append(items[0])
        else:
            gaps.append(dict(fact, reason="科目、期间与目标单位缺少唯一匹配"))
    return mapped, gaps, []


def mapped_inventory(book, inventory, edits=None, outputs=None):
    # Look for the consolidated statement and a coherent set of RMB EPS labels.
    sheets = []
    for ws in book.worksheets:
        for number, hdr in enumerate(ws.iter_rows(max_row=10, max_col=8, values_only=True), 1):
            if any(label.upper() == "CONSOLIDATED INCOME STATEMENT" for label in row_text_labels(hdr)):
                sheets.append((ws, number))
                break
    mapped, gaps = [], []
    if len(sheets) != 1:
        return exact_rows(book, inventory)
    ws, header = sheets[0]
    tencent_source = bool(inventory) and all(f.get("issuer", {}).get("code") == "700" for f in inventory)
    tencent_model = str(ws["B1"].value).strip().casefold() == "tencent"
    if tencent_source != tencent_model:
        return [], [dict(f, reason="腾讯模型与公告发行人未能核对") for f in inventory], []
    tencent = tencent_source and tencent_model
    if tencent and edits is not None and outputs is not None:
        from tencent_mapping import map_tencent_statement
        return map_tencent_statement(book, ws, header, inventory, edits, outputs)
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
        matches = labels[LABELS.get(key, key)]
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
        row_label = LABELS.get(key, key)
        unit = unit_key(fact["unit"])
        if unit == "cny/share":
            unit_ok = "eps" in row_label.lower() and "(rmb)" in row_label.lower()
        elif unit == unit_key("mn shares"):
            unit_ok = "shares" in row_label.lower() and "(mn)" in row_label.lower()
        else:
            units = [s for line in rows[:header+2] for s in row_text_labels(line[:8])]
            scope = [re.sub(r"^Year to [^,]+,\s*", "", s, flags=re.I) for s in units
                     if re.search(r"RMB|CNY|USD|HKD|EUR|million|billion|百万元|十亿", s, re.I)]
            unit_ok = bool(scope) and all(unit_key(s) == unit for s in scope)
        if not unit_ok:
            gaps.append(dict(fact, reason="目标科目的币种或数量级无法确认"))
            continue
        actual = dict(sheet=ws.title, cell=letter+str(row), header=letter+str(header),
                      metric=key, period=p, unit=fact["unit"], expected=fact["expected"],
                      decimals=fact["decimals"], source=fact["source"]+"#page="+str(fact["page"]),
                      mode="check" if str(rows[row-1][col-1]).startswith("=") or key in
                      ("Operating profit", "Non-IFRS operating profit") else "actual")
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
        inventory = json.load(sys.stdin)
        edits = []
        outputs = []
        issuer_mismatch = False
        if isinstance(inventory, dict) and inventory.get("exchangeSource"):
            from statement_mapping import issuer_matches
            original_name = inventory["originalName"]
            inventory = inventory["facts"]
            issuer = inventory[0].get("issuer", {})
            issuer_mismatch = (not issuer or any(f.get("issuer") != issuer for f in inventory)
                               or not issuer_matches(workbook, issuer, original_name))
        if issuer_mismatch:
            mapped, conversions = [], []
            gaps = [dict(f, reason="无法核实检索公告与原模型的发行人") for f in inventory]
        elif isinstance(inventory, dict):
            request = inventory
            inventory = request["facts"]
            from statement_mapping import map_statements
            values, _ = load_workbook_resilient(request.get("calculatedPath", sys.argv[1]), read_only=False, data_only=True)
            # Random coordinate access on a streaming worksheet reparses the entire XML.
            model, _ = load_workbook_resilient(sys.argv[1], read_only=False, data_only=False)
            try:
                mapped, gaps, edits = map_statements(model, values, inventory, request.get("originalName",""), request.get("reported",{}))
                conversions = []
                for sheet in model.worksheets:
                    for row in sheet.iter_rows():
                        for i, cell in enumerate(row):
                            label = str(cell.value or "")
                            if not re.search(r"(?:value per share|target price|\bTP)\s*[（(](?:RMB|CNY|HKD|HK\$|USD)[)）]", label, re.I):
                                continue
                            formulas = []
                            for candidate in row[i+1:]:
                                if candidate.data_type == "f":
                                    if isinstance(values[sheet.title][candidate.coordinate].value, (int,float)):
                                        formulas.append(candidate)
                                elif isinstance(candidate.value,str):
                                    break
                            if len(formulas)==1:
                                outputs.append(dict(sheet=sheet.title,cell=formulas[0].coordinate,label=label))

            finally:
                values.close()
                model.close()
        else:
            mapped, gaps, conversions = mapped_inventory(workbook, inventory, edits, outputs)
        print(json.dumps(dict(actuals=mapped, gaps=gaps, conversions=conversions, edits=edits, outputs=outputs, issuerMismatch=issuer_mismatch)))
    finally:
        workbook.close()
