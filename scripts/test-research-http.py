import urllib.request,json,time,shutil
from pathlib import Path
import argparse, re, hashlib
parser=argparse.ArgumentParser(description='Local HTTP research acceptance; creates an isolated test project and uses the configured paid model.')
parser.add_argument('--workbook',required=True,type=Path)
parser.add_argument('--out',required=True,type=Path)
parser.add_argument('--url',default='http://127.0.0.1:8081')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
def api(path,data=None):
 req=urllib.request.Request(args.url.rstrip('/')+path,data=None if data is None else json.dumps(data,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 return json.load(urllib.request.urlopen(req,timeout=90))
project=api('/api/projects',{'name':'研究可靠性统一验收','note':'独立场景测试，不重放线上对话'})
pr=root/project['root']
src=args.workbook.resolve()
assert src.is_file(),src
shutil.copy2(src,pr/'uploads/model.xlsx')
out=args.out.resolve()
out.mkdir(exist_ok=True)
(out/'project.json').write_text(json.dumps(project,ensure_ascii=False))
print('Project',project['id'],flush=True)
cases=[
('metric-units','这份模型里HBM的收入占比和毛利率有什么区别？2026年收入是多少？资料：uploads/model.xlsx'),
('chart','估值模型中的143.89和-13从哪里来？它们能说明估值合理吗？资料：uploads/model.xlsx'),
('threshold-comparison','有人说，良率没到60%就不能商业化，还拿中芯国际现在的PE证明长鑫远期估值便宜。请核验这两个判断。资料：uploads/model.xlsx'),
('report','请把这份模型的2026年HBM收入、收入占比、毛利率和ASP核对清楚，写成一份简短报告保存到exports/HBM核验.md。资料：uploads/model.xlsx'),
('history-persistence','针对模型数据核验，你如何确保以后不再把毛利率和收入占比混淆？资料：uploads/model.xlsx'),
]
def run_case(case):
 name,question=case
 q='?project='+project['id'];session=api('/api/sessions'+q,{})['id'];prefix='/api/sessions/'+session
 assert api(prefix+'/messages'+q,{'text':question})['accepted']
 start=time.monotonic()
 while True:
  time.sleep(3);state=api(prefix+'/state'+q)
  if not state['streaming']:break
  if time.monotonic()-start>420:
   api(prefix+'/abort'+q,{})
   raise RuntimeError(name+' timeout')
 answer='\n'.join(m.get('text','') for m in state['messages'] if m['role']=='assistant')
 error=None
 if not answer.strip():
  logs=list((pr/'.pi/sessions').glob('*'+session+'*'))
  if logs:
   rows=[json.loads(line).get('message',{}) for line in logs[0].read_text().splitlines()]
   error=next((m.get('errorMessage') for m in reversed(rows) if m.get('errorMessage')),'empty answer')
 if not error and re.search('本轮分析未完成证据核验|报告尚未交付|报告未完成保存|已保存部分核验记录',answer):error='unresolved output'
 if not error and name=='metric-units' and not all(t in answer for t in ['65','2.1','72.93']):error='missing expected verified metrics'
 if not error and name=='chart' and not all(t in answer for t in ['143.89','2027','2030']):error='missing fit source or valuation periods'
 if not error and name=='threshold-comparison' and not re.search('无法|不足|不能|不可',answer):error='unsupported certainty'
 if not error and name=='history-persistence' and not re.search('自动加载|宿主|持久规则',answer):error='persistent host rules not explained'
 if not error and name=='report':
  report=pr/'exports/HBM核验.md'
  body=report.read_text() if report.exists() else ''
  if not all(ref in body for ref in ['AH13','AH32','AH42','AH122']) or '部分完成' in body:error='report incomplete'
 record={'status':'failed' if error else 'completed','error':error,'name':name,'session':session,'question':question,'answer':answer,'seconds':round(time.monotonic()-start),'state':state}
 (out/(name+'.json')).write_text(json.dumps(record,ensure_ascii=False))
 print(name,record['seconds'],record['status'],(error or answer[:220]),flush=True)
 return record
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(run_case,cases))
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False))
assert all(r['status']=='completed' for r in results),'HTTP acceptance failed; inspect saved evidence'
print('COMPLETE',flush=True)
