// Reads: DTOs for the GET routes and { data, evidence } results for the agent's tools. Every query is scoped to orgId;
// a row in another organisation is reported exactly like a missing one.
import type { EvidenceItem } from '../contracts/index.ts';
import { INVOICE_COLUMNS, invoiceFromRow, iso, isoOrNull, loadInvoice, loadPurchaseOrder, toCents, toMoney, type Db, type Invoice, type Line, type PurchaseOrder } from '../db/index.ts';
import { invoiceEvidence, lineText, poEvidence } from './matching.ts';
import type { Storage } from './storage.ts';
import { notFound } from './util.ts';
import { OPEN_STATUSES_SQL } from './validation.ts';

const clip = (s: string, n = 2000) => s.slice(0, n);

// ---------- DTOs ----------
const lineDto = (l: Line) => ({ id: l.id, line_number: l.line_number, sku: l.sku, description: l.description, quantity: l.qty_milli / 1000,
  unit_price: toMoney(l.unit_price)!, line_total: toMoney(l.line_total)!, tax_amount: toMoney(l.tax_amount) });

const EXTRAS = `(select count(*)::int from discrepancies d where d.invoice_id = i.id and d.status in ${OPEN_STATUSES_SQL}) as open_discrepancy_count,
  (select a.investigation_status from ai_investigations a join discrepancies d on d.id = a.discrepancy_id where d.invoice_id = i.id
   order by a.created_at desc limit 1) as investigation_status`;

function invoiceDto(inv: Invoice, extras: { open_discrepancy_count: number; investigation_status: string | null }, more: { lines?: boolean; document_url?: string } = {}) {
  return {
    id: inv.id, supplier_id: inv.supplier_id, supplier_name: inv.supplier_name_raw, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date,
    due_date: inv.due_date, po_reference: inv.po_reference, purchase_order_id: inv.purchase_order_id, currency: inv.currency,
    subtotal: toMoney(inv.subtotal), tax_amount: toMoney(inv.tax_amount), total_amount: toMoney(inv.total_amount), status: inv.status,
    extraction_confidence: inv.extraction_confidence, extraction: inv.extraction, supersedes_invoice_id: inv.supersedes_invoice_id,
    created_at: inv.created_at, updated_at: inv.updated_at, open_discrepancy_count: extras.open_discrepancy_count, investigation_status: extras.investigation_status,
    ...(more.lines ? { lines: inv.lines.map(lineDto) } : {}), ...(more.document_url ? { document_url: more.document_url } : {}),
  };
}
const poDto = (po: PurchaseOrder) => ({ id: po.id, supplier_id: po.supplier_id, supplier_name: po.supplier_name, purchase_order_number: po.purchase_order_number,
  currency: po.currency, tax_amount: toMoney(po.tax_amount)!, total_amount: toMoney(po.total_amount)!, status: po.status, created_at: po.created_at, lines: po.lines.map(lineDto) });
export const discrepancyDto = (r: any) => ({ id: r.id, invoice_id: r.invoice_id, purchase_order_id: r.purchase_order_id, discrepancy_type: r.discrepancy_type,
  severity: r.severity, expected_value: r.expected_value, observed_value: r.observed_value, difference_amount: toMoney(toCents(r.difference_amount)),
  status: r.status, deterministic_evidence: r.deterministic_evidence, created_at: iso(r.created_at) });
export const resolutionDto = (r: any) => ({ id: r.id, discrepancy_id: r.discrepancy_id, investigation_id: r.investigation_id, proposed_action: r.proposed_action,
  approved_action: r.approved_action, reviewer_id: r.reviewer_id, approval_status: r.approval_status, reviewer_notes: r.reviewer_notes, created_at: iso(r.created_at) });
const auditDto = (r: any) => ({ id: String(r.id), actor_type: r.actor_type, actor_id: r.actor_id, event_type: r.event_type, target_type: r.target_type,
  target_id: r.target_id, previous_state: r.previous_state, new_state: r.new_state, timestamp: iso(r.timestamp) });
export const investigationDto = (r: any) => ({ id: r.id, discrepancy_id: r.discrepancy_id, investigation_status: r.investigation_status, model_identifier: r.model_identifier,
  prompt_version: r.prompt_version, result: r.findings ?? null, error: r.error, usage: r.usage ?? null, retry_available: r.investigation_status === 'failed',
  created_at: iso(r.created_at), completed_at: isoOrNull(r.completed_at) });

