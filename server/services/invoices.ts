import { hasCreditTitle } from '../../dist/document-type.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { validateDocument } from '../../dist/matching-engine.js';
import { normalizeVendor } from '../../dist/supplier.js';
import { moneyToCents, UPLOAD_MAX_BYTES, type CreateInvoiceRequest, type CreatePurchaseOrderRequest, type ReviewInvoiceFieldsRequest } from '../contracts/index.ts';
import { loadInvoice, milliToString, toMilli, toMoney, type Db } from '../db/index.ts';
import { audit, type Actor } from './audit.ts';
import { engineDoc } from './matching.ts';
import type { Storage } from './storage.ts';
import { fail, notFound, sha256 } from './util.ts';
import { lineCents, processInvoice, setInvoiceStatus } from './validation.ts';

type Ctx = { orgId: string; userId: string };
const userActor = (c: Ctx): Actor => ({ type: 'user', id: c.userId });

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'application/pdf': (b) => ascii(b, 0, 5) === '%PDF-',
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'application/json': (b) => { const t = utf8(b); if (t === null) return false; try { JSON.parse(t); return true; } catch { return false; } },
  'text/plain': (b) => { const t = utf8(b); return t !== null && !t.includes('\0'); },
};
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const utf8 = (b: Uint8Array) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; } };

/** Decodes the upload and checks it against its declared size, SHA-256 and MIME type (by magic bytes). */
export function checkUpload(file: z.infer<typeof CreateInvoiceRequest>['file']): Uint8Array {
  if (file.content_base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content_base64)) fail('invalid_request', 'File content is not valid base64');
  const bytes = new Uint8Array(Buffer.from(file.content_base64, 'base64'));
  if (bytes.length !== file.size_bytes || bytes.length > UPLOAD_MAX_BYTES) fail('invalid_request', 'File size does not match size_bytes');
  if (sha256(bytes) !== file.sha256) fail('invalid_request', 'File SHA-256 does not match');
  if (!MAGIC[file.mime_type](bytes)) fail('invalid_request', 'File content does not match its declared type');
  return bytes;
}

const lineRow = (l: { quantity: number; unit_price: string; line_total: string | null }) => {
  const qty = toMilli(l.quantity.toFixed(3)), unit = moneyToCents(l.unit_price);
  return { qty, unit, total: l.line_total == null ? lineCents(qty, unit) : moneyToCents(l.line_total) };
};

/**
 * Stores the document and extracted fields, then validates. With supersedes_invoice_id the original becomes
 * `superseded` (kept, never edited otherwise) and the new invoice is validated from scratch.
 */
export async function createInvoice(db: Db, ctx: Ctx, req: z.infer<typeof CreateInvoiceRequest>, storage: Storage): Promise<string> {
  const bytes = checkUpload(req.file);
  const actor = userActor(ctx), id = randomUUID(), x = req.extracted;
  const plainText = req.file.mime_type === 'text/plain' ? utf8(bytes) : x.source_text;
  const jsonCredit = req.file.mime_type === 'application/json' && JSON.parse(utf8(bytes)!)?.type === 'credit_note';
  if (jsonCredit || hasCreditTitle(plainText)) fail('invalid_request', 'Credit notes are not supported for invoice processing.');
  if (req.supersedes_invoice_id) {
    const [orig] = await db.query<{ status: any; archived_at: Date | null }>('select status, archived_at from invoices where id = $1 and organization_id = $2 for update', [req.supersedes_invoice_id, ctx.orgId]);
    if (!orig) notFound();
    if (orig.archived_at) fail('conflict', 'Restore this invoice before uploading a correction.');
    if (orig.status === 'superseded') fail('conflict', 'That invoice has already been superseded.');
    await setInvoiceStatus(db, ctx.orgId, actor, req.supersedes_invoice_id, orig.status, 'superseded', { superseded_by: id });
  }
  const path = `${ctx.orgId}/${id}/${req.file.sha256}`;
  await db.query(
    `insert into invoices (id, organization_id, supplier_name_raw, invoice_number, invoice_date, due_date, po_reference, currency, subtotal, tax_amount,
       total_amount, status, document_storage_path, document_sha256, source_text, extraction_confidence, extraction, supersedes_invoice_id, created_by)
     values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9::numeric, $10::numeric, $11::numeric, 'uploaded', $12, $13, $14, $15, $16::jsonb, $17, $18)`,
    [id, ctx.orgId, x.supplier_name, x.invoice_number, x.invoice_date, x.due_date, x.po_reference, x.currency, x.subtotal, x.tax_amount, x.total_amount,
      path, req.file.sha256, x.source_text, x.extraction.confidence, JSON.stringify(x.extraction), req.supersedes_invoice_id ?? null, ctx.userId]);
  for (const [n, l] of x.lines.entries()) {
    const r = lineRow(l);
    await db.query(
      `insert into invoice_line_items (invoice_id, line_number, sku, description, quantity, unit_price, line_total, tax_amount)
       values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric)`,
      [id, n + 1, l.sku || null, l.description, milliToString(r.qty), toMoney(r.unit), toMoney(r.total), l.tax_amount]);
  }
  await audit(db, { orgId: ctx.orgId, actor, event: 'invoice.created', targetType: 'invoice', targetId: id,
    next: { status: 'uploaded', document_sha256: req.file.sha256, mime_type: req.file.mime_type, supersedes_invoice_id: req.supersedes_invoice_id ?? null } });
  await storage.put(path, bytes, req.file.mime_type); // inside the transaction: a storage failure rolls the invoice back
  await processInvoice(db, ctx.orgId, id, actor);
  return id;
}

