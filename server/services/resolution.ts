// Human decisions and investigation requests. Nothing here marks anything paid or edits invoice or PO values.
import type { z } from 'zod';
import { PROMPT_VERSION, type RecommendedAction, type ResolveRequest } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { audit, type Actor } from './audit.ts';
import { discrepancyDto, investigationDto, loadDiscrepancy, resolutionDto } from './records.ts';
import { fail, notFound } from './util.ts';
import { deriveInvoiceStatus, setInvoiceStatus } from './validation.ts';

type Ctx = { orgId: string; userId: string };
type Action = z.infer<typeof RecommendedAction>;

const CLOSED = ['resolved', 'dismissed'];
const AWAITING_SUPPLIER: Action[] = ['request_corrected_invoice', 'request_supplier_clarification', 'verify_po_amendment'];

/**
 * Where a decision moves the discrepancy:
 * approved + approve_review_completion -> resolved; approved + a supplier action -> awaiting_supplier;
 * approved + anything else, or more_info_requested -> investigating; rejected (the proposal) -> open.
 */
function nextStatus(r: z.infer<typeof ResolveRequest>): string {
  if (r.decision === 'approved') return r.approved_action === 'approve_review_completion' ? 'resolved' : AWAITING_SUPPLIER.includes(r.approved_action!) ? 'awaiting_supplier' : 'investigating';
  return r.decision === 'rejected' ? 'open' : 'investigating';
}

export async function resolveDiscrepancy(db: Db, ctx: Ctx, discrepancyId: string, req: z.infer<typeof ResolveRequest>) {
  const actor: Actor = { type: 'user', id: ctx.userId };
  const { invoice_id } = await loadDiscrepancy(db, ctx.orgId, discrepancyId);
  // Match validation's lock order so a correction and a resolution can safely run together.
  const [inv] = await db.query<{ status: any }>('select status from invoices where id = $1 and organization_id = $2 for update', [invoice_id, ctx.orgId]);
  const d = await loadDiscrepancy(db, ctx.orgId, discrepancyId, true);
  if (CLOSED.includes(d.status)) fail('conflict', `This discrepancy is already ${d.status}.`);
  let proposed: Action | null = null;
  if (req.investigation_id) {
    const [inv] = await db.query<{ recommended_action: Action | null }>(
      'select recommended_action from ai_investigations where id = $1 and discrepancy_id = $2 and organization_id = $3', [req.investigation_id, d.id, ctx.orgId]);
    if (!inv) notFound();
    proposed = inv.recommended_action;
  }
  const [row] = await db.query(
    `insert into resolution_actions (organization_id, discrepancy_id, investigation_id, proposed_action, approved_action, reviewer_id, approval_status, reviewer_notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [ctx.orgId, d.id, req.investigation_id ?? null, proposed, req.decision === 'approved' ? req.approved_action : null, ctx.userId, req.decision, req.notes]);
  await audit(db, { orgId: ctx.orgId, actor, event: 'resolution.recorded', targetType: 'resolution_action', targetId: row.id,
    next: { discrepancy_id: d.id, approval_status: req.decision, approved_action: row.approved_action, investigation_id: row.investigation_id } });

  const status = nextStatus(req);
  if (status !== d.status) {
    const [updated] = await db.query('update discrepancies set status = $1 where id = $2 and organization_id = $3 and status = $4 returning id', [status, d.id, ctx.orgId, d.status]);
    if (!updated) fail('conflict', 'This discrepancy changed while you were deciding. Reload and try again.');
    await audit(db, { orgId: ctx.orgId, actor, event: 'discrepancy.status_changed', targetType: 'discrepancy', targetId: d.id,
      previous: { status: d.status }, next: { status, discrepancy_id: d.id, resolution_action_id: row.id } });
  }

  let invoiceStatus = inv.status;
  if (!['superseded', 'rejected', 'uploaded'].includes(inv.status)) {
    invoiceStatus = await deriveInvoiceStatus(db, d.invoice_id);
    await setInvoiceStatus(db, ctx.orgId, actor, d.invoice_id, inv.status, invoiceStatus, { resolution_action_id: row.id });
  }
  return { resolution: resolutionDto(row), discrepancy: discrepancyDto({ ...d, status }), invoice_status: invoiceStatus };
}

/**
 * Creates a queued ai_investigations row for the discrepancy's current evidence, or returns the live one
 * (same evidence hash, prompt version and model). The caller enqueues the job when `created` is true.
 */
export async function requestInvestigation(db: Db, ctx: Ctx, discrepancyId: string, model: string) {
  const d = await loadDiscrepancy(db, ctx.orgId, discrepancyId);
  const [created] = await db.query(
    `insert into ai_investigations (organization_id, discrepancy_id, model_identifier, prompt_version, investigation_status, evidence_hash, evidence_references, requested_by)
     values ($1, $2, $3, $4, 'queued', $5, '[]'::jsonb, $6) on conflict do nothing returning *`,
    [ctx.orgId, d.id, model, PROMPT_VERSION, d.evidence_hash, ctx.userId]);
  if (created) {
    await audit(db, { orgId: ctx.orgId, actor: { type: 'user', id: ctx.userId }, event: 'investigation.requested', targetType: 'ai_investigation',
      targetId: created.id, next: { discrepancy_id: d.id, investigation_status: 'queued', model_identifier: model, prompt_version: PROMPT_VERSION } });
    return { investigation: investigationDto(created), created: true };
  }
  const [live] = await db.query(
    `select * from ai_investigations where discrepancy_id = $1 and evidence_hash = $2 and prompt_version = $3 and model_identifier = $4
       and investigation_status <> 'failed' and organization_id = $5`, [d.id, d.evidence_hash, PROMPT_VERSION, model, ctx.orgId]);
  return { investigation: investigationDto(live), created: false };
}

export async function getInvestigation(db: Db, orgId: string, id: string) {
  const [row] = await db.query('select * from ai_investigations where id = $1 and organization_id = $2', [id, orgId]);
  return row ? investigationDto(row) : notFound();
}