export const DISCREPANCY_COLUMNS = `id, invoice_id, purchase_order_id, discrepancy_type, severity, expected_value, observed_value,
  difference_amount::text as difference_amount, status, deterministic_evidence, evidence_hash, created_at`;

// ---------- invoices ----------
export async function listInvoices(db: Db, orgId: string) {
  // ponytail: newest 200, no pagination yet.
  const rows = await db.query(`select ${INVOICE_COLUMNS}, ${EXTRAS} from invoices i where i.organization_id = $1 order by i.created_at desc, i.id limit 200`, [orgId]);
  return rows.map((r) => invoiceDto(invoiceFromRow(r), r as never));
}

export async function getInvoiceDto(db: Db, orgId: string, id: string, documentUrl?: (path: string) => Promise<string>) {
  const inv = (await loadInvoice(db, orgId, id)) ?? notFound();
  const [extras] = await db.query<{ open_discrepancy_count: number; investigation_status: string | null }>(`select ${EXTRAS} from invoices i where i.id = $1`, [id]);
  // Reviewers can edit their own rows through the Data API. Sign only this invoice's private object.
  const path = `${inv.organization_id}/${inv.id}/${inv.document_sha256}`;
  const document_url = documentUrl && /^[a-f0-9]{64}$/.test(inv.document_sha256) && inv.document_storage_path === path
    ? await documentUrl(path) : undefined;
  return invoiceDto(inv, extras, { lines: true, document_url });
}

/** Agent tool get_invoice. */
export async function getInvoice(db: Db, orgId: string, invoiceId: string) {
  const inv = (await loadInvoice(db, orgId, invoiceId)) ?? notFound();
  const [extras] = await db.query<{ open_discrepancy_count: number; investigation_status: string | null }>(`select ${EXTRAS} from invoices i where i.id = $1`, [inv.id]);
  return { data: invoiceDto(inv, extras, { lines: true }), evidence: invoiceEvidence(inv) };
}

// ---------- purchase orders and suppliers ----------
export async function listPurchaseOrders(db: Db, orgId: string) {
  const ids = await db.query<{ id: string }>('select id from purchase_orders where organization_id = $1 order by created_at desc, id limit 200', [orgId]);
  // ponytail: one query per PO (max 200); join-and-group if lists grow.
  return Promise.all(ids.map(async ({ id }) => poDto((await loadPurchaseOrder(db, orgId, id))!)));
}

/** Agent tool get_purchase_order. */
export async function getPurchaseOrder(db: Db, orgId: string, purchaseOrderId: string) {
  const po = (await loadPurchaseOrder(db, orgId, purchaseOrderId)) ?? notFound();
  return { data: poDto(po), evidence: poEvidence(po) };
}

/** Agent tool get_supplier. */
export async function getSupplier(db: Db, orgId: string, supplierId: string) {
  const [s] = await db.query('select id, supplier_name, normalized_name, tax_identifier, contact_information, created_at from suppliers where id = $1 and organization_id = $2', [supplierId, orgId]);
  if (!s) notFound();
  const data = { ...s, created_at: iso(s.created_at) };
  return { data, evidence: [{ id: `supplier:${s.id}`, label: `Supplier ${s.supplier_name}`.slice(0, 200), value: clip(`Name ${s.supplier_name}; tax identifier ${s.tax_identifier ?? 'none on file'}`) }] as EvidenceItem[] };
}

// ---------- discrepancies ----------
/** Agent tool get_discrepancies (and GET /api/invoices/:id/discrepancies via .data). */
export async function getDiscrepancies(db: Db, orgId: string, invoiceId: string) {
  const [inv] = await db.query('select id from invoices where id = $1 and organization_id = $2', [invoiceId, orgId]);
  if (!inv) notFound();
  const rows = (await db.query(`select ${DISCREPANCY_COLUMNS} from discrepancies where invoice_id = $1 and organization_id = $2 order by created_at, id`, [invoiceId, orgId])).map(discrepancyDto);
  const evidence: EvidenceItem[] = rows.map((d) => ({ id: `discrepancy:${d.id}`, label: `${d.discrepancy_type} (${d.severity}, ${d.status})`,
    value: clip(`Expected ${d.expected_value ?? 'n/a'}; observed ${d.observed_value ?? 'n/a'}; difference ${d.difference_amount ?? 'n/a'}`) }));
  return { data: rows, evidence };
}

export async function loadDiscrepancy(db: Db, orgId: string, id: string, lock = false) {
  const [d] = await db.query(`select ${DISCREPANCY_COLUMNS} from discrepancies where id = $1 and organization_id = $2${lock ? ' for update' : ''}`, [id, orgId]);
  return d ?? notFound();
}

