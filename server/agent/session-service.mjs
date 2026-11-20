import { createFactMemoryTools, withFactCapture } from '../../lib/fact-memory/tools.mjs';
/**
 * Session lifecycle and persistence.
 *
 * One entry = one Pi session (or a deterministic fake session in tests). The
 * service owns streaming entries, session listing and the AG-UI adapter; route
 * handlers only parse HTTP input and call these methods.
 */

import { conditionValue, sourceObservations } from './source-observations.mjs';
import { digest } from './source-plan.mjs';
import { sourceModelOptions, readSourceLanguage, recordSourceModelCall } from './source-provider.mjs';
import {auditResearch} from "../../lib/research-audit.mjs";
import { guardResearchDelivery } from "../../lib/research-delivery.mjs";
import {createResearchReview} from "../../lib/research-review.mjs";
import fs from "node:fs";
import {readLedger} from "../../lib/ledger.mjs";
import {createLedgerTool} from "../../lib/ledger-tool.mjs";
import {createTranscriptSearchTool} from "../../lib/transcript-search-tool.mjs";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { recoverInterruptedTurns, cancelActiveTurn, turnTimeline } from "./turn-delivery.mjs";
import { runWithPostAnswer } from "./post-answer.mjs";
import { createFrameworkEditTool } from "./framework-edit.mjs";
import { PiAgUiAdapter } from "../../lib/agent-protocol/pi-ag-ui-adapter.mjs";
import { createFakeSession } from "./fake-agent.mjs";
import { attachSessionEvents } from "./event-bridge.mjs";
import {
  makeTitle,
  serializeSession,
  transcriptMessages,
  titleFromMessages,
  frameworkStatePath,
} from "./snapshot.mjs";
import { assessContextBudget, contextBudgetFailureStream, fitContextMessages } from "../../lib/context-budget.mjs";
import { systemHint } from "../project-context.mjs";

