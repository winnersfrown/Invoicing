// Deterministic checks for one invoice. Amounts compared against a PO come from the matching engine;
// the internal arithmetic the engine does not cover (line totals, subtotal, line tax) is integer cents here.
import { normalizeVendor, similarSupplier } from '../../dist/supplier.js';
import type { DiscrepancyType, InvoiceStatus, Severity } from '../contracts/index.ts';
import { loadInvoice, loadPurchaseOrder, toMoney, type Db, type Invoice, type PurchaseOrder } from '../db/index.ts';
import type { z } from 'zod';
import { audit, type Actor } from './audit.ts';
import { duplicateCandidates } from './duplicates.ts';
import { compareWithPo, lineText, qtyText } from './matching.ts';
import { canonical, fail, notFound, sha256 } from './util.ts';

type DType = z.infer<typeof DiscrepancyType>;
type Status = z.infer<typeof InvoiceStatus>;
export type Finding = {
  type: DType; severity?: z.infer<typeof Severity>; fields: string[]; expected: string | null; observed: string | null;
  difference: number | null; evidence: Record<string, unknown>; poId?: string | null;
};

const SUPPORTED_CURRENCY = 'USD';
const LOW_CONFIDENCE = 0.7;
export const OPEN_STATUSES_SQL = `('open', 'investigating', 'awaiting_supplier')`;
const PROCESSABLE: Status[] = ['uploaded', 'needs_extraction_review', 'validated', 'exception'];
const SEVERITY: Record<DType, Finding['severity']> = {
  duplicate_candidate: 'high', incorrect_total: 'high', line_arithmetic: 'medium', tax_mismatch: 'medium', unit_price_mismatch: 'high',
  quantity_mismatch: 'medium', unmatched_line: 'medium', supplier_mismatch: 'high', missing_purchase_order: 'medium', currency_mismatch: 'high',
  ambiguous_reference: 'medium', potential_extraction_error: 'medium',
};
// Findings that already explain why the engine refused to compare.
const EXPLAINS_ENGINE_ERROR = new Set<DType>(['incorrect_total', 'line_arithmetic', 'currency_mismatch', 'potential_extraction_error']);