/** GET /api/discrepancies/:id/history: human decisions plus every audit event about the discrepancy. */
export async function discrepancyHistory(db: Db, orgId: string, discrepancyId: string) {
  await loadDiscrepancy(db, orgId, discrepancyId);
  const resolutions = await db.query('select * from resolution_actions where discrepancy_id = $1 and organization_id = $2 order by created_at, id', [discrepancyId, orgId]);
  const events = await db.query(`select * from audit_events where organization_id = $1 and (target_id = $2 or new_state ->> 'discrepancy_id' = $2) order by id`, [orgId, discrepancyId]);
  return { resolutions: resolutions.map(resolutionDto), audit: events.map(auditDto) };
}

// ---------- document evidence and history for the agent ----------
const DOCUMENT_FIELDS = ['supplier_name', 'invoice_number', 'invoice_date', 'due_date', 'po_reference', 'currency', 'subtotal', 'tax_amount', 'total_amount', 'lines'] as const;

/**
 * Agent tool get_document_evidence. document_id is the invoice id (one document per invoice). Excerpts are the
 * extractor's copy of supplier-controlled text: untrusted data, never instructions.
 */
export async function getDocumentEvidence(db: Db, orgId: string, documentId: string, requestedFields: string[]) {
  const inv = (await loadInvoice(db, orgId, documentId)) ?? notFound();
  const ex = inv.extraction ?? {};
  const values: Record<string, string | null> = {
    supplier_name: inv.supplier_name_raw, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, due_date: inv.due_date,
    po_reference: inv.po_reference, currency: inv.currency, subtotal: toMoney(inv.subtotal), tax_amount: toMoney(inv.tax_amount),
    total_amount: toMoney(inv.total_amount), lines: inv.lines.map(lineText).join('\n') || null,
  };
  const fields: Record<string, unknown> = {}, unavailable: string[] = [], evidence: EvidenceItem[] = [];
  for (const f of [...new Set(requestedFields)]) {
    if (!(DOCUMENT_FIELDS as readonly string[]).includes(f)) { unavailable.push(f); continue; }
    const ref = ex.source_refs?.[f] ?? {}, confidence = ex.field_confidence?.[f] ?? null;
    fields[f] = { value: values[f], confidence, page: ref.page ?? null, excerpt: ref.excerpt ?? null };
    evidence.push({ id: `document:${inv.id}#${f}`, label: `Extracted ${f}`, ...(ref.page ? { page: ref.page } : {}),
      value: clip(`${values[f] ?? 'not extracted'}${confidence != null ? ` (confidence ${confidence})` : ''}${ref.excerpt ? `; source excerpt: ${JSON.stringify(ref.excerpt)}` : ''}`) });
  }
  return { data: { document_id: inv.id, method: ex.method ?? null, missing: ex.missing ?? [], uncertain: ex.uncertain ?? [], fields, unavailable }, evidence };
}

/** Agent tool get_resolution_history: decisions on one discrepancy, or the latest 50 for a supplier. */
export async function getResolutionHistory(db: Db, orgId: string, by: { discrepancy_id?: string; supplier_id?: string }) {
  let rows;
  if (by.discrepancy_id) {
    await loadDiscrepancy(db, orgId, by.discrepancy_id);
    rows = await db.query(`select r.*, d.discrepancy_type from resolution_actions r join discrepancies d on d.id = r.discrepancy_id
      where r.discrepancy_id = $1 and r.organization_id = $2 order by r.created_at, r.id`, [by.discrepancy_id, orgId]);
  } else {
    const [s] = await db.query('select id from suppliers where id = $1 and organization_id = $2', [by.supplier_id, orgId]);
    if (!s) notFound();
    rows = await db.query(`select r.*, d.discrepancy_type from resolution_actions r join discrepancies d on d.id = r.discrepancy_id
      join invoices i on i.id = d.invoice_id where i.supplier_id = $1 and r.organization_id = $2 order by r.created_at desc, r.id limit 50`, [by.supplier_id, orgId]);
  }
  return {
    data: rows.map((r) => ({ ...resolutionDto(r), discrepancy_type: r.discrepancy_type })),
    evidence: rows.map((r): EvidenceItem => ({ id: `resolution:${r.id}`, label: `${r.approval_status} on ${r.discrepancy_type}`,
      value: clip(`Approved action ${r.approved_action ?? 'none'}; notes: ${r.reviewer_notes || 'none'}`) })),
  };
}