export function createSessionService({
  config,
  bus,
  projectManager,
  live,
  onMaterialSaved = () => {},
  onRunSettled = () => {},
}) {
  if (!config || !bus || !projectManager || !live) {
    throw new Error("createSessionService requires config, bus, projectManager and live");
  }

  function isProjectSkill(skill, ctx) {
    const file = path.resolve(skill.filePath);
    const roots = [
      path.join(ctx.root, ".agents", "skills"),
      path.join(ctx.root, ".pi", "skills"),
      path.join(config.agentDir, "skills"),
      config.skillsDir,
    ];
    return roots.some((root) => file === root || file.startsWith(root + path.sep));
  }

  function makeLoader(ctx) {
    return new DefaultResourceLoader({
      cwd: ctx.root,
      agentDir: config.agentDir,
      additionalSkillPaths: [config.skillsDir],
      appendSystemPromptOverride: (base) => [...base, systemHint(ctx, config)],
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => isProjectSkill(skill, ctx)),
        diagnostics: base.diagnostics,
      }),
    });
  }

  function blockOutsideProject(ctx, toolName, args) {
    if (!args || typeof args !== "object") return null;
    if (
      toolName === "bash"
      && typeof args.command === "string"
      && /(?:^|[/\s])model[/\\][^\s]+\.(?:xlsx|xlsm)|工作模型\.xlsx/i.test(args.command)
    ) {
      return { block: true, reason: "工作模型只能通过人工审批写入" };
    }
    const candidate = args.path;
    if (typeof candidate !== "string" || !candidate) return null;
    const root = path.resolve(ctx.root);
    const absolute = path.resolve(root, candidate);
    let realParent=absolute;
    while(!fs.existsSync(realParent) && realParent!==path.dirname(realParent)) realParent=path.dirname(realParent);
    const real=fs.realpathSync(realParent),realRoot=fs.realpathSync(root);
    const resolved=path.resolve(real,path.relative(realParent,absolute));
    const allowedSkill=["read","grep","find","ls"].includes(toolName) && absolute.startsWith(config.skillsDir+path.sep) && resolved.startsWith(fs.realpathSync(config.skillsDir)+path.sep);
    if (!allowedSkill && resolved!==realRoot && !resolved.startsWith(realRoot+path.sep)) return {block:true,reason:'路径不能通过符号链接离开当前项目'};
    const inside = absolute === root || absolute.startsWith(root + path.sep);
    if (inside) {
      const rel = path.relative(realRoot, resolved).split(path.sep).join("/");
      if (["write", "edit"].includes(toolName) && /^(?:\.pi\/(?:ledger|fact-memory|topics)(?:\/|$)|exports\/fact-memory(?:\/|$))/.test(rel)) {
        return {block:true,reason:"事实库、台账与已发布视图只能通过受控工具写入"};
      }
      // The prepared working model must only change through the approval path.
      // Blocking direct write/edit keeps a prompt-injected agent from bypassing
      // backup, recalculation and human review.
      if (
        ["write", "edit"].includes(toolName)
        && /(?:^|\/)model\/[^/]+\.(?:xlsx|xlsm)$/i.test(rel)
      ) {
        return { block: true, reason: "工作模型只能通过人工审批写入" };
      }
      return null;
    }
    if (["read", "grep", "find", "ls"].includes(toolName) && absolute.startsWith(config.skillsDir + path.sep)) {
      return null;
    }
    return { block: true, reason: `${toolName} 只能访问当前项目内的路径` };
  }

  /**
   * Optional per-session write scope: when `writeRoots` is provided, write/edit
   * may only target those project-relative prefixes. The watcher uses this to
   * stay read-only: it can write its result JSON under `.watch/` but never the
   * report, state file or model.
   */
  function blockOutsideWriteRoots(ctx, toolName, args, writeRoots) {
    if (!Array.isArray(writeRoots) || !writeRoots.length) return null;
    if (!["write", "edit"].includes(toolName)) return null;
    const candidate = args?.path;
    if (typeof candidate !== "string" || !candidate) {
      return { block: true, reason: "「盯」是只读的：写操作必须给出项目内路径" };
    }
    const root = path.resolve(ctx.root);
    const absolute = path.resolve(root, candidate);
    const rel = path.relative(root, absolute).split(path.sep).join("/");
    const allowed = writeRoots.some((scope) => {
      const prefix = String(scope || "").replace(/^\/+/, "").replace(/\/+$/, "");
      return prefix && (rel === prefix || rel.startsWith(`${prefix}/`));
    });
    if (allowed) return null;
    return { block: true, reason: `「盯」是只读的：只能写 ${writeRoots.join("、")} 下的结果文件` };
  }

  async function createEntry({ id, file, ctx, writeRoots = null, automated = false }) {
    if (!ctx) throw Object.assign(new Error("project not found"), { status: 404 });

    // Restore the persisted background boundary even through generic session routes.
    const restoredManager = !config.fakeAgent && file ? SessionManager.open(file, ctx.sessionsDir) : null;
    const restoredName = restoredManager?.getSessionName?.() || "";
    if (/^\[(计划|跟踪|盯)\]/.test(restoredName)) automated = true;
    if (/^\[盯\]/.test(restoredName) && !writeRoots) writeRoots = [".watch/"];
    const researchReview = createResearchReview({ctx,
      authorizeWrite: args => blockOutsideProject(ctx, "write", args) ?? blockOutsideWriteRoots(ctx, "write", args, writeRoots),
    });
    let session;
    let entry;
    let languageReader;
    const metadata=()=>({session_id:session?.sessionId || id || '',run_id:entry?.localRunId || '',turn:session?.messages?.filter(m=>m.role==='user'&&!m.peInternal&&!m.customType).length || 0,actor:automated||writeRoots?'automation':'agent'});
    const memoryTools=ctx.factMemory ? createFactMemoryTools({memory:ctx.factMemory,getMetadata:metadata}) : [];
    const sessionTools = automated || writeRoots ? memoryTools.filter(t=>t.name==='fact_query') : [
      ...memoryTools,
      createLedgerTool({ctx, getSessionId: () => session.sessionId,
        getTurn: () => session.messages.filter(m => m.role === "user" && !m.peInternal && !m.customType).length,
        broadcast: event => bus.broadcastGlobal(event, ctx.id),
        onChange: () => { if (entry) bus.broadcast(entry, entry.snapshot()); },
      }),
      createTranscriptSearchTool({getActive:()=>entry?.activeTurn,getMessages: () => transcriptMessages(session, ctx, { beforeTurnId: entry?.activeTurn?.turnId, legacyBoundary: entry?.transcriptBoundary }), getLedger: () => readLedger(ctx.root, session.sessionId)}),
    ];
    if (config.fakeAgent) {
      session = await createFakeSession({ id: id || undefined, ctx, config });
    } else {
      const sessionManager = file
        ? restoredManager
        : SessionManager.create(ctx.root, ctx.sessionsDir, id ? { id } : undefined);
      const loader = makeLoader(ctx);
      await loader.reload();
      const created = await createAgentSession({
        cwd: ctx.root,
        agentDir: config.agentDir,
        model: config.model,
        thinkingLevel: "off",
        sessionManager,
        resourceLoader: loader,
        tools: [...config.toolNames, "review_research", ...sessionTools.map(t => t.name)],
        customTools: ctx.tools
          .map(tool => withFactCapture(tool, ctx.factMemory, metadata))
          .concat(researchReview.tool, sessionTools, createFrameworkEditTool(ctx.root, () => entry?.activeTurn)),
      });
      session = created.session;
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = async (model, context, options) => {
        const active=entry?.activeTurn;
        const sourceMode=active?.plan && active.plan.route!=='ordinary';
        const research=active?.plan?.research || ['research-audit','research-report-audit','research-synthesis'].includes(options?.sourceStage);
        // Offer the tools this source operation can use before Pi normalizes
        // its system/tool updates; keep the full research request when needed.
        const businessStage=['answer','research-draft','research-repair'].includes(options?.sourceStage??'answer');
        const narrow=sourceMode && (!research || active.plan.sourceOnlyRead && businessStage) && !options?.sourceOperation;
        let input=context;
        if (narrow) {
          const allowed=new Set(active.plan.items.some(i=>i.action==='read') ?
            ['transcript_search','workbook_query','workbook_trace'] : ['transcript_search']);
          const tools=context.tools?.filter(t=>allowed.has(t.name));
          const messages=context.messages.map(m=>m.role==='system' && m.toolsAdded ?
            {...m,toolsAdded:m.toolsAdded.filter(t=>allowed.has(t.name))}:m);
          input={...context,tools,messages};
        }
        const transcript = normalizeContext(input);
        const messages = fitContextMessages(transcript.messages, model, undefined, options?.maxTokens);
        if (!assessContextBudget(messages, model, options?.maxTokens).ok) return contextBudgetFailureStream(model);
        const request = { messages };
        if (active && (options?.sourceOperation || active.plan && active.plan.route!=='ordinary')) {
          const bounded=sourceModelOptions(active,model,options,config.modelPayload);
          const result=await stream(model,request,bounded);
          recordSourceModelCall(session,active,result,context,options);
          return result;
        }
        if (!config.modelPayload) return stream(model, request, options);
        return stream(model, request, {
          ...options,
          onPayload: async (payload, requestModel) => {
            const transformed = await options?.onPayload?.(payload, requestModel);
            return config.modelPayload(transformed ?? payload, requestModel);
          },
        });
      };
      researchReview.restoreEvidence(session.messages);
      // Use the configured provider for review and repair requests as well as chat.
      const provider = session.agent.streamFunction;
      const recordAudit = record => {
        fs.appendFileSync(path.join(ctx.root, ".pi", "research-audit.jsonl"), JSON.stringify(record) + "\n");
      };
      session.agent.streamFunction = guardResearchDelivery(provider, {
        recordAudit,
        onReviewed(review) {
          const active=entry?.activeTurn;
          if (!active || active.plan?.route==='ordinary') return;
          const {text,...result}=review;
          active.reviewed={...result,digest:digest(text)};
          active.receipt?.('pe_source_research',active.reviewed);
        },
        getSessionMessages: () => session.messages,
        getContinuation: () => entry?.activeTurn?.continueResearchAnswer,
        audit: (source, model, context, options, draft) =>
          auditResearch(source, model, context, options, draft, { workbookEvidence: researchReview.evidenceSnapshot() }),
        onContext: (model, context, options) => {
          researchReview.restoreEvidence(context.messages);
          researchReview.setAuditor(async (content, extra) => {
            const verdict = await auditResearch(provider, model, context, {...options,sourceStage:'research-report-audit'}, content, {
              ...extra, workbookEvidence: researchReview.evidenceSnapshot(),
            });
            recordAudit({ ...verdict, kind: "report", at: new Date().toISOString() });
            return verdict;
          });
        },
      });
      const guardedStream=session.agent.streamFunction;
      languageReader=(operation,input,active)=>{
        // An embedding which replaces the business transport owns its model
        // boundary too. Do not reach out to an unrelated configured provider.
        if (session.agent.streamFunction!==guardedStream) return null;
        const model=session.model??config.model;
        if (!model || !config.allowedModels.has(model.id)) return null;
        return readSourceLanguage(provider,model,operation,input,active);
      };
    }

    session.agent.beforeToolCall = async ({ toolCall, args }) => {
      const logical=frameworkStatePath(ctx,args?.path);
      if (logical && ['edit','read'].includes(toolCall.name)) args={...args,path:logical};
      const outside = blockOutsideProject(ctx, toolCall.name, args);
      if (outside) return outside;
      const veto=blockOutsideWriteRoots(ctx, toolCall.name, args, writeRoots) ?? researchReview.before(toolCall.name, args);
      if (veto) return veto;
      if (entry?.activeTurn?.sourceSchema && !entry.activeTurn.admitted) return {block:true,reason:'回合请求范围尚未持久化'};
      const plan=entry?.activeTurn?.plan;
      const offered=entry?.activeTurn?.offeredSourceTools;
      if (offered && !offered.has(toolCall.name)) return {block:true,reason:`本次来源请求没有提供工具 ${toolCall.name}。请根据已登记事项及本轮工具结果回答。`};
      const read=plan?.items.find(i=>i.action==='read' && i.conditional);
      if (read && ['workbook_query','workbook_trace'].includes(toolCall.name)) {
        const observed=sourceObservations(plan,[],entry.turnToolCalls??[],ctx.store);
        if (conditionValue(read.predicate,observed.items)!==true) return {block:true,reason:'请求的读取条件尚未被历史检索证实。'};
      }
      return undefined;
    };

    const afterToolCall = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      // Shared skills may be read from outside the project. Their instructions
      // do not establish project evidence or an editable file baseline.
      const externalRead = context.toolCall.name === "read" && typeof context.args?.path === "string"
        && !path.resolve(ctx.root, context.args.path).startsWith(path.resolve(ctx.root) + path.sep);
      const logical=frameworkStatePath(ctx,context.args?.path);
      const reviewContext=logical && ['edit','read'].includes(context.toolCall.name) ?
        {...context,args:{...context.args,path:logical}} : context;
      const review = externalRead ? undefined : researchReview.record(reviewContext);
      if (!review) return afterToolCall?.(context, signal);
      const result = { ...context.result, ...review };
      const normalized = await afterToolCall?.({ ...context, result, isError: review.isError ?? context.isError }, signal);
      return { ...review, ...normalized };
    };

    if (!config.fakeAgent && config.model) {
      const currentId = session.model?.id;
      if (!currentId || !config.allowedModels.has(currentId)) {
        await session.setModel(config.model);
      }
    }

    entry = {
      id: session.sessionId,
      sessionTools,
      readSourceLanguage:languageReader,
      automated: Boolean(automated || writeRoots),
      session,
      ctx,
      clients: new Set(),
      toolArgs: new Map(),
      title: session.sessionName || titleFromMessages(session),
      modelId: session.model?.id || config.modelId,
      indexModel: config.indexModel,
      modelPayload: config.modelPayload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      unsubscribe: null,
      localRunId: null,
    };
    if (restoredManager && !entry.automated) recoverInterruptedTurns(entry);
    entry.snapshot = () => serializeSession(entry);
    attachSessionEvents(entry, { bus, onMaterialSaved, onRunSettled, onRunStarted: researchReview.startRun });
    entry.agui = new PiAgUiAdapter({
      session,
      threadId: entry.id,
      workspaceId: ctx.id,
      log: ctx.agentEvents,
      isBusy: () => Boolean(entry.postAnswerPending),
      ...(entry.automated ? {} : {
        promptRunner: (text, options) => runWithPostAnswer(entry, text, options, event => bus.broadcast(entry, event)),
        cancelTurn: () => cancelActiveTurn(entry),
      }),
    });
    entry.recoverProtocol = () => {
      for (const item of turnTimeline(session)) {
        if (item.kind === "delivery" && item.record.runId) entry.agui.recoverDelivery(item.record);
      }
    };
    entry.agui.attach();
    live.set(entry.id, entry);
    return entry;
  }

  const loading = new Map();

  async function ensureEntry(id, ctx = null, scope = {}) {
    const existing = live.get(id);
    if (existing) {
      if (ctx && existing.ctx.id !== ctx.id) return null;
      return existing;
    }
    if (config.fakeAgent) return null;
    const candidates = ctx ? [ctx] : projectManager.list();
    for (const candidate of candidates) {
      const file = SessionManager.findById(candidate.root, id, candidate.sessionsDir);
      if (file) {
        if (!loading.has(file)) {
          loading.set(file, createEntry({ id, file, ctx: candidate, ...scope }).finally(() => loading.delete(file)));
        }
        return loading.get(file);
      }
    }
    return null;
  }

  async function listSessions(ctx) {
    const infos = config.fakeAgent ? [] : await SessionManager.list(ctx.root, ctx.sessionsDir);
    const items = infos
      .filter((info) => !/^\[(计划|跟踪|盯)\]/.test(String(info.name || "")))
      .map((info) => ({
        id: info.id,
        title: info.name || makeTitle(info.firstMessage) || "未命名会话",
        messageCount: info.messageCount,
        updatedAt: info.modified.toISOString(),
      }));

    for (const entry of live.values()) {
      if (entry.ctx.id !== ctx.id) continue;
      if (/^\[(计划|跟踪|盯)\]/.test(String(entry.session.sessionName || entry.title || ""))) continue;
      const item = {
        id: entry.id,
        title: entry.session.sessionName || entry.title || "新会话",
        messageCount: entry.session.messages.length,
        updatedAt: entry.updatedAt,
      };
      const index = items.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) items[index] = item;
      else items.unshift(item);
    }
    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function close() {
    for (const entry of live.values()) {
      try {
        entry.unsubscribe?.();
        entry.agui?.detach();
        entry.session.dispose?.();
      } catch {
        /* ignored */
      }
    }
    live.clear();
  }

  return { createEntry, ensureEntry, listSessions, close };
}
