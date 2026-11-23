"""Regression cases for identity, actual/forecast periods and workbook preservation."""
from pathlib import Path
import sys
import unittest
from copy import deepcopy

from lxml import etree as ET
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "services" / name) for name in ("pdf", "workbook")]
from financial_statements import read_chinese_tables
from statement_mapping import map_statements
from model_layout import check_tolerance
from xlsx_package import NS, edit_sheet

ISSUER = {"code":"123456","market":"CN","name":"示例股份"}


def fact(metric, value, **fields):
    return dict(issuer=ISSUER, period="3Q26", metric=metric, unit="RMB mn",expected=value,
                decimals=3, basis="period",scope="合并",label=metric,source="filing.pdf",page=1,**fields)


def model():
    w = Workbook()
    s = w.active
    s.append(["P&L (RMB million)", "1Q26", "2Q26", "3Q26E"])
    s.append(["Revenue", 50, 60, 90])
    s.append(["Cost of sales", 10, 20, 30])
    return w


class StatementTests(unittest.TestCase):
    def test_tolerance_uses_check_precision_and_units(self):
        self.assertAlmostEqual(check_tolerance("#,##0.00"), 0.005)
        self.assertAlmostEqual(check_tolerance("0.0000"), 0.00005)
        self.assertAlmostEqual(check_tolerance("0.00%"), 0.00005)
        self.assertIsNone(check_tolerance("General"))

    def test_swapped_current_and_cumulative(self):
        text = """证券代码：123456  证券简称：示例股份
2026 年第三季度报告
主要会计数据和财务指标
单位：元 币种：人民币
项目           年初至报告期末                           本报告期
营业收入         900,000,000          100.0             300,000,000        40.0
"""
        rows, issues, _ = read_chinese_tables(text)
        self.assertFalse(issues)
        self.assertEqual((rows[0]["expected"],rows[0]["yearToDateReported"]), (300,900))

    def test_cumulative_table_begins_at_title_with_named_year_columns(self):
        text = """证券代码：123456  证券简称：示例股份
2026 年第三季度报告
第三季度财务报表是否经审计
□是 √否
销售费用    10,000,000   12,000,000
合并利润表
2026 年 1—9 月
单位：元 币种：人民币
2025 年前三季度    2026 年前三季度
销售费用    11,000,000   13,000,000
"""
        rows, issues, gaps = read_chinese_tables(text)
        self.assertFalse(issues or gaps)
        self.assertEqual([(r["expected"], r["audit"]) for r in rows], [(13, "未经审计")])

    def test_continuing_profit_scope(self):
        text = """截至2026年6月30日止六個月
財務業績摘要
2026年   2025年
人民幣千元
持續經營業務
期內利潤 ╱（虧損）       1,200     1,000
"""
        rows, _, _ = read_chinese_tables(text)
        self.assertEqual(rows[0]["scope"],"持续经营")

    def test_subject_and_restatement_block_writes(self):
        w = model()
        f = fact("Revenue", 70, yearToDateReported=180)
        self.assertFalse(map_statements(w,w,[f],"different_654321.SS.xlsx")[0])
        self.assertTrue(map_statements(w,w,[f],"model_123456.SS.xlsx")[0])
        f["yearToDateReported"] = 190
        self.assertFalse(map_statements(w,w,[f],"model_123456.SS.xlsx")[0])

    def test_forecast_cannot_be_subtracted_from_cumulative(self):
        w = model()
        w.active["B1"]="1Q26 Forecast"
        expense = dict(fact("Cost of sales", 90),basis="yearToDate")
        mapped, gaps, _ = map_statements(w,w,[fact("Revenue",70,yearToDateReported=180),expense],"123456.SS.xlsx")
        self.assertFalse(any(i["metric"]=="Cost of sales" for i in mapped))
        self.assertTrue(any(i["metric"]=="Cost of sales" for i in gaps))

    def test_next_quarter_only_uses_approved_forecast_cells(self):
        w = model()
        w.active["E1"] = "4Q26E"
        w.active["E2"] = 180
        w.active["E3"] = 40
        rows = [dict(fact("Revenue", 100, yearToDateReported=300), period="4Q26"),
                dict(fact("Cost of sales", 130), period="4Q26", basis="yearToDate")]
        records = {"Sheet!D2": dict(period="3Q26", scope="合并", issuer=ISSUER, expected=90)}
        mapped, gaps, _ = map_statements(w, w, rows, "123456.SS.xlsx", records)
        self.assertTrue(any(item["metric"] == "Cost of sales" for item in gaps))
        records["Sheet!D3"] = dict(period="3Q26", scope="合并", issuer=ISSUER, expected=30)
        mapped, gaps, _ = map_statements(w, w, rows, "123456.SS.xlsx", records)
        self.assertFalse(gaps)
        self.assertEqual(next(i["expected"] for i in mapped if i["metric"] == "Cost of sales"), 70)

    def test_separate_period_axis_is_never_rewritten(self):
        w = model()
        s = w.active
        s.append(["Tax ratio","=B3/B2","=C3/C2",0.3])
        s.append(["Other (RMB million)","1Q25","2Q25","3Q25"])
        s.append(["Unrelated","=B3/B2","=C3/C2",75])
        _, _, edits = map_statements(w,w,[fact("Revenue",70,yearToDateReported=180)],"123456.SS.xlsx")
        self.assertFalse(any(i["cell"]=="D6" for i in edits))

    def test_new_error_is_compared_to_recalculated_baseline(self):
        xml = f'<worksheet xmlns="{NS[1:-1]}"><sheetData><row r="1"><c r="A1"><f>1/0</f></c></row></sheetData></worksheet>'
        root = ET.fromstring(xml)
        cell = ET.fromstring(f'<c xmlns="{NS[1:-1]}" r="A1" t="e"><v>#DIV/0!</v></c>')
        copy = deepcopy(root)
        edit_sheet(copy, {}, {"A1":cell}, baseline_errors={"A1":"#DIV/0!"})
        with self.assertRaisesRegex(ValueError,"新增公式错误"):
            edit_sheet(copy, {}, {"A1":cell}, baseline_errors={})

    def test_multi_cell_formula_never_publishes_partial_cache(self):
        root = ET.fromstring(f'<worksheet xmlns="{NS[1:-1]}"><sheetData><row r="1"><c r="B1"><f t="array" ref="B1:C1">A1*2</f></c></row></sheetData></worksheet>')
        with self.assertRaisesRegex(ValueError,"多格"):
            edit_sheet(root, {}, {}, baseline_errors={})


if __name__ == "__main__":
    unittest.main()
