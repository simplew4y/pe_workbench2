import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {insideProjectRealRoot} from './workspace-path.mjs';
import {researchContract} from './research-contract.mjs';
import {validateState} from './validate-state.mjs';
import {closeResearchDocument} from './research-document-closure.mjs';
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const collections=['assumptions','theses','sensitivities','valuations','falsifiers','gaps','changes'];
const stripStatus=text=>text.split(/\n\s*\n/).filter(p=>
  !/^\s*(?:\*\*)?(?:文件状态|文件交付)[：:]/.test(p) && !/^文件尚未保存[：:]/.test(p)).join('\n\n').trim();

// Host-only publication. A path-level "saved" flag is not a version approval.
export function publishFinalReport({root,draft,outcome,question,receipts=[],authorizeWrite=()=>undefined,record=()=>{}}) {
  if(!researchContract(question).artifactRequested || !draft?.saveRequested ||
    !['completed','partial'].includes(outcome.status) || !outcome.text?.trim())return outcome;
  const failed=reason=>({...outcome,status:'partial',text:stripStatus(outcome.text)+'\n\n**文件交付**：本次最终版本未发布；已有文件仍为此前版本，不能代表以上正文。'+reason+'。',reportPublication:{path:draft.path,saved:false,reason},
    reason:[outcome.reason,reason].filter(Boolean).join('；'),analysisState:null});
  const resolve=relative=>{
    const absolute=path.resolve(root,relative || ''),rel=path.relative(root,absolute).split(path.sep).join('/');
    if(!rel.startsWith('exports/'))throw Error('交付路径不在允许的导出目录');
    let existing=absolute;while(!fs.existsSync(existing))existing=path.dirname(existing);
    if(!insideProjectRealRoot(root,existing) || fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink())throw Error('交付路径越过项目真实路径或为符号链接');
    return absolute;
  };
  const read=file=>fs.existsSync(file)?fs.readFileSync(file):null;
  let lock,locked=false;const temporary=[],written=[];
  try {
    if(!draft.path.endsWith('.md'))throw Error('报告必须为Markdown文件');
    const report=resolve(draft.path),oldReport=read(report);
    const owned=(relative,content)=>content && receipts.some(r=>r.path===relative && r.saved && r.sha256===hash(content));
    if(oldReport && !owned(draft.path,oldReport))throw Error('目标报告不是本轮可核对版本，保留现有文件');
    if(oldReport && receipts.some(r=>r.path===draft.path && r.publication==='final_delivery') && draft.baseline!==hash(oldReport))throw Error('本轮最终版本已发布，拒绝重复覆盖');
    if(!oldReport && draft.baseline!=null)throw Error('报告基线已改变，停止发布');
    const dir=path.posix.dirname(draft.path),statePath=dir+'/analysis-state.json';
    const stateFile=resolve(statePath),oldState=read(stateFile),state=oldState?JSON.parse(oldState):null;
    const validation=state?validateState(state):null;
    let text=stripStatus(outcome.text),status=outcome.status;
    const aligned=state && draft.stateBinding?.stateHash===hash(oldState) &&
      draft.stateBinding?.reportHash===hash(text) && !draft.issues?.length &&
      validation.ok && !validation.warnings.length && status==='completed';
    const pending=state && !aligned;
    if(pending && !owned(statePath,oldState))throw Error('状态文件不是本轮可核对版本，不能替换或启用监控');
    if(draft.issues?.length || pending)status='partial';
    const version=crypto.randomUUID(),backupDir=dir+'/backups/delivery-'+version;
    const candidatePath=backupDir+'/analysis-state.json';
    const candidateReportPath=backupDir+'/review-candidate.md';
    let nextState=state;
    if(pending) {
      const ids=collections.flatMap(k=>(state[k] || []).map(row=>row.id));
      text=closeResearchDocument(draft.content || text,text,{invalidateIds:ids}).text;
      // Never invent thresholds by parsing prose. Preserve the full candidate
      // in a backup; the active state must not expose conflicting live IDs.
      nextState={...state,stage:'draft',model:{understanding:{revenue:'',costs_profit:'',cash_flow:'',valuation:''},checks:[],write_enabled:false},
        ...Object.fromEntries(collections.map(k=>[k,[]])),review:{status:'pending_alignment',mode:'self'}};
      delete nextState.presentation;nextState.tracking={};
      text+='\n\n**跟踪状态**：本轮正文与候选状态未通过同版核对，观点及监控条件暂未发布，自动监控未启用。候选记录已保留供后续核验。';
    }
    if(status==='partial' && !text.startsWith('> 部分完成：'))text='> 部分完成：以下为已交付的分析与证据边界，未核事项仍需补证。\n\n'+text;
    text+='\n\n**文件交付**：['+path.basename(draft.path)+']('+encodeURI(draft.path)+') 已保存'+
      (state?'；[analysis-state.json]('+encodeURI(statePath)+') '+(pending?'已保存为待核状态，未启用监控':'已与报告绑定'):'')+'。';
    const reportHash=hash(text);
    if(nextState)nextState={...nextState,delivery:{version,status:pending?'pending_alignment':'aligned',trackingEnabled:!pending,
      reportPath:draft.path,reportHash,...(pending?{candidatePath,candidateHash:hash(oldState),
        ...(draft.content?{candidateReportPath,candidateReportHash:hash(draft.content)}:{})}:{})}};
    if(nextState && !validateState(nextState).ok)throw Error('待交付状态文件结构校验失败');
    const entries=[{path:draft.path,file:report,old:oldReport,body:text}];
    if(nextState)entries.push({path:statePath,file:stateFile,old:oldState,body:JSON.stringify(nextState,null,2)+'\n'});
    const manifestPath=dir+'/delivery-manifest.json',manifestFile=resolve(manifestPath);
    const manifest={version,status,report:{path:draft.path,sha256:reportHash},state:nextState?{path:statePath,sha256:hash(entries[1].body),trackingEnabled:!pending}:null};
    entries.push({path:manifestPath,file:manifestFile,old:read(manifestFile),body:JSON.stringify(manifest,null,2)+'\n'});
    for(const e of entries){const denial=authorizeWrite({path:e.path,content:e.body});if(denial?.block)throw Error(denial.reason);}
    fs.mkdirSync(path.dirname(report),{recursive:true});
    lock=path.join(path.dirname(report),'.delivery-lock');fs.mkdirSync(lock);locked=true;
    if(pending && draft.content) {
      const candidate=resolve(candidateReportPath),denial=authorizeWrite({path:candidateReportPath,content:draft.content});
      if(denial?.block)throw Error(denial.reason);
      fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.writeFileSync(candidate,draft.content,{flag:'wx'});
    }
    for(const e of entries) {
      if(e.old) {
        const backupPath=backupDir+'/'+path.basename(e.path),backup=resolve(backupPath);
        const denial=authorizeWrite({path:backupPath,content:e.old.toString()});if(denial?.block)throw Error(denial.reason);
        fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,e.old,{flag:'wx'});
      }
      e.temp=e.file+'.'+version+'.tmp';temporary.push(e.temp);fs.writeFileSync(e.temp,e.body,{flag:'wx'});
    }
    for(const e of entries) {
      const actual=read(e.file);
      if((actual===null)!==(e.old===null) || actual && hash(actual)!==hash(e.old))throw Error('发布前文件基线改变');
    }
    // Commit marker last. Failed writes are rolled back, and readers only
    // expose a state whose manifest and report hashes match.
    for(const e of entries){fs.renameSync(e.temp,e.file);written.push(e);if(fs.readFileSync(e.file,'utf8')!==e.body)throw Error('全文回读不一致');}
    const published=entries.map(e=>({path:e.path,saved:true,sha256:hash(e.body),publication:'final_delivery',version,researchStatus:status,
      ...(e.path===statePath?{trackingEnabled:!pending}:{} )}));
    published.forEach(record);
    return {...outcome,text,status,reportPublication:{...published[0],answerHash:reportHash,manifestPath},deliveryBundle:manifest,
      ...(nextState?{analysisState:pending?null:nextState,analysisStatePath:statePath}:{}),
      // Earlier lint reasons may describe a report that had not yet been
      // published. Preserve them as history, not as the current file status.
      publicationReview:{priorReason:outcome.reason || '',issues:draft.issues || []},
      reason:status==='completed'?'':pending?'报告已交付；正文与候选状态尚未对齐，候选版本已留档且未启用监控':'报告已交付；研究仍有待核事项，详见正文的证据边界'};
  } catch(error) {
    for(const e of written.reverse())if(read(e.file) && hash(read(e.file))===hash(e.body)) {
      if(e.old){const rollback=e.file+'.rollback-'+crypto.randomUUID();fs.writeFileSync(rollback,e.old);fs.renameSync(rollback,e.file);}
      else fs.unlinkSync(e.file);
    }
    return failed('报告交付失败：'+error.message);
  } finally {
    for(const file of temporary)if(fs.existsSync(file))fs.unlinkSync(file);
    if(locked)fs.rmdirSync(lock);
  }
}