/** quantity (thousandths) × unit price (cents), rounded half away from zero, without floating point. */
export function lineCents(qtyMilli: number, unitCents: number): number {
  const p = BigInt(qtyMilli) * BigInt(unitCents);
  const r = ((p < 0n ? -p : p) + 500n) / 1000n;
  return Number(p < 0n ? -r : r);
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export type CheckInput = {
  inv: Invoice; po: PurchaseOrder | null; poMatches: { id: string; purchase_order_number: string }[];
  supplierOnFile: boolean; similarSupplierName: string | null;
  duplicates: Awaited<ReturnType<typeof duplicateCandidates>>;
};

/** Pure: every discrepancy the deterministic checks find for this invoice. */
export function findDiscrepancies({ inv, po, poMatches, supplierOnFile, similarSupplierName, duplicates }: CheckInput): Finding[] {
  const out: Finding[] = [];
  const poId = po?.id ?? null;
  const ex = inv.extraction ?? {};

  // Extraction: required fields that are missing, and fields the extractor was unsure about.
  const required: Record<string, unknown> = { supplier_name: inv.supplier_name_raw, invoice_number: inv.invoice_number, currency: inv.currency, total_amount: inv.total_amount, lines: inv.lines.length || null };
  const missing = [...new Set([...Object.keys(required).filter((k) => required[k] == null), ...(ex.missing ?? [])])].sort();
  const lowConfidence = Object.entries((ex.field_confidence ?? {}) as Record<string, number>).filter(([, c]) => c < LOW_CONFIDENCE).map(([k]) => k);
  const uncertain = [...new Set([...(ex.uncertain ?? []), ...lowConfidence])].filter((f) => !missing.includes(f)).sort();
  const unsure = [...missing, ...uncertain];
  if (unsure.length) {
    out.push({ type: 'potential_extraction_error', fields: [], expected: 'All required fields read with confidence',
      observed: [missing.length ? `missing: ${missing.join(', ')}` : '', uncertain.length ? `uncertain: ${uncertain.join(', ')}` : ''].filter(Boolean).join('; '),
      difference: null, evidence: { check: 'extraction', missing, uncertain, method: ex.method ?? null } });
  }

  if (inv.currency && (inv.currency !== SUPPORTED_CURRENCY || (po && po.currency !== inv.currency))) {
    out.push({ type: 'currency_mismatch', fields: ['currency'], expected: po?.currency ?? SUPPORTED_CURRENCY, observed: inv.currency, difference: null, poId,
      evidence: { check: 'currency', invoice_currency: inv.currency, po_currency: po?.currency ?? null, supported_currencies: [SUPPORTED_CURRENCY] } });
  }

  for (const l of inv.lines) {
    const computed = lineCents(l.qty_milli, l.unit_price);
    if (computed !== l.line_total) out.push({ type: 'line_arithmetic', fields: ['lines'], expected: toMoney(computed), observed: toMoney(l.line_total),
      difference: l.line_total - computed, evidence: { check: 'line_arithmetic', line_id: l.id, line_number: l.line_number, line: lineText(l), computed: toMoney(computed) } });
  }
  const lineSum = sum(inv.lines.map((l) => l.line_total));
  if (inv.subtotal != null && inv.lines.length && lineSum !== inv.subtotal) {
    out.push({ type: 'incorrect_total', fields: ['subtotal', 'lines'], expected: toMoney(lineSum), observed: toMoney(inv.subtotal), difference: inv.subtotal - lineSum,
      evidence: { check: 'subtotal', line_totals: toMoney(lineSum), subtotal: toMoney(inv.subtotal) } });
  }
  const base = inv.subtotal ?? (inv.lines.length ? lineSum : null);
  if (inv.total_amount != null && base != null && base + (inv.tax_amount ?? 0) !== inv.total_amount) {
    const expected = base + (inv.tax_amount ?? 0);
    out.push({ type: 'incorrect_total', fields: ['total_amount', 'subtotal', 'tax_amount'], expected: toMoney(expected), observed: toMoney(inv.total_amount),
      difference: inv.total_amount - expected, evidence: { check: 'total', subtotal: toMoney(base), subtotal_source: inv.subtotal != null ? 'subtotal' : 'line_totals',
        tax: toMoney(inv.tax_amount ?? 0), total: toMoney(inv.total_amount) } });
  }
  const taxed = inv.lines.filter((l) => l.tax_amount != null);
  if (taxed.length && inv.tax_amount != null && sum(taxed.map((l) => l.tax_amount!)) !== inv.tax_amount) {
    const lineTax = sum(taxed.map((l) => l.tax_amount!));
    out.push({ type: 'tax_mismatch', fields: ['tax_amount', 'lines'], expected: toMoney(lineTax), observed: toMoney(inv.tax_amount), difference: inv.tax_amount - lineTax,
      evidence: { check: 'line_tax', line_tax: toMoney(lineTax), tax: toMoney(inv.tax_amount) } });
  }

  if (!inv.po_reference) {
    out.push({ type: 'missing_purchase_order', fields: ['po_reference'], expected: 'A purchase order reference', observed: null, difference: null, evidence: { check: 'po_reference', po_reference: null } });
  } else if (poMatches.length !== 1) {
    out.push({ type: poMatches.length ? 'ambiguous_reference' : 'missing_purchase_order', fields: ['po_reference'], expected: 'Exactly one purchase order on file',
      observed: inv.po_reference, difference: null, evidence: { check: 'po_lookup', po_reference: inv.po_reference, matches: poMatches } });
  }

  if (!po && inv.supplier_name_raw && !supplierOnFile) {
    out.push({ type: 'supplier_mismatch', severity: similarSupplierName ? 'medium' : 'low', fields: ['supplier_name'], expected: similarSupplierName ?? 'A supplier on file',
      observed: inv.supplier_name_raw, difference: null, evidence: { check: 'supplier_on_file', engine: 'similarSupplier', similar_to: similarSupplierName } });
  }

  if (po) {
    const c = compareWithPo(inv, po);
    if (!c.supplier.ok && inv.supplier_name_raw) {
      out.push({ type: 'supplier_mismatch', severity: c.supplier.review ? 'medium' : 'high', fields: ['supplier_name'], expected: po.supplier_name, observed: inv.supplier_name_raw,
        difference: null, poId, evidence: { engine: 'supplierEvidence', error: c.supplier.error, code: c.supplier.review ? 'SUPPLIER_REVIEW' : null } });
    }
    if (c.comparison) {
      const supplierEvidenceText = c.supplier.ok ? c.supplier.evidence : null;
      for (const l of c.comparison.lines.filter((x) => x.changed)) {
        const il = l.invoiceLine ? inv.lines[l.invoiceLine - 1] : null, pl = l.poLine ? po.lines[l.poLine - 1] : null;
        const evidence = { engine: 'compareDocuments', line: l, invoice_line_id: il?.id ?? null, po_line_id: pl?.id ?? null, supplier_evidence: supplierEvidenceText };
        const base = { fields: ['lines'], difference: l.differenceCents, evidence, poId };
        // A line with both a price and a quantity change is one unit_price_mismatch carrying the engine's whole line difference.
        if (!il || !pl) out.push({ ...base, type: 'unmatched_line', expected: pl ? lineText(pl) : 'Not on the purchase order', observed: il ? lineText(il) : 'Not invoiced' });
        else if (il.unit_price !== pl.unit_price) out.push({ ...base, type: 'unit_price_mismatch', expected: toMoney(pl.unit_price), observed: toMoney(il.unit_price) });
        else out.push({ ...base, type: 'quantity_mismatch', expected: qtyText(pl.qty_milli), observed: qtyText(il.qty_milli) });
      }
      if (c.comparison.taxDifferenceCents !== 0) {
        const { taxDifferenceCents, differenceCents, invoiceTotal, poTotal } = c.comparison;
        out.push({ type: 'tax_mismatch', fields: ['tax_amount'], expected: toMoney(po.tax_amount), observed: toMoney(inv.tax_amount ?? 0), difference: taxDifferenceCents, poId,
          evidence: { engine: 'compareDocuments', taxDifferenceCents, differenceCents, invoiceTotal, poTotal } });
      }
    } else if (c.error && !out.some((f) => EXPLAINS_ENGINE_ERROR.has(f.type))) {
      const noSku = inv.lines.some((l) => !l.sku);
      out.push({ type: noSku ? 'potential_extraction_error' : 'unmatched_line', fields: [], expected: 'Lines the engine can pair with the purchase order',
        observed: c.error.slice(0, 300), difference: null, poId, evidence: { engine: 'compareDocuments', engine_error: c.error, ...(noSku ? { suspected_type: 'unmatched_line' } : {}) } });
    }
  }

  for (const { other, pair } of duplicates) {
    out.push({ type: 'duplicate_candidate', fields: [], expected: null, observed: other.invoice_number, difference: null,
      evidence: { engine: 'comparePair', other_invoice_id: other.id, ...pair } });
  }

  // A failed check that rests on a field the extractor was unsure about is an extraction problem first.
  const touches = (fields: string[]) => fields.some((f) => unsure.some((u) => u === f || u.startsWith(`${f}.`) || u.startsWith(`${f}[`)));
  return out.map((f) => (f.type !== 'potential_extraction_error' && touches(f.fields)
    ? { ...f, type: 'potential_extraction_error' as const, severity: undefined, evidence: { ...f.evidence, suspected_type: f.type, unsure_fields: unsure } }
    : f));
}

export const evidenceHash = (f: Finding) => sha256(canonical({ type: f.type, expected: f.expected, observed: f.observed, difference: f.difference, evidence: f.evidence }));

export async function setInvoiceStatus(db: Db, orgId: string, actor: Actor, id: string, from: Status, to: Status, extra: Record<string, unknown> = {}) {
  if (from === to) return;
  await db.query('update invoices set status = $1 where id = $2 and organization_id = $3', [to, id, orgId]);
  await audit(db, { orgId, actor, event: 'invoice.status_changed', targetType: 'invoice', targetId: id, previous: { status: from }, next: { status: to, ...extra } });
}

/** Status from the invoice's discrepancies: open extraction problems first, then any open discrepancy. */
export async function deriveInvoiceStatus(db: Db, invoiceId: string): Promise<Status> {
  const [c] = await db.query<{ open: number; total: number; extraction: number }>(
    `select count(*) filter (where status in ${OPEN_STATUSES_SQL})::int as open, count(*)::int as total,
            count(*) filter (where status in ${OPEN_STATUSES_SQL} and discrepancy_type = 'potential_extraction_error')::int as extraction
     from discrepancies where invoice_id = $1`, [invoiceId]);
  return c.extraction ? 'needs_extraction_review' : c.open ? 'exception' : c.total ? 'resolved' : 'validated';
}

/**
 * Runs every check and upserts discrepancies keyed by (invoice, type, evidence hash): unchanged data adds nothing.
 * Existing discrepancies are never closed here; only a human resolution closes one.
 */
export async function processInvoice(db: Db, orgId: string, invoiceId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const inv = (await loadInvoice(tx, orgId, invoiceId, true)) ?? notFound();
    if (!PROCESSABLE.includes(inv.status)) fail('conflict', `Invoice is ${inv.status} and cannot be revalidated.`);

    const suppliers = await tx.query<{ id: string; supplier_name: string; normalized_name: string }>(
      'select id, supplier_name, normalized_name from suppliers where organization_id = $1 order by supplier_name', [orgId]);
    const norm = normalizeVendor(inv.supplier_name_raw);
    const onFile = norm ? suppliers.find((s) => s.normalized_name === norm) : undefined;
    const similar = !onFile && inv.supplier_name_raw ? suppliers.find((s) => similarSupplier(inv.supplier_name_raw, s.supplier_name)) : undefined;
    const poMatches = inv.po_reference ? await tx.query<{ id: string; purchase_order_number: string }>(
      `select id, purchase_order_number from purchase_orders where organization_id = $1 and lower(trim(purchase_order_number)) = lower(trim($2))
       order by purchase_order_number`, [orgId, inv.po_reference]) : [];
    const po = poMatches.length === 1 ? await loadPurchaseOrder(tx, orgId, poMatches[0].id) : null;

    const links = { supplier_id: onFile?.id ?? null, purchase_order_id: po?.id ?? null };
    if (links.supplier_id !== inv.supplier_id || links.purchase_order_id !== inv.purchase_order_id) {
      await tx.query('update invoices set supplier_id = $1, purchase_order_id = $2 where id = $3 and organization_id = $4', [links.supplier_id, links.purchase_order_id, inv.id, orgId]);
      await audit(tx, { orgId, actor, event: 'invoice.linked', targetType: 'invoice', targetId: inv.id,
        previous: { supplier_id: inv.supplier_id, purchase_order_id: inv.purchase_order_id }, next: links });
    }

    const findings = findDiscrepancies({ inv: { ...inv, ...links }, po, poMatches, supplierOnFile: !!onFile, similarSupplierName: similar?.supplier_name ?? null,
      duplicates: await duplicateCandidates(tx, orgId, inv) });
    let created = 0;
    for (const f of findings) {
      const [row] = await tx.query<{ id: string }>(
        `insert into discrepancies (organization_id, invoice_id, purchase_order_id, discrepancy_type, severity, expected_value, observed_value,
           difference_amount, status, deterministic_evidence, evidence_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, 'open', $9::jsonb, $10) on conflict do nothing returning id`,
        [orgId, inv.id, f.poId ?? null, f.type, f.severity ?? SEVERITY[f.type], f.expected, f.observed, toMoney(f.difference), JSON.stringify(f.evidence), evidenceHash(f)]);
      if (!row) continue;
      created++;
      await audit(tx, { orgId, actor, event: 'discrepancy.created', targetType: 'discrepancy', targetId: row.id,
        next: { status: 'open', discrepancy_type: f.type, invoice_id: inv.id, discrepancy_id: row.id } });
    }
    const status = await deriveInvoiceStatus(tx, inv.id);
    await setInvoiceStatus(tx, orgId, actor, inv.id, inv.status, status);
    return { invoice_id: inv.id, status, created };
  });
}
