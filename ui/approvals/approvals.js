/** Pending model-write approvals: shelf rendering and decisions. */

import { api } from "../api/client.js";
import { getState, state, selectors } from "../state/store.js";
import { approvalCardHTML, errorCardHTML } from "../tool-renderers/registry.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function artifactRevisionCardHTML(approval) {
  const p = approval.payload;
  if (!p?.artifact?.path || !Array.isArray(p.corrections)) return errorCardHTML('产物更正提案数据不完整');
  const status = approval.status;
  const label = {pending_approval:'待审批',applied:'已并入',rejected:'已拒绝',conflict:'冲突',failed:'失败',applying:'应用中'}[status] || status;
  return `<div class="tool-result-card approval-card" data-approval-id="${esc(approval.id)}">
    <div class="tc-head"><span class="tc-title">产物更正审批</span><span class="tc-meta ap-status">${esc(label)}</span></div>
    <div class="ap-model">${esc(p.artifact.path)}</div>
    <ul class="ap-changes">${p.corrections.map(c => `<li><span class="ap-metric">${esc(c.claim)}</span><span class="ap-from">${esc(c.from)}</span><span class="ap-arrow">→</span><span class="ap-to">${esc(c.to)}</span></li>`).join('')}</ul>
    ${approval.decision?.reason ? `<div class="ap-decision">${esc(approval.decision.reason)}</div>` : ''}
    ${status === 'pending_approval' ? `<div class="ap-actions"><button type="button" class="ap-btn primary" data-approval-action="approve" data-approval-id="${esc(approval.id)}">批准并入</button><button type="button" class="ap-btn" data-approval-action="reject" data-approval-id="${esc(approval.id)}">拒绝</button></div>` : ''}
  </div>`;
}

export function pendingApprovals() {
  return selectors.pendingApprovals();
}

export function approvalsShelfHTML() {
  const pending = pendingApprovals();
  // Recently rejected/conflicted rows stay visible after a refresh so the
  // outcome is auditable. Applied rows are intentionally dropped.
  const decided = (state.approvals || [])
    .filter((item) => ["rejected", "conflict", "failed"].includes(item.status))
    .slice(0, 5);
  const items = [...pending, ...decided];
  if (!items.length) return "";
  return `<div class="approvals-shelf" aria-label="变更审批">
    <div class="approvals-shelf-head"><strong>${pending.length ? "待审批" : "审批结果"}</strong>
      <span>${pending.length ? `${pending.length} 个变更请求` : "最近已处理的请求"}</span></div>
    ${items.map((approval) => {
      try {
        return approval.kind === "artifact_revision" ? artifactRevisionCardHTML(approval) : approvalCardHTML(approval.payload || {}, { approval });
      } catch {
        return errorCardHTML("审批数据损坏，无法展示", { title: "审批数据损坏" });
      }
    }).join("")}
  </div>`;
}

export async function loadApprovals() {
  const projectId = getState().project?.id;
  try {
    const items = await api("/api/approvals");
    if (getState().project?.id !== projectId) return; // project switched mid-flight
    state.approvals = Array.isArray(items) ? items : [];
    runtime.renderThread?.(false);
  } catch {
    /* the shelf is optional */
  }
}

export async function decideApproval(id, action, reason = "") {
  if (!id) return;
  const projectId = getState().project?.id;
  const card = document.querySelector(`[data-approval-id="${CSS.escape(id)}"]`);
  card?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: action === "reject" ? { reason } : {},
    });
    if (getState().project?.id !== projectId) return;
    if (result.approval) {
      const index = state.approvals.findIndex((item) => item.id === result.approval.id);
      if (index >= 0) state.approvals[index] = result.approval;
      else state.approvals.unshift(result.approval);
    }
    if (result.tracking) window.Tracking?.upsert?.(result.tracking);
    if (result.material) runtime.upsertMaterial?.(result.material);
    await loadApprovals();
    await runtime.refreshSnapshot?.();
    toast(action === "approve"
      ? (result.pending ? "这个审批正在应用中" : result.already ? "这个审批已经应用过了" : result.approval?.kind === "artifact_revision" ? "已批准，更正已并入" : "已批准，模型已重算并写回")
      : (result.error || "已拒绝，文件未修改"));
  } catch (error) {
    toast(error.message || "审批失败");
    await loadApprovals();
  }
}

export function upsertApproval(approval) {
  if (!approval) return;
  const index = state.approvals.findIndex((item) => item.id === approval.id);
  if (index >= 0) state.approvals[index] = approval;
  else state.approvals.unshift(approval);
}