/** Review an existing extraction against its original document, with the prior values in the audit trail. */
export async function reviewInvoiceFields(db: Db, ctx: Ctx, id: string, req: z.infer<typeof ReviewInvoiceFieldsRequest>) {
  const inv = await loadInvoice(db, ctx.orgId, id, true) ?? notFound();
  if (inv.archived_at) fail('conflict', 'Restore this invoice before editing its fields.');
  if (inv.updated_at !== req.updated_at) fail('conflict', 'This invoice changed. Reload it before saving your review.');
  if (['rejected', 'superseded'].includes(inv.status)) fail('conflict', 'This invoice is closed to field review.');
  const previous = { supplier_name: inv.supplier_name_raw, currency: inv.currency, po_reference: inv.po_reference };
  const values = { ...previous, ...req.values };
  const fields = Object.keys(req.values) as (keyof typeof previous)[];
  const extraction = { ...inv.extraction };
  const confirmed = new Set<string>(extraction.reviewed_fields ?? []);
  const missing = new Set<string>(extraction.missing ?? []);
  extraction.field_confidence = { ...extraction.field_confidence };
  extraction.support_labels = { ...extraction.support_labels };
  for (const field of fields) {
    const value = values[field];
    if (value == null) {
      confirmed.delete(field);
      missing.add(field);
    } else {
      confirmed.add(field);
      missing.delete(field);
    }
    if (value !== previous[field]) delete extraction.field_confidence[field];
    const path = { supplier_name: 'vendor', currency: 'currency', po_reference: 'poNumber' }[field];
    extraction.support_labels[path] = { ...extraction.support_labels[path], reviewedValue: value, confirmed: value != null, needsConfirmation: value == null };
  }
  extraction.reviewed_fields = [...confirmed];
  extraction.missing = [...missing];
  extraction.uncertain = (extraction.uncertain ?? []).filter((field: string) => !fields.some(f => field === f));
  const actor = userActor(ctx);
  await db.query('update invoices set supplier_name_raw = $1, currency = $2, po_reference = $3, extraction = $4::jsonb where id = $5 and organization_id = $6',
    [values.supplier_name, values.currency, values.po_reference, JSON.stringify(extraction), id, ctx.orgId]);
  await audit(db, { orgId: ctx.orgId, actor, event: 'invoice.fields_reviewed', targetType: 'invoice', targetId: id,
    previous: { values: previous }, next: { values, reviewed_fields: fields } });
  await processInvoice(db, ctx.orgId, id, actor);
}

/** Keep the extracted PO reference and retain a durable exclusion for this pair. */
export async function unlinkPurchaseOrder(db: Db, ctx: Ctx, id: string, purchaseOrderId: string) {
  const inv = await loadInvoice(db, ctx.orgId, id, true) ?? notFound();
  if (inv.archived_at || inv.purchase_order_id !== purchaseOrderId || ['rejected', 'superseded'].includes(inv.status)) {
    fail('conflict', 'The invoice or its linked purchase order changed. Reopen the invoice to review it.');
  }
  await db.query('select sorikano_private.unlink_invoice_purchase_order($1, $2, $3)', [ctx.orgId, id, purchaseOrderId]);
  await processInvoice(db, ctx.orgId, id, userActor(ctx));
}

