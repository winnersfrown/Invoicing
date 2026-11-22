// The one adapter from database rows to the engine's document shape, plus the comparison wrapper.
import { compareDocuments, correctionDraft } from '../../dist/matching-engine.js';
import { supplierEvidence } from '../../dist/supplier.js';
import type { EvidenceItem } from '../contracts/index.ts';
import { loadInvoice, loadPurchaseOrder, toMoney, type Db, type Invoice, type Line, type PurchaseOrder } from '../db/index.ts';
import { audit, type Actor } from './audit.ts';
import { fail, notFound } from './util.ts';

type Side = { number: string | null; vendor: string | null; poNumber: string | null; currency: string | null; lines: Pick<Line, 'sku' | 'description' | 'qty_milli' | 'unit_price'>[]; tax: number | null; total: number | null };

/** Integer cents and thousandths in, the engine's dollar-number document out. Missing values stay null so the engine rejects them. */
export function engineDoc(type: 'invoice' | 'purchase_order', d: Side) {
  return {
    type, number: d.number, vendor: d.vendor, poNumber: d.poNumber, currency: d.currency,
    lines: d.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.qty_milli / 1000, unitPrice: l.unit_price / 100 })),
    tax: d.tax == null ? null : d.tax / 100, total: d.total == null ? null : d.total / 100,
  };
}
export const invoicePricingCurrency = (inv: Invoice): string | null => {
  const reviewed: unknown = inv.extraction?.support_labels?.pricingCurrency?.reviewedValue;
  return typeof reviewed === 'string' && /^[A-Z]{3}$/i.test(reviewed) ? reviewed.toUpperCase() : inv.currency?.toUpperCase() ?? null;
};

export const invoiceDoc = (inv: Invoice) => ({ ...engineDoc('invoice', { number: inv.invoice_number, vendor: inv.supplier_name_raw, poNumber: inv.po_reference,
  currency: inv.currency, lines: inv.lines, tax: inv.tax_amount, total: inv.total_amount }), pricingCurrency: invoicePricingCurrency(inv) });
export const poDoc = (po: PurchaseOrder) => engineDoc('purchase_order', { number: po.purchase_order_number, vendor: po.supplier_name,
  poNumber: po.purchase_order_number, currency: po.currency, lines: po.lines, tax: po.tax_amount, total: po.total_amount });

export type Comparison = ReturnType<typeof compareDocuments>;
export type SupplierCheck = { ok: true; evidence: string } | { ok: false; review: boolean; error: string };

/**
 * Supplier identity is checked on its own so a spelling variant (SUPPLIER_REVIEW) still gets a line comparison.
 * A hard supplier mismatch skips the comparison. Engine errors are returned, never thrown.
 */
export function compareWithPo(inv: Invoice, po: PurchaseOrder): { supplier: SupplierCheck; comparison: Comparison | null; error: string | null } {
  const i = invoiceDoc(inv), p = poDoc(po);
  let supplier: SupplierCheck;
  if (!inv.supplier_name_raw) supplier = { ok: false, review: false, error: 'Invoice supplier name is missing.' };
  else {
    try { supplier = { ok: true, evidence: supplierEvidence(i, p) }; } catch (e: any) { supplier = { ok: false, review: e?.code === 'SUPPLIER_REVIEW', error: String(e?.message) }; }
  }
  if (!supplier.ok && !supplier.review) return { supplier, comparison: null, error: null };
  try {
    return { supplier, comparison: compareDocuments(supplier.ok ? i : { ...i, vendor: p.vendor }, p, { allowMissingInvoiceAmounts: true }), error: null };
  } catch (e: any) {
    return { supplier, comparison: null, error: String(e?.message) };
  }
}

export const qtyText = (milli: number) => String(milli / 1000);
export const lineText = (l: Line) => `${l.sku ?? 'no SKU'} ${l.description}: ${qtyText(l.qty_milli)} × ${toMoney(l.unit_price)} = ${toMoney(l.line_total)}`;
const clip = (s: string) => s.slice(0, 2000);

