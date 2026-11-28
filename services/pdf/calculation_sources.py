"""Recover source observations from selectable text and aligned period columns."""
import re
from itertools import combinations

NUM = re.compile(r'^(?:-?\d+(?:,\d{3})*(?:\.\d+)?|\(\d+(?:,\d{3})*(?:\.\d+)?\))%?$')
YEAR = re.compile(r'(?:19|20)\d{2}|[一二][〇零一二三四五六七八九]{3}年')
TERM = re.compile(r'年度|[個个]月|季度|years? ended|months? ended', re.I)
MONEY = re.compile(r'(?P<ccy>人民[幣币]|港[幣币]|美元|RMB|CNY|HKD|USD)?\s*(?P<unit>百[萬万]元|[萬万億亿千]元|元|millions?|mn|thousands?)', re.I)
CURRENCY = {'人民幣': 'CNY', '人民币': 'CNY', 'RMB': 'CNY', '港幣': 'HKD', '港币': 'HKD', '美元': 'USD'}


def money(match):
    ccy = (match['ccy'] or '').upper()
    unit = match['unit'].replace('萬', '万').replace('億', '亿').lower()
    if unit in ('mn', 'million', 'millions'):
        unit = '百万元'
    if unit in ('thousand', 'thousands'):
        unit = '千元'
    return unit, CURRENCY.get(ccy, ccy)


def lines(words):
    result = []
    for word in sorted(words, key=lambda w: (w['top'], w['x0'])):
        if not result or abs(word['top'] - result[-1][0]['top']) > 3:
            result.append([])
        result[-1].append(word)
    return [sorted(row, key=lambda w: w['x0']) for row in result]


def grouped_terms(row, centres):
    # Multi-column headings must align with the centre of one consecutive span.
    # Reject uncertain partitions instead of assigning each column by proximity.
    groups = []
    for word in row:
        if groups and word['x0'] - groups[-1]['x1'] < 6:
            groups[-1]['text'] += ' ' + word['text']
            groups[-1]['x1'] = word['x1']
        else:
            groups.append(dict(word))
    if not groups or not all(TERM.search(w['text']) for w in groups):
        return None
    n = len(centres)
    if n > 16 or len(groups) > n:
        return None
    gap = min(b-a for a, b in zip(centres, centres[1:]))
    if len(groups) == 1:
        centre = (groups[0]['x0'] + groups[0]['x1']) / 2
        return [groups[0]['text']] * n if abs(centre-(centres[0]+centres[-1])/2) < gap*.4 else None
    candidates = []
    for cuts in combinations(range(1, n), len(groups)-1):
        spans = list(zip((0, *cuts), (*cuts, n)))
        if all(abs((w['x0']+w['x1'])/2 - (centres[a]+centres[b-1])/2) < gap*.30
               for w, (a,b) in zip(groups, spans)):
            candidates.append([w['text'] for w, (a,b) in zip(groups, spans) for _ in range(a,b)])
    return candidates[0] if len(candidates) == 1 else None


def table_facts(rows):
    for index, header in enumerate(rows):
        years = [w for w in header if YEAR.search(w['text'])]
        if len(years) < 2 or len(years) > 16 or header[-len(years):] != years:
            continue
        centres = [(w['x0']+w['x1'])/2 for w in years]
        gap = min(b-a for a,b in zip(centres, centres[1:]))
        periods = [w['text'] for w in years]
        prior = rows[index-1] if index else []
        if TERM.search(' '.join(w['text'] for w in prior)):
            terms = grouped_terms(prior, centres)
            if not terms:
                continue
            periods = [term+' '+year for term,year in zip(terms, periods)]
        j = index+1
        if j < len(rows) and len(rows[j]) == len(years) and all(
            re.search(r'月|日|Dec|Sep|Jun|Mar', w['text'], re.I) and abs(w['x1']-y['x1']) < gap*.4
            for w,y in zip(rows[j],years)
        ):
            periods = [p+' '+w['text'] for p,w in zip(periods,rows[j])]
            j += 1
        if len(set(periods)) != len(periods):
            continue
        # A table-wide unit may sit immediately above or below the column labels.
        unit_match = None
        for u in [j, index-1]:
            if not 0 <= u < len(rows):
                continue
            label = ' '.join(w['text'] for w in rows[u])
            matches = list(MONEY.finditer(label))
            if len(matches) == 1 and not re.search(r'\d', label) and len(label) < 64:
                unit_match = matches[0]
                if u == j:
                    j += 1
                break
        while j < len(rows):
            row = rows[j]
            j += 1
            cells = row[-len(years):]
            label = row[:-len(years)]
            if not label or not all(NUM.fullmatch(w['text']) and
                    min(abs(w['x1']-y['x1']), abs((w['x0']+w['x1'])/2-c)) < gap*.38
                    for w,y,c in zip(cells,years,centres)):
                break
            metric = ' '.join(w['text'] for w in label)
            if any(NUM.fullmatch(w['text']) for w in label):
                break
            excerpt = ' '.join(w['text'] for w in row)
            for col, (w, period) in enumerate(zip(cells,periods), 1):
                if w['text'].endswith('%'):
                    unit, ccy = '%', ''
                elif MONEY.search(metric) or re.search(r'每股|每單位|每单位|per share|倍數|倍数|比率|百分比|股數|股数', metric, re.I):
                    # Row-level units can override a monetary table heading.
                    continue
                elif unit_match:
                    unit, ccy = money(unit_match)
                else:
                    continue
                yield dict(row=j, column=col, metric=metric, period=period,
                           excerpt='\n'.join([period, unit_match.string if unit_match else unit, excerpt]), value=w['text'], display_unit=unit, currency=ccy)


# A standalone prose observation must supply its own period, metric and unit.
# Multiple amounts or relatives such as "last year" need a more specific source.
def prose_facts(rows):
    for row, words in enumerate(rows, 1):
        text = ' '.join(w['text'] for w in words)
        for col, sentence in enumerate(re.split(r'[。；;]', text), 1):
            m = re.fullmatch(r'\s*((?:FY\s*)?(?:19|20)\d\d(?:年(?:度|第[一二三四1234]季[度]?)?)?)\s*'
                             r'([^\d，,。；;：:]{1,64}?)(?:为|為|[:：])\s*'
                             r'(人民[幣币]|港[幣币]|美元)?\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*'
                             r'(百[萬万]元|[萬万億亿千]元|元|%)\s*', sentence)
            if m:
                yield dict(row=row,column=col,period=m[1],metric=m[2].strip(),excerpt=sentence.strip(),
                           value=m[4],display_unit=m[5].replace('萬','万').replace('億','亿'),
                           currency=CURRENCY.get(m[3], ''))


def calculation_sources(path, page):
    import pdfplumber
    with pdfplumber.open(path, pages=[page]) as pdf:
        if len(pdf.pages) != 1 or pdf.pages[0].page_number != page:
            raise ValueError('PDF 页码超出范围')
        rows = lines(pdf.pages[0].extract_words())
        return list(table_facts(rows)) + list(prose_facts(rows))