/** Archive state is audited by the database. Restoring an active workflow rechecks current findings. */
export async function setInvoiceArchived(db: Db, ctx: Ctx, id: string, archived: boolean) {
  const inv = await loadInvoice(db, ctx.orgId, id, true) ?? notFound();
  if (Boolean(inv.archived_at) === archived) return [];
  await db.query('update invoices set archived_at = case when $3 then now() else null end where id = $1 and organization_id = $2', [id, ctx.orgId, archived]);
  if (!archived) {
    if (!['rejected', 'superseded'].includes(inv.status)) await processInvoice(db, ctx.orgId, id, userActor(ctx));
    return [];
  }
  // Recheck other active invoices whose open duplicate finding referenced this invoice.
  const affected = await db.query<{ id: string }>(
    `select distinct i.id from invoices i join discrepancies d on d.invoice_id = i.id and d.organization_id = i.organization_id
     where i.organization_id = $1 and i.archived_at is null and i.status not in ('rejected', 'superseded')
       and d.discrepancy_type = 'duplicate_candidate' and d.status in ('open', 'investigating', 'awaiting_supplier')
       and d.deterministic_evidence ->> 'other_invoice_id' = $2`, [ctx.orgId, id]);
  return affected.map(row => row.id);
}

/** Creates a PO the engine accepts (currency code, whole quantities, lines + tax = total) and its supplier if new. Returns invoices waiting on it. */
export async function createPurchaseOrder(db: Db, ctx: Ctx, req: z.infer<typeof CreatePurchaseOrderRequest>) {
  const lines = req.lines.map((l) => ({ ...l, ...lineRow(l) }));
  const tax = moneyToCents(req.tax_amount), total = moneyToCents(req.total_amount);
  try {
    validateDocument(engineDoc('purchase_order', { number: req.purchase_order_number, vendor: req.supplier_name, poNumber: req.purchase_order_number,
      currency: req.currency, lines: lines.map((l) => ({ sku: l.sku, description: l.description, qty_milli: l.qty, unit_price: l.unit })), tax, total }), 'purchase_order');
  } catch (e: any) { fail('invalid_request', String(e?.message)); }
  if(lines.reduce((sum,l)=>sum+l.total,0)+tax!==total)fail('invalid_request','Purchase-order line amounts + tax must equal total.');
  const bad = lines.findIndex((l) => l.total !== lineCents(l.qty, l.unit));
  if (bad >= 0) fail('invalid_request', `Line ${bad + 1}: line_total does not equal quantity × unit_price`);
  const normalized = normalizeVendor(req.supplier_name);
  if (!normalized) fail('invalid_request', 'Supplier name has no usable characters');

  const actor = userActor(ctx);
  let [supplier] = await db.query<{ id: string }>(
    'insert into suppliers (organization_id, supplier_name, normalized_name) values ($1, $2, $3) on conflict do nothing returning id', [ctx.orgId, req.supplier_name, normalized]);
  if (supplier) await audit(db, { orgId: ctx.orgId, actor, event: 'supplier.created', targetType: 'supplier', targetId: supplier.id, next: { supplier_name: req.supplier_name } });
  else [supplier] = await db.query('select id from suppliers where organization_id = $1 and normalized_name = $2', [ctx.orgId, normalized]);

  const [dup] = await db.query('select 1 from purchase_orders where organization_id = $1 and lower(trim(purchase_order_number)) = lower(trim($2))', [ctx.orgId, req.purchase_order_number]);
  if (dup) fail('conflict', 'A purchase order with that number already exists.');
  const [po] = await db.query<{ id: string }>(
    `insert into purchase_orders (organization_id, supplier_id, purchase_order_number, currency, tax_amount, total_amount, status)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, 'open') returning id`, [ctx.orgId, supplier.id, req.purchase_order_number, req.currency, req.tax_amount, req.total_amount]);
  for (const [n, l] of lines.entries()) {
    await db.query(`insert into purchase_order_line_items (purchase_order_id, line_number, sku, description, quantity, unit_price, line_total)
      values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric)`, [po.id, n + 1, l.sku, l.description, milliToString(l.qty), toMoney(l.unit), toMoney(l.total)]);
  }
  await audit(db, { orgId: ctx.orgId, actor, event: 'purchase_order.created', targetType: 'purchase_order', targetId: po.id,
    next: { purchase_order_number: req.purchase_order_number, total_amount: req.total_amount } });
  const waiting = await db.query<{ id: string }>(
    `select id from invoices where organization_id = $1 and archived_at is null and purchase_order_id is null and lower(trim(po_reference)) = lower(trim($2))
       and status in ('uploaded', 'needs_extraction_review', 'validated', 'exception', 'resolved')`, [ctx.orgId, req.purchase_order_number]);
  return { purchaseOrderId: po.id, waitingInvoiceIds: waiting.map((w) => w.id) };
}