export const invoiceEvidence = (inv: Invoice): EvidenceItem[] => [
  { id: `invoice:${inv.id}`, label: `Invoice ${inv.invoice_number ?? '(no number)'}`.slice(0, 200),
    value: clip(`Pricing currency ${invoicePricingCurrency(inv) ?? 'unknown'}; supplier ${inv.supplier_name_raw ?? 'unknown'}; PO reference ${inv.po_reference ?? 'none'}; subtotal ${toMoney(inv.subtotal) ?? 'missing'}; tax ${toMoney(inv.tax_amount) ?? 'missing'}; total ${toMoney(inv.total_amount) ?? 'missing'} ${inv.currency ?? ''}; status ${inv.status}`) },
  ...inv.lines.map((l) => ({ id: `invoice_line:${l.id}`, label: `Invoice line ${l.line_number}`, value: clip(lineText(l)) })),
];
export const poEvidence = (po: PurchaseOrder): EvidenceItem[] => [
  { id: `po:${po.id}`, label: `Purchase order ${po.purchase_order_number}`.slice(0, 200),
    value: clip(`Supplier ${po.supplier_name}; tax ${toMoney(po.tax_amount)}; total ${toMoney(po.total_amount)} ${po.currency}; status ${po.status}`) },
  ...po.lines.map((l) => ({ id: `po_line:${l.id}`, label: `PO line ${l.line_number}`, value: clip(lineText(l)) })),
];

/** Agent tool compare_invoice_to_po: the engine result (cents) plus evidence for both documents. */
export async function compareInvoiceToPo(db: Db, orgId: string, invoiceId: string, purchaseOrderId: string) {
  const inv = (await loadInvoice(db, orgId, invoiceId)) ?? notFound();
  const po = (await loadPurchaseOrder(db, orgId, purchaseOrderId)) ?? notFound();
  const result = compareWithPo(inv, po);
  return { data: { invoice_id: inv.id, purchase_order_id: po.id, ...result }, evidence: [...invoiceEvidence(inv), ...poEvidence(po)] };
}

/** Stores (never sends) a supplier message built by the engine's correctionDraft. */
export async function draftSupplierMessage(db: Db, orgId: string, discrepancyId: string, o: { actor: Actor; createdBy: string; requestedCorrection?: string; evidenceReferences?: string[] }) {
  const [d] = await db.query<{ id: string; invoice_id: string; purchase_order_id: string | null }>(
    'select id, invoice_id, purchase_order_id from discrepancies where id = $1 and organization_id = $2', [discrepancyId, orgId]);
  if (!d) notFound();
  const inv = (await loadInvoice(db, orgId, d.invoice_id))!;
  const poId = d.purchase_order_id ?? inv.purchase_order_id;
  const po = poId ? await loadPurchaseOrder(db, orgId, poId) : null;
  if (!po) fail('conflict', 'This discrepancy has no purchase order to compare against, so there is nothing to draft.');
  const { comparison } = compareWithPo(inv, po!);
  if (!comparison?.hasDiscrepancy) fail('conflict', 'The engine found no purchase-order differences to raise with the supplier.');
  const [org] = await db.query<{ name: string }>('select name from organizations where id = $1', [orgId]);
  let body: string = correctionDraft(invoiceDoc(inv), poDoc(po!), comparison!).replace('Thank you,\nOak & Elm Creative', () => `Thank you,\n${org.name}`);
  if (o.requestedCorrection) body = body.replace('\n\nThank you,', () => `\n\nRequested correction: ${o.requestedCorrection}\n\nThank you,`);
  const changed = comparison!.lines.filter((l) => l.changed);
  const refs = [...new Set([`discrepancy:${d.id}`, `invoice:${inv.id}`, `po:${po!.id}`,
    ...changed.flatMap((l) => [l.invoiceLine && `invoice_line:${inv.lines[l.invoiceLine - 1].id}`, l.poLine && `po_line:${po!.lines[l.poLine - 1].id}`]),
    ...(o.evidenceReferences ?? [])].filter((x): x is string => !!x))];
  const [row] = await db.query<{ id: string; created_at: Date }>(
    `insert into supplier_message_drafts (organization_id, discrepancy_id, body, evidence_references, created_by) values ($1, $2, $3, $4::jsonb, $5) returning id, created_at`,
    [orgId, d.id, body, JSON.stringify(refs), o.createdBy]);
  await audit(db, { orgId, actor: o.actor, event: 'supplier_message.drafted', targetType: 'supplier_message_draft', targetId: row.id, next: { discrepancy_id: d.id, sent: false } });
  return { id: row.id, discrepancy_id: d.id, body, evidence_references: refs, sent: false as const, created_at: new Date(row.created_at).toISOString() };
}
