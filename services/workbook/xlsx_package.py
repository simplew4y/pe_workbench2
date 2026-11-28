"""Edit cells in their original XLSX package; use Calc only as a formula evaluator."""
import posixpath
from copy import deepcopy
from zipfile import ZipFile
from lxml import etree as ET
from openpyxl.formula.translate import Translator
from openpyxl.utils import coordinate_to_tuple, get_column_letter, range_boundaries

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def sheets(archive):
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    parts = {r.get("Id"): posixpath.normpath(posixpath.join("xl", r.get("Target"))).lstrip("/") for r in rels if r.get("Type","").endswith("/worksheet")}
    book = ET.fromstring(archive.read("xl/workbook.xml"))
    return {s.get("name"): parts[s.get(RID)] for s in book.find(NS + "sheets") if s.get(RID) in parts}


def cell_value(cell, value):
    for tag in ("f", "v", "is"):
        child = cell.find(NS + tag)
        if child is not None:
            cell.remove(child)
    cell.attrib.pop("t", None)
    if isinstance(value, str) and value.startswith("="):
        ET.SubElement(cell, NS + "f").text = value[1:]
    elif isinstance(value, str):
        cell.set("t", "inlineStr")
        ET.SubElement(ET.SubElement(cell, NS + "is"), NS + "t").text = value
    elif isinstance(value, bool):
        cell.set("t", "b")
        ET.SubElement(cell, NS + "v").text = str(int(value))
    elif value is not None:
        ET.SubElement(cell, NS + "v").text = str(value)


def edit_sheet(root, changes, calculated=None, strings=(), baseline_errors=None):
    data = root.find(NS + "sheetData")
    rows = {int(r.get("r")): r for r in data.findall(NS + "row")}
    cells = {c.get("r"): c for r in rows.values() for c in r.findall(NS + "c")}
    formulas = {addr: c.find(NS + "f") for addr, c in cells.items() if c.find(NS + "f") is not None}
    shared = {f.get("si"): (addr, f.text) for addr, f in formulas.items() if f.get("t") == "shared" and f.text}
    touched = {formulas[a].get("si") for a in changes if a in formulas and formulas[a].get("t") == "shared"}
    for addr, f in formulas.items():
        if f.get("t") == "shared" and f.get("si") in touched:
            anchor, expression = shared[f.get("si")]
            f.attrib.clear()
            f.text = Translator("=" + expression, origin=anchor).translate_formula(addr)[1:]
        if f.get("t") in ("array", "dataTable"):
            left, top, right, bottom = range_boundaries(f.get("ref", addr))
            if calculated is not None and (left != right or top != bottom):
                raise ValueError("多格数组或数据表缓存尚不能完整验证：" + addr)
            if any(top <= r <= bottom and left <= c <= right for r, c in map(coordinate_to_tuple, changes)):
                raise ValueError("不能覆盖数组或数据表公式 " + addr)
    for addr, val in changes.items():
        row, col = coordinate_to_tuple(addr)
        if addr not in cells:
            if row not in rows:
                rows[row] = ET.Element(NS + "row", r=str(row))
                index = next((i for i, r in enumerate(data) if int(r.get("r")) > row), len(data))
                data.insert(index, rows[row])
            cells[addr] = ET.Element(NS + "c", r=addr)
            parent = rows[row]
            index = next((i for i, c in enumerate(parent) if c.tag != NS + "c" or coordinate_to_tuple(c.get("r"))[1] > col), len(parent))
            parent.insert(index, cells[addr])
        cell_value(cells[addr], val)
    dim = root.find(NS + "dimension")
    if changes and dim is not None:
        bounds = range_boundaries(dim.get("ref"))
        positions = list(map(coordinate_to_tuple, changes))
        dim.set("ref", "A1:" + get_column_letter(max(bounds[2], *(c for _, c in positions))) + str(max(bounds[3], *(r for r, _ in positions))))
    for addr, cell in cells.items():
        if cell.find(NS + "f") is None:
            continue
        old = cell.find(NS + "v")
        if calculated is not None:
            result = calculated.get(addr)
            if result is None or result.find(NS + "v") is None:
                raise ValueError("重算缺少公式结果 " + addr)
            kind = result.get("t", "n")
            value = deepcopy(result.find(NS + "v"))
            if kind == "s":
                kind, value.text = "str", strings[int(value.text)]
            if kind == "e" and baseline_errors.get(addr) != value.text:
                raise ValueError("重算新增公式错误 " + addr + " " + str(value.text))
        if old is not None:
            cell.remove(old)
        cell.attrib.pop("t", None)
        if calculated is not None:
            cell.set("t", kind)
            cell.append(value)


def rewrite(source, dest, changes, cache=None, baseline=None):
    edits = {}
    for sheet, cell, value in changes:
        edits.setdefault(sheet, {})[cell] = value
    with ZipFile(source) as original, ZipFile(dest, "w") as output:
        paths = sheets(original)
        if edits.keys() - paths.keys():
            raise ValueError("写入目标工作表不存在")
        names = {p: s for s, p in paths.items()}
        cache_paths = sheets(cache) if cache else {}
        base_paths = sheets(baseline) if baseline else {}
        strings = []
        if cache and "xl/sharedStrings.xml" in cache.namelist():
            strings = ["".join(t.text or "" for t in si.iter(NS+"t")) for si in ET.fromstring(cache.read("xl/sharedStrings.xml"))]
        for part in original.infolist():
            key = part.filename
            raw = original.read(part)
            if key == "xl/calcChain.xml":
                continue
            if key in names:
                title = names[key]
                root = ET.fromstring(raw)
                calculated = baseline_errors = None
                if cache:
                    computed = ET.fromstring(cache.read(cache_paths[title]))
                    calculated = {c.get("r"): c for c in computed.iter(NS + "c")}
                    before = ET.fromstring(baseline.read(base_paths[title]))
                    baseline_errors = {c.get("r"): c.findtext(NS+"v") for c in before.iter(NS+"c") if c.get("t")=="e"}
                edit_sheet(root, edits.get(title, {}), calculated, strings, baseline_errors)
                raw = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
            elif key in ("xl/_rels/workbook.xml.rels", "[Content_Types].xml") and b"calcChain" in raw:
                root = ET.fromstring(raw)
                for node in list(root):
                    if node.get("Type", "").endswith("/calcChain") or node.get("PartName") == "/xl/calcChain.xml":
                        root.remove(node)
                raw = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
            output.writestr(part, raw)
