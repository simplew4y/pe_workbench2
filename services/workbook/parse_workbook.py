#!/usr/bin/env python3
"""
Feasibility probe: turn a workbook into a queryable formula graph.

Improvements over the reference parser (services/document-parser/parse_excel.py):
  1. JSON-safe values (datetime / date / time / timedelta / Decimal / bytes).
  2. Ranges are expanded to every cell, not just the two corners.
  3. Referenced cells without formulas become input nodes, so input -> output
     edges survive.
  4. Labels are derived from actual label columns / header rows and formulas
     are never accepted as a header.
  5. Compact output (array rows), ready to be gzipped and cached by blob hash.

This file is intentionally standalone and invoked by lib/workbook-store.mjs.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

PARSER_VERSION = 8

try:
    import openpyxl
    from openpyxl.utils import column_index_from_string, get_column_letter

    from openpyxl_safe import load_workbook_resilient
except ModuleNotFoundError as error:  # pragma: no cover - depends on the host
    print(
        "openpyxl is required: pip install openpyxl (missing module: %s)" % error.name,
        file=sys.stderr,
    )
    raise SystemExit(3)

SUPPORTED_EXTS = {".xlsx", ".xlsm", ".xltx", ".xltm"}

MAX_ROWS = 10_000
MAX_COLS = 512
MAX_RANGE_CELLS = 5_000
MAX_FORMULA_CHARS = 2_000
MAX_VALUE_CHARS = 300

REF_RE = re.compile(
    r"""
    (?:
        '(?P<qsheet>[^']+)' | (?P<usheet>[A-Za-z_][A-Za-z0-9_.]*)
    )!
    (?P<qcell>\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)
    |
    (?P<lcell>\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)
    """,
    re.VERBOSE,
)
CELL_RE = re.compile(r"^\$?([A-Z]{1,3})\$?(\d+)$")


def safe_value(value: Any) -> Any:
    """JSON-safe scalar, capped for string size."""
    if value is None or isinstance(value, (bool, int, str)):
        return value if not isinstance(value, str) else value[:MAX_VALUE_CHARS]
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, bytes):
        return "base64:" + base64.b64encode(value[:200]).decode("ascii")
    return str(value)[:MAX_VALUE_CHARS]


def is_text(value: Any) -> bool:
    return (isinstance(value, str) and bool(value.strip())
            and not value.lstrip().startswith(("=", "#"))
            and value.strip().lower() not in {"na", "n/a", "-"})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_ref(ref: str) -> tuple[str, str]:
    """'B4:B10' -> (start, end); 'B4' -> (B4, B4)."""
    if ":" in ref:
        start, end = ref.split(":", 1)
        return start.replace("$", ""), end.replace("$", "")
    clean = ref.replace("$", "")
    return clean, clean


def expand_ref(cell_ref: str, max_cells: int = MAX_RANGE_CELLS) -> list[tuple[int, int]]:
    """Return every (row, col) covered by a cell or rectangle reference."""
    start, end = split_ref(cell_ref)
    m1, m2 = CELL_RE.match(start), CELL_RE.match(end)
    if not m1 or not m2:
        return []
    c1, r1 = column_index_from_string(m1.group(1)), int(m1.group(2))
    c2, r2 = column_index_from_string(m2.group(1)), int(m2.group(2))
    if c1 > c2:
        c1, c2 = c2, c1
    if r1 > r2:
        r1, r2 = r2, r1
    area = (r2 - r1 + 1) * (c2 - c1 + 1)
    if area > max_cells:
        # Keep the outline of a huge range instead of exploding memory.
        cells = {(r1, c) for c in range(c1, c2 + 1)}
        cells |= {(r2, c) for c in range(c1, c2 + 1)}
        cells |= {(r, c1) for r in range(r1, r2 + 1)}
        cells |= {(r, c2) for r in range(r1, r2 + 1)}
        return sorted(cells)
    return [(r, c) for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]


def extract_refs(formula: str, current_sheet: str) -> set[str]:
    """All A1-style references in a formula, normalised to 'Sheet!A1'."""
    refs: set[str] = set()
    for match in REF_RE.finditer(formula):
        sheet = match.group("qsheet") or match.group("usheet") or current_sheet
        cell = match.group("qcell") or match.group("lcell")
        if not cell:
            continue
        for row, col in expand_ref(cell):
            refs.add(f"{sheet}!{get_column_letter(col)}{row}")
    return refs


def cell_id(sheet: str, row: int, col: int) -> str:
    return f"{sheet}!{get_column_letter(col)}{row}"


def build_merge_map(ws) -> dict[tuple[int, int], Any]:
    """Map every cell inside a merged range to the top-left value."""
    merged: dict[tuple[int, int], Any] = {}
    for merged_range in ws.merged_cells.ranges:
        area = (merged_range.max_row - merged_range.min_row + 1) * (
            merged_range.max_col - merged_range.min_col + 1
        )
        if area > 5_000:
            continue
        value = ws.cell(merged_range.min_row, merged_range.min_col).value
        if value is None:
            continue
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                merged[(row, col)] = value
    return merged


def label_like(value: Any) -> bool:
    """A short value that can plausibly be a column header."""
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, (dt.date, dt.datetime)):
        return True
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not value.is_integer():
            return False
        return 1900 <= value <= 2100
    if isinstance(value, str):
        text = value.strip()
        return 0 < len(text) <= 30 and "\n" not in text
    return False


def profile_sheet(
    ws, display: dict[tuple[int, int], Any], formulas: dict[tuple[int, int], str]
) -> list[int]:
    """Find the columns that hold row labels (typically A/B)."""
    text_by_col: Counter[int] = Counter()
    data_rows: set[int] = set()

    for (row, col), value in display.items():
        if (row, col) in formulas:
            data_rows.add(row)
        elif is_text(value):
            text_by_col[col] += 1

    rows_with_data = max(1, len(data_rows))
    label_cols = [
        col
        for col, _ in text_by_col.most_common(6)
        if col <= 4 and text_by_col[col] >= max(3, rows_with_data * 0.15)
    ][:2]
    return label_cols or [1]


def build_labels(
    display: dict[tuple[int, int], Any],
    max_row: int,
    max_col: int,
    label_cols: list[int],
) -> tuple[dict[int, str], dict[int, str]]:
    """Row labels from the label columns; column labels from the header band.

    Column headers can themselves be formulas (e.g. a year pulled from another
    sheet), so we use the cached display value and stop at the first real data
    value in that column.
    """
    row_labels: dict[int, str] = {}
    for row in range(1, max_row + 1):
        for col in label_cols + [1, 2]:
            value = display.get((row, col))
            if is_text(value):
                text = str(value).strip()
                if len(text) <= 80 and "\n" not in text:
                    row_labels[row] = text
                break

    col_labels: dict[int, str] = {}
    for col in range(1, max_col + 1):
        if col in label_cols:
            continue
        best: str | None = None
        for row in range(1, min(9, max_row) + 1):
            value = display.get((row, col))
            if value is None:
                continue
            if label_like(value):
                best = str(safe_value(value)).strip()
                continue
            break
        if best:
            col_labels[col] = best

    return row_labels, col_labels


PERIOD_HEADER = re.compile(r"(?:[1-4]Q(?:\d{2}|\d{4})|(?:19|20)\d{2})(?:[AE])?$", re.I)


def period_headers(display, max_row, max_col):
    """Use a band of neighboring date headers, even below scenario inputs."""
    headers = {}
    for row in range(1, min(max_row, 9) + 1):
        band = {}
        for col in range(1, max_col + 1):
            value = str(display.get((row, col), "")).strip()
            if PERIOD_HEADER.fullmatch(value):
                band[col] = value
        for col, value in band.items():
            if col - 1 in band or col + 1 in band:
                headers[col] = (row, value)
    return headers



def local_period_header(display, row, col, headers):
    label = re.compile(r"^((?:[1-4]Q\d{2,4}|(?:19|20)\d{2})(?:[AE])?)(?:\s+(?:P/E|PE|NI|Revenue|EPS).*)?$", re.I)
    for r in range(row - 1, 0, -1):
        match = label.fullmatch(str(display.get((r, col), "")).strip())
        if match and any(label.fullmatch(str(display.get((r, other), "")).strip()) for other in (col-1, col+1)):
            return r, match.group(1), str(display[(r, col)]).strip()
        value = display.get((r, col))
        if is_text(value) and not match and any(label.fullmatch(str(display.get((r, other), "")).strip()) for other in (col-1, col+1)):
            return r, None, value.strip()
    original = headers.get(col)
    if original and original[0] < row:
        return original[0], original[1], original[1]
    return None

def cell_period(display, headers, row, col, row_label):
    # Scalar outputs can carry their own year (e.g. discounted back to 2027).
    years = re.findall(r"\b(?:19|20)\d{2}[AE]?\b", row_label or "")
    if len(years) == 1:
        return years[0]
    local = local_period_header(display, row, col, headers)
    if local is None:
        return None
    # An isolated scalar below a period table is a separate block.
    if any(adj in headers and (row, adj) in display for adj in (col-1, col+1)):
        return local[1]
    return None


def scoped_row_labels(display, col_labels):
    """Associate each occupied cell with a label in its own horizontal run.

    Valuation sheets often have a label, a distant first value, then a
    separate calculation across a blank gutter. A gap before the *first*
    value is ordinary label padding. A gap after data can start a new block.
    Keep sparse time series together when both columns have period headers.
    """
    period = re.compile(r"(?:[1-4]Q\d{2,4}|(?:19|20)\d{2})(?:[AE])?$", re.I)
    sources = {}
    previous_row = previous_col = None
    for (row, col), value in sorted(display.items()):
        if row != previous_row:
            source = None
            seen_data = False
        elif seen_data and col - previous_col > 2:
            periods_continue = all(
                period.fullmatch(str(col_labels.get(c, "")))
                for c in (previous_col, col)
            )
            if not periods_continue:
                source = None
                seen_data = False
        if source is not None:
            sources[(row, col)] = source
        if is_text(value) and len(value.strip()) <= 80 and "\n" not in value:
            source = (value.strip(), f"{get_column_letter(col)}{row}")
            seen_data = False
        else:
            seen_data = True
        previous_row, previous_col = row, col
    return sources


def column_label(display, formulas, row, col, col_labels):
    local = local_period_header(display, row, col, {})
    col_label = local[2] if local else col_labels.get(col)
    if col_label is None:
        for r in range(row - 1, max(0, row - 9), -1):
            value = display.get((r, col))
            if value is None:
                continue
            if label_like(value):
                text = str(safe_value(value)).strip()
                if len(text) <= 60 and "\n" not in text:
                    col_label = text
                    break
            if (r, col) in formulas:
                continue
            break

    return col_label


def dedupe_warnings(messages: list[str], limit: int = 20) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for message in messages:
        text = " ".join(str(message).split())[:320]
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result



def chart_evidence(ws, values_ws):
    """Keep chart references and reproduce linear fits from numeric cached pairs."""
    charts = []
    def title_text(axis):
        rich = getattr(getattr(getattr(axis, "title", None), "tx", None), "rich", None)
        return "".join(run.t for para in getattr(rich, "p", []) for run in getattr(para, "r", []) if run.t)
    for index, chart in enumerate(getattr(ws, "_charts", [])):
        for number, series in enumerate(chart.series):
            xref = getattr(getattr(getattr(series, "xVal", None), "numRef", None), "f", None)
            yref = getattr(getattr(getattr(series, "yVal", None), "numRef", None), "f", None)
            trend = getattr(getattr(series, "trendline", None), "trendlineType", None)
            item = {"sheet": ws.title, "chart": index + 1, "series": number + 1,
                    "xRange": xref, "yRange": yref, "trendline": trend,
                    "xTitle": title_text(getattr(chart, "x_axis", None)),
                    "yTitle": title_text(getattr(chart, "y_axis", None))}
            if xref and yref and values_ws is not None:
                def read_range(ref):
                    sheet, coord = ref.rsplit("!", 1)
                    sheet = sheet.strip("'").replace("''", "'")
                    target = values_ws.parent[sheet]
                    return [(c.coordinate, c.value) for row in target[coord] for c in row]
                try:
                    xs, ys = read_range(xref), read_range(yref)
                    pairs = [{"xRef": xref.rsplit("!", 1)[0] + "!" + x[0],
                              "yRef": yref.rsplit("!", 1)[0] + "!" + y[0], "x": x[1], "y": y[1]}
                             for x, y in zip(xs, ys) if isinstance(x[1], (int, float))
                             and isinstance(y[1], (int, float)) and not isinstance(x[1], bool)
                             and not isinstance(y[1], bool)]
                    item["points"] = pairs
                    if trend == "linear" and len(pairs) >= 2 and getattr(series.trendline, "intercept", None) is None:
                        mx = sum(p["x"] for p in pairs) / len(pairs)
                        my = sum(p["y"] for p in pairs) / len(pairs)
                        xx = sum((p["x"] - mx) ** 2 for p in pairs)
                        if xx:
                            slope = sum((p["x"] - mx) * (p["y"] - my) for p in pairs) / xx
                            intercept = my - slope * mx
                            yy = sum((p["y"] - my) ** 2 for p in pairs)
                            residual = sum((p["y"] - (slope * p["x"] + intercept)) ** 2 for p in pairs)
                            item["fit"] = {"slope": slope, "intercept": intercept,
                                           "rSquared": 1 - residual / yy if yy else None,
                                           "n": len(pairs), "basis": "numeric cached chart points"}
                            item["leaveOneOut"] = []
                            if len(pairs) >= 3:
                                for excluded in pairs:
                                    sample = [point for point in pairs if point is not excluded]
                                    ax = sum(point["x"] for point in sample) / len(sample)
                                    ay = sum(point["y"] for point in sample) / len(sample)
                                    dx = sum((point["x"] - ax) ** 2 for point in sample)
                                    if not dx:
                                        continue
                                    k = sum((point["x"] - ax) * (point["y"] - ay) for point in sample) / dx
                                    b = ay - k * ax
                                    total = sum((point["y"] - ay) ** 2 for point in sample)
                                    err = sum((point["y"] - k * point["x"] - b) ** 2 for point in sample)
                                    item["leaveOneOut"].append({"excluded": excluded["xRef"],
                                        "slope": k, "intercept": b,
                                        "rSquared": 1 - err / total if total else None, "n": len(sample)})

                except (KeyError, ValueError, TypeError, AttributeError):
                    item["warning"] = "Chart ranges could not be fully resolved"
            charts.append(item)
    return charts

def parse_sheet(
    ws: Any, values_ws: Any | None
) -> tuple[
    dict[str, Any],
    dict[tuple[int, int], Any],
    tuple[dict[tuple[int, int], tuple[str, str]], dict[int, str], dict[int, tuple[int, str]]],
    dict[str, dict[str, Any]],
    dict[str, set[str]],
    set[str],
    list[int],
]:
    """Read one worksheet into graph pieces.

    A genuinely broken sheet raises; the caller records a warning and keeps
    the other sheets instead of failing the whole workbook.
    """
    max_row = min(ws.max_row or 1, MAX_ROWS)
    max_col = min(ws.max_column or 1, MAX_COLS)
    merge_map = build_merge_map(ws)

    values: dict[tuple[int, int], Any] = {}
    sheet_formulas: dict[tuple[int, int], str] = {}
    computed: dict[tuple[int, int], Any] = {}

    for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col):
        for cell in row:
            raw = cell.value
            if raw is None:
                raw = merge_map.get((cell.row, cell.column))
            if raw is None:
                continue
            values[(cell.row, cell.column)] = raw
            if isinstance(raw, str) and raw.startswith("="):
                sheet_formulas[(cell.row, cell.column)] = raw
                if values_ws is not None:
                    computed[(cell.row, cell.column)] = values_ws.cell(
                        cell.row, cell.column
                    ).value

    display: dict[tuple[int, int], Any] = {}
    for key, raw in values.items():
        if key in sheet_formulas:
            cached = computed.get(key)
            display[key] = cached if cached is not None else raw
        else:
            display[key] = raw

    label_cols = profile_sheet(ws, display, sheet_formulas)
    row_labels, col_labels = build_labels(display, max_row, max_col, label_cols)

    formulas: dict[str, dict[str, Any]] = {}
    formula_refs: dict[str, set[str]] = {}
    referenced: set[str] = set()
    headers = period_headers(display, max_row, max_col)
    sources = scoped_row_labels(display, {**col_labels, **{c: h[1] for c, h in headers.items()}})
    for (row, col), formula in sheet_formulas.items():
        row_label, label_coord = sources.get((row, col), (None, None))
        col_label = column_label(display, sheet_formulas, row, col, col_labels)
        computed_value = computed.get((row, col))
        cid = cell_id(ws.title, row, col)
        refs = extract_refs(formula, ws.title)
        formula_refs[cid] = refs
        referenced.update(refs)
        formulas[cid] = {
            "formula": formula[:MAX_FORMULA_CHARS],
            "value": safe_value(
                computed_value if computed_value is not None else display.get((row, col))
            ),
            "row": row,
            "col": col,
            "rowLabel": row_label,
            "labelCoord": label_coord,
            "period": cell_period(display, headers, row, col, row_label),
            "colLabel": col_label,
        }

    sheet = {
        "name": ws.title,
        "rows": max_row,
        "cols": max_col,
        "formulaCount": len(sheet_formulas),
        "rowLabels": {str(k): v for k, v in row_labels.items()},
        "colLabels": {str(k): v for k, v in col_labels.items()},
        "charts": chart_evidence(ws, values_ws),
    }
    return (
        sheet,
        display,
        (sources, col_labels, headers),
        formulas,
        formula_refs,
        referenced,
        label_cols,
    )


def parse_workbook(path: Path) -> dict[str, Any]:
    started = time.time()
    warnings: list[str] = []

    wb, load_warnings = load_workbook_resilient(path, data_only=False, read_only=False)
    warnings.extend(load_warnings)

    values_wb = None
    try:
        values_wb, cached_warnings = load_workbook_resilient(
            path, data_only=True, read_only=False
        )
        warnings.extend(cached_warnings)
    except Exception as error:  # noqa: BLE001 - formulas are still usable
        warnings.append(
            "缓存值读取失败，公式单元格暂时按公式文本显示"
            f"（{type(error).__name__}: {error}）"
        )

    sheets: list[dict[str, Any]] = []
    cells: list[list[Any]] = []
    formulas: dict[str, dict[str, Any]] = {}
    formula_refs: dict[str, set[str]] = {}
    referenced: set[str] = set()
    sheet_values: dict[str, dict[tuple[int, int], Any]] = {}
    sheet_labels: dict[str, tuple[dict[tuple[int, int], tuple[str, str]], dict[int, str], dict[int, tuple[int, str]]]] = {}

    for ws in wb.worksheets:
        values_ws = None
        if values_wb is not None:
            try:
                values_ws = values_wb[ws.title]
            except KeyError:
                warnings.append(f"{ws.title}: 缓存值工作表缺失，公式将按公式文本处理。")

        try:
            (
                sheet,
                display,
                labels,
                sheet_formulas,
                sheet_refs,
                sheet_referenced,
                label_cols,
            ) = parse_sheet(ws, values_ws)
        except Exception as error:  # noqa: BLE001 - keep the other sheets
            warnings.append(
                f"{ws.title}: 工作表解析失败，已跳过（{type(error).__name__}: {error}）"
            )
            continue

        sheets.append(sheet)
        sheet_values[ws.title] = display
        sheet_labels[ws.title] = labels
        formulas.update(sheet_formulas)
        formula_refs.update(sheet_refs)
        referenced.update(sheet_referenced)
        print(
            f"  {ws.title}: {len(sheet_formulas)} formulas, "
            f"labelCols={label_cols}, colLabels={len(labels[1])}",
            file=sys.stderr,
        )

    for workbook in (wb, values_wb):
        if workbook is None:
            continue
        try:
            workbook.close()
        except Exception:  # noqa: BLE001 - best effort
            pass

    warnings = dedupe_warnings(warnings)

    # Referenced cells without a formula are input nodes. They may be
    # referenced by a sheet other than the one they live in, so resolve them
    # only after every sheet has been read.
    for sheet, display in sheet_values.items():
        for (row, col), value in display.items():
            if (isinstance(value, (int, float)) and not isinstance(value, bool)
                    and sheet_labels[sheet][2].get(col, (None,))[0] != row):
                referenced.add(cell_id(sheet, row, col))

    for cid in sorted(referenced):
        if cid in formulas:
            continue
        sheet, coord = cid.split("!", 1)
        if sheet not in sheet_values:
            continue
        match = CELL_RE.match(coord)
        if not match:
            continue
        row, col = int(match.group(2)), column_index_from_string(match.group(1))
        value = sheet_values[sheet].get((row, col))
        if value is None:
            continue
        sources, col_labels, headers = sheet_labels[sheet]
        row_label, label_coord = sources.get((row, col), (None, None))
        formulas[cid] = {
            "formula": None,
            "value": safe_value(value),
            "row": row,
            "col": col,
            "rowLabel": row_label,
            "labelCoord": label_coord,
            "colLabel": column_label(sheet_values[sheet], {}, row, col, col_labels),
            "period": cell_period(sheet_values[sheet], headers, row, col, row_label),
        }

    # Emit formula cells first, then referenced input cells.
    ordered = sorted(
        formulas.items(),
        key=lambda item: (item[1]["formula"] is None, item[1]["row"], item[1]["col"]),
    )
    index: dict[str, int] = {}
    for cid, info in ordered:
        index[cid] = len(cells)
        cells.append(
            [
                cid,
                info["formula"],
                info["value"],
                info["row"],
                info["col"],
                info["rowLabel"],
                info["colLabel"],
                info["labelCoord"],
                info["period"],
            ]
        )

    edges: set[tuple[str, str]] = set()
    for cid, refs in formula_refs.items():
        for dep in refs:
            if dep == cid or dep not in index:
                continue
            edges.add((dep, cid))

    # An output is a formula cell that no other cell depends on. Count the
    # "from" side, not the "to" side: edges are (dependency, dependent).
    dependent_counts: Counter[str] = Counter()
    for from_id, _ in edges:
        dependent_counts[from_id] += 1
    inputs = [cid for cid, info in formulas.items() if info["formula"] is None]
    outputs = [
        cid
        for cid, info in formulas.items()
        if info["formula"] and dependent_counts[cid] == 0
    ]

    def rank_output(cid: str) -> tuple[int, int]:
        info = formulas[cid]
        label = f"{info.get('rowLabel') or ''} {info.get('colLabel') or ''}"
        score = 0
        for word in ("ebit", "ebitda", "revenue", "margin", "profit", "cash", "valuation", "wacc", "nav"):
            if word in label.lower():
                score += 2
        return (-score, -info["row"])

    outputs.sort(key=rank_output)

    stats = {
        "formulaCount": sum(1 for info in formulas.values() if info["formula"]),
        "inputCount": len(inputs),
        "cellCount": len(cells),
        "edgeCount": len(edges),
        "sheets": len(sheets),
        "warningCount": len(warnings),
        "parseMs": int((time.time() - started) * 1000),
    }

    return {
        "schemaVersion": 1,
        "parserVersion": PARSER_VERSION,
        "fileName": path.name,
        "fileSha256": sha256_file(path),
        "parsedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "sheets": sheets,
        "cells": cells,
        "edges": sorted(edges),
        "stats": stats,
        "outputs": outputs[:60],
        "inputs": inputs[:200],
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path, nargs="?")
    parser.add_argument("--out", type=Path, help="write JSON here instead of stdout")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()

    if args.version:
        print(PARSER_VERSION)
        return

    if args.file is None:
        parser.error("a workbook path is required")
    if not args.file.exists():
        parser.error(f"file not found: {args.file}")
    if args.file.suffix.lower() not in SUPPORTED_EXTS:
        print(
            f"unsupported workbook format: {args.file.suffix} "
            f"(supported: {', '.join(sorted(SUPPORTED_EXTS))}); "
            "save legacy .xls as .xlsx in Excel and retry",
            file=sys.stderr,
        )
        raise SystemExit(4)

    print(f"Parsing {args.file} ...", file=sys.stderr)
    result = parse_workbook(args.file)
    for message in result.get("warnings", []):
        print(f"  warning: {message}", file=sys.stderr)
    text = json.dumps(
        result,
        ensure_ascii=False,
        indent=2 if args.pretty else None,
        separators=None if args.pretty else (",", ":"),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    print(
        f"Done: {result['stats']} | {len(text) / 1024 / 1024:.1f} MB JSON",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
