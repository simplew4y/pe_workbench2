"""Create non-confidential financial disclosures and forecast/check workbooks."""
import sys
from pathlib import Path

from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle


folder = Path(sys.argv[1])


def disclosure(filename, rows):
    table = Table(rows, repeatRows=1)
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))
    SimpleDocTemplate(str(folder / filename)).build([table])


workbook = Workbook()
sheet = workbook.active
sheet.title = "Model"
sheet.append(["Metric", "Unit", "1Q26", "2Q26", "3Q26", "FY2026E"])
sheet.append(["Sales", "CNY mn", 100, 110, "=D2*1.1", "=SUM(C2:E2)"])
sheet.append(["Target", None, None, None, "=E2/10"])
sheet.append(["Check", None, None, "=0.002"])
sheet.append(["Gross margin", "%", 0.18, 0.20])
sheet["D5"].number_format = "0.0%"
sheet.append(["Check", None, None, "=D2>0"])
sheet.append(["Operating margin", "%", 19, 20])
sheet["D7"].number_format = '0.0"%"'
year = workbook.create_sheet("Annual")
year.append(["Metric", "Unit", "FY2025", "FY2026"])
year.append(["Sales", "CNY mn", 2026, 2027])
year.append(["Cost", "CNY mn", 51, 52])
workbook.save(folder / "model.xlsx")
sheet["D4"] = "=D2-110"
workbook.save(folder / "unbalanced.xlsx")
sheet["D4"] = "=1-SIGN(ABS(D2-110))"
workbook.save(folder / "status-code.xlsx")
header = ["Metric", "Unit", "2Q26"]
disclosure("results.pdf", [header, ["Sales", "CNY mn", "104"], ["Gross margin", "%", "21"], ["Operating margin", "%", "22"]])
disclosure("other-unit.pdf", [header, ["Sales", "USD mn", "104"]])
disclosure("annual.pdf", [["Metric", "Unit", "FY2026"], ["Cost", "CNY mn", "66"]])
disclosure("cxmt.pdf", [["Metric", "Unit", "3Q26"], ["Interest expense", "CNY mn", "-910"]])
