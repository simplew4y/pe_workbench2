/** Project-scoped authoritative numeric memory, in the existing application DB.
 * Payloads are immutable versions. Mutable lifecycle/publication columns are views.
 * All queries bind the server-selected project, never a model-supplied project ID.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeValue, norm, periodKey, sameIdentity } from './value.mjs';
import { adaptToolResult, CAPTURE_TOOLS } from './adapters.mjs';
import { calculate } from '../calc-tool.mjs';
const json=v=>JSON.stringify(v);
const hash=v=>createHash('sha256').update(typeof v==='string'?v:json(v)).digest('hex');
const now=()=>new Date().toISOString();
const id=v=>hash(v).slice(0,32);
const safeError=code=>Object.assign(new Error(code),{code});
const rows=v=>Array.isArray(v)?v:[];
const identityKeys=['entity','metric','period','scope','basis_type','scenario','currency','canonical_unit'];
const pickIdentity=value=>Object.fromEntries(identityKeys.map(k=>[k,value?.[k] ?? (k==='basis_type'?'unknown':'')]));
const parse=r=>r?{...JSON.parse(r.payload),...(r.lifecycle?{lifecycle:r.lifecycle}:{}),...(r.status?{status:r.status}:{})}:null;
export class FactMemory {
  constructor({store,projectId=store.projectId,root=store.workspace}) {
    if (!projectId || !root) throw safeError('project_required');
    this.store=store; this.db=store.db; this.projectId=projectId; this.root=path.resolve(root);
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      create table if not exists fm_schema (version integer primary key);
      insert or ignore into fm_schema values (1);
      create table if not exists fm_events (project_id text, event_id text, session_id text, tool_call_id text, status text not null, payload text not null, error text, attempts integer not null default 0, created_at text, primary key(project_id,event_id));
      create table if not exists fm_sources (project_id text, source_id text, asset_id text, source_version text, sha256 text, payload text not null, primary key(project_id,source_id));
      create table if not exists fm_evidence (project_id text, evidence_id text, source_id text, payload text not null, primary key(project_id,evidence_id));
      create table if not exists fm_facts (project_id text, fact_id text, fact_version integer, source_id text, lifecycle text not null, payload text not null, primary key(project_id,fact_id,fact_version));
      create index if not exists fm_facts_current on fm_facts(project_id,lifecycle);
      create table if not exists fm_calculations (project_id text, calculation_id text, payload text not null, primary key(project_id,calculation_id));
      create table if not exists fm_frameworks (project_id text, framework_id text, revision integer, status text not null, payload text not null, primary key(project_id,framework_id,revision));
      create table if not exists fm_outbox (project_id text, event_id text, status text not null, payload text not null, error text, attempts integer not null default 0, primary key(project_id,event_id));
    `);
  }
  tx(fn) {
    this.db.exec('begin immediate');
    try {const value=fn();this.db.exec('commit');return value;} catch(e){this.db.exec('rollback');throw e;}
  }
  eventKey(sessionId,call) {return `tool:${id([sessionId,call.id || hash(call)])}`;}
  beginTool(sessionId,call,metadata={}) {
    const eventId=this.eventKey(sessionId,call);
    this.db.prepare('insert or ignore into fm_events(project_id,event_id,session_id,tool_call_id,status,payload,created_at) values(?,?,?,?,?,?,?)').run(this.projectId,eventId,sessionId,call.id || '', 'started',json({call:{id:call.id,name:call.name,args:call.args},metadata:{...metadata,session_id:sessionId},schema_version:1}),now());
    return eventId;
  }
  capture(sessionId,call,metadata={}) {
    if (!CAPTURE_TOOLS.has(call.name)) return [];
    const eventId=this.beginTool(sessionId,call,metadata);
    const existing=this.db.prepare('select status,payload from fm_events where project_id=? and event_id=?').get(this.projectId,eventId);
    if(existing.status==='processed') {
      const saved=JSON.parse(existing.payload).call;
      if(hash([saved.name,saved.args,saved.details,saved.success])!==hash([call.name,call.args,call.details,call.success])) throw safeError('event_id_conflict');
      return this.eventFacts(eventId);
    }
    // Commit receipt separately: normalization failure cannot erase raw tool output.
    this.db.prepare('update fm_events set status=?, payload=?, error=null where project_id=? and event_id=?').run(call.success?'received':'tool_failed',json({call,metadata:{...metadata,session_id:sessionId},schema_version:1}),this.projectId,eventId);
    if (!call.success) return [];
    return this.processEvent(eventId);
  }
  processEvent(eventId) {
    const row=this.db.prepare('select * from fm_events where project_id=? and event_id=?').get(this.projectId,eventId);
    if(!row || !['received','failed'].includes(row.status)) return this.eventFacts(eventId);
    try {
      return this.tx(()=>{
        const {call,metadata}=JSON.parse(row.payload), adapted=adaptToolResult(call), evidenceByKey=new Map();
        for(const input of adapted.evidence) {
          let e={...input};
          // Resolve through the project store; a foreign material is indistinguishable from missing.
          const source=this.store.getVersionRow?.(e.asset_id,Number(e.source_version));
          if (this.store.getVersionRow) {
            if(!source || (e.sha256 && source.version.blob_sha256!==e.sha256)) throw safeError('evidence_source_unavailable');
            e.sha256=source.version.blob_sha256;
          }
          const source_id=`source:${id([e.asset_id,e.source_version,e.sha256])}`;
          const sourceVersion={source_id,asset_id:e.asset_id,source_version:e.source_version,sha256:e.sha256,schema_version:1};
          this.db.prepare('insert or ignore into fm_sources values(?,?,?,?,?,?)').run(this.projectId,source_id,e.asset_id,e.source_version,e.sha256,json(sourceVersion));
          const evidence_id=`evidence:${id([source_id,e.locator,e.extractor,e.excerpt,e.raw_value])}`;
          e={...e,evidence_id,source_id,schema_version:1,created_at:now()};
          this.db.prepare('insert or ignore into fm_evidence values(?,?,?,?)').run(this.projectId,evidence_id,source_id,json(e));
          evidenceByKey.set(e.key,e);
        }
        const facts=adapted.facts.map(input=>this._append(input,{event_id:eventId,...metadata},evidenceByKey.get(input.evidence_key)));
        this.db.prepare("update fm_events set status='processed',payload=?,error=null,attempts=attempts+1 where project_id=? and event_id=?").run(json({...JSON.parse(row.payload),fact_refs:facts.map(f=>({fact_id:f.fact_id,fact_version:f.fact_version})),coverage:adapted.coverage}),this.projectId,eventId);
        return facts;
      });
    } catch(e) {
      this.db.prepare("update fm_events set status='failed',error=?,attempts=attempts+1 where project_id=? and event_id=?").run(e.code || 'normalization_failed',this.projectId,eventId);
      throw e;
    }
  }
  recover({markInterrupted=false}={}) {
    if(markInterrupted) this.db.prepare("update fm_events set status='interrupted',error='result_not_received' where project_id=? and status='started'").run(this.projectId);
    const results=[];
    for(const row of this.db.prepare("select event_id from fm_events where project_id=? and status in ('received','failed') order by created_at").all(this.projectId)) {
      try {this.processEvent(row.event_id);results.push({event_id:row.event_id,status:'processed'});} catch {results.push({event_id:row.event_id,status:'failed'});}
    }
    return results;
  }
  eventFacts(eventId) {
    const event=this.db.prepare('select payload from fm_events where project_id=? and event_id=?').get(this.projectId,eventId);
    const refs=event?JSON.parse(event.payload).fact_refs:null;
    return refs?refs.map(r=>this.get(r.fact_id,r.fact_version)).filter(Boolean):this.allFacts().filter(f=>f.event_id===eventId);
  }
  evidence(evidenceId) {return parse(this.db.prepare('select payload from fm_evidence where project_id=? and evidence_id=?').get(this.projectId,evidenceId));}
  listEvidence({limit=30}={}) {return this.db.prepare('select payload from fm_evidence where project_id=? order by rowid desc limit ?').all(this.projectId,Math.min(100,Math.max(1,limit))).map(parse);}
  get(factId,version) {
    if(!Number.isInteger(version) || version<1) return null;
    return parse(this.db.prepare('select * from fm_facts where project_id=? and fact_id=? and fact_version=?').get(this.projectId,factId,version));
  }
  allFacts() {return this.db.prepare('select * from fm_facts where project_id=? order by rowid').all(this.projectId).map(parse);}
  _append(input,metadata={},evidence=null,{factId=null,expectedVersion=null}={}) {
    const normalized=normalizeValue(input.raw_value,input.raw_unit || '',input.currency || '');
    const f={...input,...normalized,schema_version:1,quality:'candidate',created_at:now(),...metadata};
    for(const k of identityKeys) f[k]=String(f[k] ?? (k==='basis_type'?'unknown':''));
    f.origin_type=['disclosed','user','calculated'].includes(f.origin_type)?f.origin_type:'disclosed';
    f.evidence_ids=evidence?[evidence.evidence_id]:rows(input.evidence_ids);
    f.source_id=evidence?.source_id || null;
    const required=['entity','metric','period','scope','basis_type'];
    const missing=required.filter(k=>!f[k] || f[k]==='unknown');
    if(!['actual','forecast','assumption'].includes(f.basis_type)) missing.push('basis_type');
    if(f.canonical_unit==='元' && !f.currency) missing.push('currency');
    if(f.canonical_value==null || normalized.reason) missing.push(normalized.reason || 'numeric_value');
    // Semantic validation is separate from structural validation. Agent annotations
    // alone never promote a value. Every identity component must match the extractor.
    const sourceNumeric=evidence?normalizeValue(evidence.raw_value,evidence.raw_unit,evidence.identity?.currency || ''):null;
    const identitySupported=evidence && required.concat('scenario').every(k=>norm(evidence.identity?.[k])===norm(f[k])) && sourceNumeric.currency===f.currency && sourceNumeric.canonical_unit===f.canonical_unit;
    const sourceComplete=evidence?.sha256 && evidence.source_version && evidence.locator;
    const sourceChecked=sourceComplete && identitySupported && !missing.length && !evidence.scanned && !evidence.truncated &&
      !evidence.formula && sourceNumeric.canonical_value===f.canonical_value;
    f.quality=sourceChecked?'source_checked':'needs_review';
    f.review_reasons=[...new Set([...missing,...(!evidence?['no_evidence']:[]),...(!sourceComplete?['incomplete_source']:[]),...(!identitySupported?['identity_not_source_checked']:[]),...(evidence?.formula?['cached_formula_not_recalculated']:[]),...(input.reason?[input.reason]:[])])];
    if(input.calculation_verified && !missing.length) {f.quality='source_checked';f.review_reasons=[];}
    if(metadata.actor==='automation') {f.quality='needs_review';f.review_reasons.push('background_candidate');}
    const identity=identityKeys.map(k=>k==='period'?periodKey(f[k]):norm(f[k]));
    const complete=!missing.length;
    f.fact_id=factId || `fact:${id([identity,...(complete?[]:[f.evidence_ids,metadata.session_id || '',input.expression || '',input.raw_value])])}`;
    const prior=this.db.prepare('select * from fm_facts where project_id=? and fact_id=? order by fact_version desc limit 1').get(this.projectId,f.fact_id);
    const previous=parse(prior);
    if(expectedVersion!=null && previous?.fact_version!==expectedVersion) throw safeError('revision_conflict');
    // Repeating a read in a new session does not create a new semantic version.
    const duplicate=this.db.prepare("select * from fm_facts where project_id=? and fact_id=? and lifecycle='current'").all(this.projectId,f.fact_id).map(parse).find(p=>p.canonical_value===f.canonical_value && p.source_id===f.source_id && json(p.evidence_ids)===json(f.evidence_ids) && p.quality===f.quality && p.origin_type===f.origin_type && json(p.inputs)===json(f.inputs) && sameIdentity(p,f));
    if(duplicate) return duplicate;
    if(expectedVersion!=null && previous && !sameIdentity(previous,f)) throw safeError('identity_conflict');
    f.fact_version=(prior?.fact_version || 0)+1;
    const versions=this.allFacts().filter(v=>v.fact_id===f.fact_id);
    const assetOf=v=>v.evidence_ids?.length?this.evidence(v.evidence_ids[0])?.asset_id:null;
    const sameAssetVersions=evidence?versions.filter(v=>assetOf(v)===evidence.asset_id):[];
    const olderSource=sameAssetVersions.some(v=>Number(this.evidence(v.evidence_ids[0])?.source_version)>Number(evidence.source_version));
    const replace=versions.filter(v=>metadata.actor!=='automation' && v.lifecycle==='current' && !olderSource && (expectedVersion!==null || (evidence && assetOf(v)===evidence.asset_id) || (f.calculation_verified && v.origin_type==='calculated')));
    for(const old of replace) {
      this.db.prepare("update fm_facts set lifecycle='superseded' where project_id=? and fact_id=? and fact_version=?").run(this.projectId,old.fact_id,old.fact_version);
      this._invalidate(old);
    }
    if(replace.length) f.supersedes=replace.map(v=>v.fact_version);
    const conflicting=versions.filter(v=>v.lifecycle==='current'&&!replace.includes(v)&&v.canonical_value!==f.canonical_value);
    if(conflicting.length) f.review_reasons.push('conflicting_source');
    const lifecycle=olderSource?'stale':'current';
    this.db.prepare('insert into fm_facts values(?,?,?,?,?,?)').run(this.projectId,f.fact_id,f.fact_version,f.source_id,lifecycle,json(f));
    return {...f,lifecycle};
  }
  bind(params,metadata={}) {
    const {evidence_id,raw_value,raw_unit}=params,identity=pickIdentity(params);
    const evidence=this.evidence(evidence_id); if(!evidence) throw safeError('evidence_unavailable');
    // Require exact source numeric token, not an arbitrary number embedded in a page number.
    if(evidence.raw_value==null) {
      const needle=String(raw_value).trim();
      const tokens=evidence.excerpt.match(/[+-]?(?:\d[\d,]*(?:\.\d+)?)(?:%)?/g) || [];
      if(!tokens.includes(needle)) throw safeError('value_not_in_evidence');
    } else if (normalizeValue(evidence.raw_value,evidence.raw_unit,evidence.identity?.currency || '').canonical_value!==normalizeValue(raw_value,raw_unit,identity.currency).canonical_value) throw safeError('value_not_in_evidence');
    return this.tx(()=>this._append({...identity,raw_value,raw_unit,origin_type:'disclosed'},{...metadata,event_id:`binding:${randomUUID()}`},evidence));
  }
  correct({fact_id,expected_version,identity,raw_value,raw_unit,reason},metadata={}) {
    identity=pickIdentity(identity);
    this.syncSources();
    return this.tx(()=>{
      const prior=this.get(fact_id,expected_version);
      if(!prior || !sameIdentity(prior,identity)) throw safeError('fact_unavailable_or_identity_conflict');
      if(!reason) throw safeError('correction_reason_required');
      const corrected=this._append({...identity,raw_value,raw_unit,origin_type:'user',correction_reason:reason,reason:'user_correction_requires_review'},metadata,null,{factId:fact_id,expectedVersion:expected_version});
      // No approval to modify legacy reports or model is implied by this candidate.
      return corrected;
    });
  }
  _invalidate(prior) {
    const queue=[prior],seen=new Set();
    while(queue.length) {
      const f=queue.shift(),key=`${f.fact_id}@${f.fact_version}`; if(seen.has(key)) continue;seen.add(key);
      for(const candidate of this.allFacts()) if(candidate.lifecycle==='current' && rows(candidate.inputs).some(r=>r.fact_id===f.fact_id && r.fact_version===f.fact_version)) {
        this.db.prepare("update fm_facts set lifecycle='stale' where project_id=? and fact_id=? and fact_version=?").run(this.projectId,candidate.fact_id,candidate.fact_version);queue.push(candidate);
      }
    }
    for(const r of this.db.prepare('select * from fm_frameworks where project_id=?').all(this.projectId)) {
      if(rows(JSON.parse(r.payload).fact_refs).some(f=>seen.has(`${f.fact_id}@${f.fact_version}`))) this.db.prepare("update fm_frameworks set status=case when status in ('pending','stale_pending') then 'stale_pending' else 'stale' end where project_id=? and framework_id=? and revision=?").run(this.projectId,r.framework_id,r.revision);
    }
  }
  syncSources() {
    if(!this.store.getVersionRow) return;
    this.tx(()=>{
      for(const f of this.allFacts().filter(f=>f.lifecycle==='current' && f.source_id)) {
        const e=this.evidence(f.evidence_ids[0]);
        const current=e && this.store.getVersionRow(e.asset_id);
        if(!current || current.version.blob_sha256!==e.sha256) {
          this.db.prepare("update fm_facts set lifecycle='stale' where project_id=? and fact_id=? and fact_version=?").run(this.projectId,f.fact_id,f.fact_version);this._invalidate(f);
        }
      }
    });
  }
  query(filters={}) {
    try {
      this.syncSources();
      let facts=this.allFacts();
      for(const key of identityKeys.concat('fact_id')) if(filters[key]!=null && filters[key]!=='') facts=facts.filter(f=>key==='period'?periodKey(f[key])===periodKey(filters[key]):norm(f[key])===norm(filters[key]));
      if(filters.fact_version!=null) facts=facts.filter(f=>f.fact_version===filters.fact_version);
      const history=Boolean(filters.history || filters.fact_version);
      if(!history) {
        const current=facts.filter(f=>f.lifecycle==='current');
        if(!current.length && facts.length) return {status:'stale',facts:[],historical_refs:facts.map(f=>({fact_id:f.fact_id,fact_version:f.fact_version})),coverage:'project_registered_only'};
        facts=current;
      }
      const variants=new Set(facts.map(f=>json(identityKeys.map(k=>f[k]))));
      const conflict=facts.some(f=>facts.some(g=>f!==g && sameIdentity(f,g) && f.canonical_value!==g.canonical_value));
      const status=!facts.length?'not_found':variants.size>1 || conflict?'ambiguous':'found';
      const limit=Math.min(100,Math.max(1,Number(filters.limit)||30));
      return {status,facts:facts.slice(0,limit),total:facts.length,truncated:facts.length>limit,coverage:'project_registered_only',requires_review:facts.some(f=>f.quality!=='source_checked'),history};
    } catch {return {status:'retrieval_failed',facts:[],reason:'fact_store_unavailable',coverage:'unknown'};}
  }
  calculate({operation,inputs,identity,precision=8},metadata={}) {
    identity=pickIdentity(identity);
    this.syncSources();
    return this.tx(()=>{
      const facts=rows(inputs).map(r=>this.get(r.fact_id,r.fact_version));
      if(facts.length!==2 || facts.some(f=>!f || f.lifecycle!=='current' || f.quality!=='source_checked')) throw safeError('calculation_input_unavailable');
      const [a,b]=facts;
      if(a.currency!==b.currency && operation!=='multiple') throw safeError('currency_mismatch');
      if(periodKey(a.period)!==periodKey(b.period) || norm(a.entity)!==norm(b.entity) || norm(a.scope)!==norm(b.scope) || a.basis_type!==b.basis_type || a.scenario!==b.scenario) throw safeError('calculation_basis_mismatch');
      if(!['ratio','subtract','add','multiple'].includes(operation)) throw safeError('unsupported_operation');
      if(operation==='multiple'?b.canonical_unit!=='multiple':a.canonical_unit!==b.canonical_unit) throw safeError('unit_mismatch');
      const symbol={ratio:'/',subtract:'-',add:'+',multiple:'*'}[operation];
      const expression=`(${a.canonical_value})${symbol}(${b.canonical_value})`;
      const computed=calculate({expression,precision});
      const expected={entity:a.entity,period:a.period,scope:a.scope,basis_type:a.basis_type,scenario:a.scenario};
      if(Object.keys(expected).some(k=>norm(identity?.[k])!==norm(expected[k]))) throw safeError('output_identity_mismatch');
      const raw_unit=operation==='ratio'?'decimal':a.canonical_unit;
      const calculation_id=`calculation:${id([operation,inputs,identity,precision])}`;
      const result=this._append({...identity,raw_value:computed.value,raw_unit,currency:operation==='ratio'?'':a.currency,origin_type:'calculated',inputs,calculation_id,calculation_verified:true},metadata);
      this.db.prepare('insert or ignore into fm_calculations values(?,?,?)').run(this.projectId,calculation_id,json({calculation_id,inputs,expression,operation,precision,rounding:'half_away_from_zero',calculator_version:'pe-decimal-v1',output:{fact_id:result.fact_id,fact_version:result.fact_version},unit_conversions:facts.map(f=>({raw_unit:f.raw_unit,multiplier:f.multiplier,canonical_unit:f.canonical_unit}))}));
      return result;
    });
  }
  commitFramework({framework_id,expected_revision,state,report,fact_refs},metadata={}) {
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(framework_id || '') || !Number.isInteger(expected_revision) || expected_revision<0 || !state || typeof report!=='string') throw safeError('invalid_framework');
    if(!rows(fact_refs).length) throw safeError('fact_references_required');
    this.syncSources();
    return this.tx(()=>{
      const prior=this.db.prepare('select max(revision) as revision from fm_frameworks where project_id=? and framework_id=?').get(this.projectId,framework_id);
      if((prior.revision || 0)!==expected_revision) throw safeError('revision_conflict');
      for(const ref of fact_refs) {
        const f=this.get(ref.fact_id,ref.fact_version);
        if(!f || f.lifecycle!=='current') throw safeError('fact_reference_unavailable');
        if(f.quality!=='source_checked' && ref.role!=='needs_review' && ref.role!=='assumption') throw safeError('fact_not_source_checked');
        if(ref.role==='assumption' && f.basis_type!=='assumption') throw safeError('assumption_identity_required');
      }
      const revision=expected_revision+1;
      const snapshot={...state,framework_id,revision,parent_revision:expected_revision || null,fact_refs,schema_memory_version:1};
      const markdown=`<!-- fact-memory ${framework_id} revision ${revision} snapshot ${hash(snapshot)} -->\n${report}`;
      const payload={framework_id,revision,parent_revision:expected_revision || null,state:snapshot,report:markdown,fact_refs,numeric_validation:'references_only',state_hash:hash(json(snapshot)),report_hash:hash(markdown),...metadata,created_at:now()};
      this.db.prepare('insert into fm_frameworks values(?,?,?,?,?)').run(this.projectId,framework_id,revision,'pending',json(payload));
      this.db.prepare('insert into fm_outbox values(?,?,?,?,?,0)').run(this.projectId,`framework:${framework_id}:${revision}`,'pending',json({framework_id,revision}),null);
      return {framework_id,revision,status:'pending'};
    });
  }
  framework(frameworkId,revision) {return parse(this.db.prepare('select * from fm_frameworks where project_id=? and framework_id=? and revision=?').get(this.projectId,frameworkId,revision));}
  frameworkDir(frameworkId,revision) {return path.join(this.root,'exports','fact-memory',frameworkId,`r${revision}`);}
  exportPending({beforePublish}={}) {
    this.syncSources();
    const outcomes=[];
    for(const job of this.db.prepare("select * from fm_outbox where project_id=? and status='pending'").all(this.projectId)) {
      try {
        const {framework_id,revision}=JSON.parse(job.payload),f=this.framework(framework_id,revision);
        if(!f) throw safeError('framework_unavailable');
        const dir=this.frameworkDir(framework_id,revision);
        // No symlinked ancestor can redirect trusted writes outside the workspace.
        let ancestor=dir; while(!fs.existsSync(ancestor)) ancestor=path.dirname(ancestor);
        const real=fs.realpathSync(ancestor),root=fs.realpathSync(this.root);
        if(real!==root && !real.startsWith(root+path.sep)) throw safeError('export_outside_project');
        fs.mkdirSync(dir,{recursive:true});
        const write=(name,content)=>{
          const dest=path.join(dir,name);
          if(fs.existsSync(dest)) {if(fs.lstatSync(dest).isSymbolicLink() || hash(fs.readFileSync(dest,'utf8'))!==hash(content)) throw safeError('view_integrity_mismatch');return;}
          const temp=`${dest}.${randomUUID()}.tmp`;fs.writeFileSync(temp,content,{flag:'wx'});fs.renameSync(temp,dest);
        };
        write('analysis-state.json',json(f.state));write('report.md',f.report);
        beforePublish?.(f);
        this.tx(()=>{
          this.db.prepare("update fm_frameworks set status=case when status in ('stale','stale_pending') then 'stale' else 'published' end where project_id=? and framework_id=? and revision=?").run(this.projectId,framework_id,revision);
          this.db.prepare("update fm_outbox set status='done',error=null,attempts=attempts+1 where project_id=? and event_id=?").run(this.projectId,job.event_id);
        });
        outcomes.push({framework_id,revision,status:this.framework(framework_id,revision).status,path:path.relative(this.root,dir)});
      } catch(e) {
        this.db.prepare('update fm_outbox set error=?,attempts=attempts+1 where project_id=? and event_id=?').run(e.code || 'export_failed',this.projectId,job.event_id);
        outcomes.push({event_id:job.event_id,status:'pending',error:e.code || 'export_failed'});
      }
    }
    return outcomes;
  }
  published(frameworkId) {
    this.syncSources();
    const row=this.db.prepare("select * from fm_frameworks where project_id=? and framework_id=? and status in ('published','stale') order by revision desc limit 1").get(this.projectId,frameworkId);
    if(!row) return {status:'not_found'};
    const f=parse(row),dir=this.frameworkDir(frameworkId,f.revision);
    try {if(hash(fs.readFileSync(path.join(dir,'analysis-state.json'),'utf8'))!==f.state_hash || hash(fs.readFileSync(path.join(dir,'report.md'),'utf8'))!==f.report_hash) return {status:'view_integrity_mismatch',framework_id:frameworkId,revision:f.revision};}
    catch{return {status:'view_unavailable',framework_id:frameworkId,revision:f.revision};}
    return f;
  }
  health() {
    return {events:this.db.prepare('select status,count(*) as count from fm_events where project_id=? group by status').all(this.projectId),outbox:this.db.prepare('select status,count(*) as count from fm_outbox where project_id=? group by status').all(this.projectId)};
  }
}
