import { parseExtractedText } from '../../dist/extraction.js';
import { adjustmentCents, convertCents, netLineCents } from '../../dist/arithmetic.js';
// Deterministic checks for one invoice. Amounts compared against a PO come from the matching engine;
// the internal arithmetic the engine does not cover (line totals, subtotal, line tax) is integer cents here.
import { invoiceDateIssue } from '../../dist/invoice-dates.js';
import { normalizeVendor } from '../../dist/supplier.js';
import type { DiscrepancyType, InvoiceStatus, ReviewLineMatchRequest, Severity } from '../contracts/index.ts';
import { loadInvoice, loadPurchaseOrder, toMoney, type Db, type Invoice, type PurchaseOrder } from '../db/index.ts';
import type { z } from 'zod';
import { audit, type Actor } from './audit.ts';
import { duplicateCandidates } from './duplicates.ts';
import { checkPoSupplier, compareWithPo, invoicePricingCurrency, lineText, qtyText } from './matching.ts';
import { canonical, fail, notFound, sha256 } from './util.ts';

type DType = z.infer<typeof DiscrepancyType>;
type Status = z.infer<typeof InvoiceStatus>;
export type Finding = {
  type: DType; severity?: z.infer<typeof Severity>; fields: string[]; expected: string | null; observed: string | null;
  difference: number | null; evidence: Record<string, unknown>; poId?: string | null;
};

const LOW_CONFIDENCE = 0.7;
export const OPEN_STATUSES_SQL = `('open', 'investigating', 'awaiting_supplier')`;
const PROCESSABLE: Status[] = ['uploaded', 'needs_extraction_review', 'validated', 'exception', 'resolved'];
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
  candidate?: PurchaseOrder | null; blocked?: boolean;
  duplicates: Awaited<ReturnType<typeof duplicateCandidates>>;
};

/** Pure: every discrepancy the deterministic checks find for this invoice. */
export function findDiscrepancies({ inv, po, poMatches, duplicates, candidate, blocked }: CheckInput): Finding[] {
  const out: Finding[] = [];
  const poId = po?.id ?? null;
  const ex = inv.extraction ?? {};

  // Extraction: required fields that are missing, and fields the extractor was unsure about.
  const required: Record<string, unknown> = { supplier_name: inv.supplier_name_raw, invoice_number: inv.invoice_number, currency: inv.currency, total_amount: inv.total_amount, lines: inv.lines.length || null };
  const reviewed = new Set<string>(ex.reviewed_fields ?? []);
  const pendingReview = (field: string) => !reviewed.has(field.split(/[.\[]/, 1)[0]);
  const missing = [...new Set([...Object.keys(required).filter((k) => required[k] == null),
    ...(ex.missing ?? []).filter((k: string) => k !== 'po_reference' && k !== 'tax_amount' && pendingReview(k))])].sort();
  const lowConfidence = Object.entries((ex.field_confidence ?? {}) as Record<string, number>).filter(([, c]) => c < LOW_CONFIDENCE).map(([k]) => k);
  const uncertain = [...new Set<string>([...(ex.uncertain ?? []), ...lowConfidence])].filter((f) => !missing.includes(f) && pendingReview(f)).sort();
  const unsure = [...missing, ...uncertain];
  if (unsure.length) {
    out.push({ type: 'potential_extraction_error', fields: [], expected: 'All required fields read with confidence',
      observed: [missing.length ? `missing: ${missing.join(', ')}` : '', uncertain.length ? `uncertain: ${uncertain.join(', ')}` : ''].filter(Boolean).join('; '),
      difference: null, evidence: { check: 'extraction', missing, uncertain, method: ex.method ?? null } });
  }

  const dateIssue = invoiceDateIssue(inv.invoice_date, inv.due_date);
  if (dateIssue) {
    out.push({ type: 'potential_extraction_error', fields: ['invoice_date', 'due_date'],
      expected: 'Payment due date on or after invoice date', observed: dateIssue, difference: null,
      evidence: { check: 'date_order', invoice_date: inv.invoice_date, due_date: inv.due_date } });
  }

  const payableCurrency = inv.currency?.toUpperCase() ?? null;
  const pricingCurrency = invoicePricingCurrency(inv);
  const mixedCurrency = Boolean(payableCurrency && pricingCurrency && payableCurrency !== pricingCurrency);
  const poCurrency = po?.currency.toUpperCase() ?? null;
  if (payableCurrency && poCurrency && payableCurrency !== poCurrency) {
    out.push({ type: 'currency_mismatch', fields: ['currency'], expected: poCurrency, observed: payableCurrency, difference: null, poId,
      evidence: { check: 'currency', invoice_currency: payableCurrency, pricing_currency: pricingCurrency, po_currency: poCurrency } });
  } else if (po && mixedCurrency) {
    out.push({ type: 'potential_extraction_error', fields: ['currency'], expected: 'A single currency for PO comparison',
      observed: `Invoice lines are priced in ${pricingCurrency} and payable in ${payableCurrency}. Verify against the PO before matching.`,
      difference: null, poId, evidence: { check: 'mixed_currency_po', pricing_currency: pricingCurrency, invoice_currency: payableCurrency, po_currency: poCurrency } });
  }

  for (const l of inv.lines) {
    const computed = lineCents(l.qty_milli, l.unit_price);
    if (computed !== l.line_total) out.push({ type: 'line_arithmetic', fields: ['lines'], expected: toMoney(computed), observed: toMoney(l.line_total),
      difference: l.line_total - computed, evidence: { check: 'line_arithmetic', currency: pricingCurrency, line_id: l.id, line_number: l.line_number, line: lineText(l), computed: toMoney(computed) } });
  }
  const reviewedMoney = (field: string) => {
    const value: unknown = ex.support_labels?.[field]?.reviewedValue;
    return typeof value === 'string' && /^-?\d{1,12}\.\d{2}$/.test(value) ? Math.round(Number(value) * 100) : null;
  };
  const shipping = reviewedMoney('shipping'), discount = reviewedMoney('discount');
  const listed: unknown = ex.support_labels?.adjustments?.reviewedValue;
  const adjustments = adjustmentCents({
    shipping: shipping == null ? null : shipping / 100,
    discount: discount == null ? null : discount / 100,
    adjustments: Array.isArray(listed)
      ? listed.map(a => ({ cents: a?.cents, appliesTo: a?.appliesTo === 'balance' ? 'balance' : 'total' }))
      : undefined,
  });
  const taxInclusive = ex.support_labels?.taxInclusive?.reviewedValue === true;
  const grossLines = sum(inv.lines.map(l => l.line_total));
  const lineSum = netLineCents(grossLines, inv.subtotal, inv.tax_amount, taxInclusive);
  const lineSubtotal = taxInclusive && inv.tax_amount == null && lineSum !== inv.subtotal ? null : lineSum;
  if (inv.subtotal != null && inv.lines.length && lineSubtotal != null && lineSubtotal !== inv.subtotal) {
    out.push({ type: 'incorrect_total', fields: ['subtotal', 'lines'], expected: toMoney(lineSubtotal), observed: toMoney(inv.subtotal), difference: inv.subtotal - lineSubtotal,
      evidence: { check: 'subtotal', currency: pricingCurrency, line_totals: toMoney(lineSubtotal), subtotal: toMoney(inv.subtotal) } });
  }
  const base = inv.subtotal ?? (inv.lines.length && !taxInclusive ? lineSum : null);
  const pricedTotal = mixedCurrency ? reviewedMoney('pricingTotal') : inv.total_amount;
  if (pricedTotal != null && base != null && inv.tax_amount != null && adjustments != null) {
    const expected = base + inv.tax_amount + adjustments;
    if (expected !== pricedTotal) out.push({ type: 'incorrect_total', fields: [mixedCurrency ? 'pricingTotal' : 'total_amount', inv.subtotal != null ? 'subtotal' : 'lines', 'tax_amount'],
      expected: toMoney(expected), observed: toMoney(pricedTotal), difference: pricedTotal - expected,
      evidence: { check: 'total', currency: pricingCurrency, subtotal: toMoney(base), subtotal_source: inv.subtotal != null ? 'subtotal' : 'line_totals',
        tax: toMoney(inv.tax_amount), shipping: toMoney(shipping), discount: toMoney(discount), adjustments: toMoney(adjustments), total: toMoney(pricedTotal) } });
  }
  const taxNeeded = inv.tax_amount == null && (
    (pricedTotal != null && base != null && adjustments != null && base + adjustments !== pricedTotal)
    || (po && !mixedCurrency && payableCurrency === poCurrency && po.tax_amount !== 0));
  const missingInputs = [taxNeeded && !missing.includes('tax_amount') ? 'tax_amount' : null, adjustments == null ? 'adjustments' : null].filter(Boolean);
  if (missingInputs.length) {
    // Recompute from the saved source. A reviewer edit or a different pricing
    // currency invalidates the original calculation.
    const source = taxNeeded && !mixedCurrency && !taxInclusive && adjustments === 0 && inv.source_text
      ? parseExtractedText(inv.source_text, 'invoice') : null;
    const proposal = source?.type === 'invoice' && source.subtotal != null && source.total != null &&
      Math.round(source.subtotal * 100) === inv.subtotal && Math.round(source.total * 100) === pricedTotal
      ? source.taxProposal : null;
    out.push({ type: 'potential_extraction_error', fields: [], expected: proposal?.reason ?? 'Amounts needed to complete validation',
      observed: `Missing or unreadable: ${missingInputs.join(', ')}`, difference: null,
      evidence: { check: 'financial_inputs', missing: missingInputs, ...(proposal ? { tax_proposal: proposal } : {}) } });
  }

  if (inv.lines.length && inv.tax_amount != null && inv.lines.every(l => l.tax_amount != null)) {
    const lineTax = sum(inv.lines.map(l => l.tax_amount!));
    if (lineTax !== inv.tax_amount) out.push({ type: 'tax_mismatch', fields: ['tax_amount', 'lines'], expected: toMoney(lineTax), observed: toMoney(inv.tax_amount), difference: inv.tax_amount - lineTax,
      evidence: { check: 'line_tax', currency: pricingCurrency, line_tax: toMoney(lineTax), tax: toMoney(inv.tax_amount) } });
  }

  // A printed rate links two displayed totals. Unavailable or imprecise evidence goes to review.
  if (mixedCurrency && inv.total_amount != null) {
    const rate = ex.support_labels?.exchangeRate?.reviewedValue;
    const conversion = pricedTotal != null && Number.isFinite(rate?.rate) && rate.rate > 0 && rate.rate <= 1_000_000
      && Number.isInteger(rate.decimals) && rate.decimals >= 0 && rate.decimals <= 12
      ? convertCents(pricedTotal, pricingCurrency, payableCurrency, rate) : null;
    const converted = conversion && Number.isSafeInteger(conversion.cents) && Math.abs(conversion.cents) < 100_000_000_000_000 ? conversion : null;
    const difference = converted == null ? null : inv.total_amount - converted.cents;
    if (difference == null || Math.abs(difference) > 1) {
      const confirmed = difference != null && converted != null && Math.abs(difference) > converted.toleranceCents;
      out.push({ type: confirmed ? 'incorrect_total' : 'potential_extraction_error', fields: ['pricingTotal', 'exchangeRate', 'total_amount', 'currency'],
        expected: converted ? toMoney(converted.cents) : 'Pricing total and a printed exchange rate',
        observed: difference == null ? `Conversion from ${pricingCurrency} to ${payableCurrency} needs verification` : toMoney(inv.total_amount),
        difference: confirmed ? difference : null,
        evidence: { check: 'currency_conversion', currency: payableCurrency, pricing_currency: pricingCurrency, pricing_total: toMoney(pricedTotal),
          rate: rate ?? null, rounding_tolerance_cents: converted?.toleranceCents ?? null } });
    }
  }

  if (!inv.po_reference) {
    out.push({ type: 'missing_purchase_order', fields: [], expected: 'A purchase order reference', observed: null, difference: null, evidence: { check: 'po_reference', po_reference: null } });
  } else if (poMatches.length !== 1) {
    out.push({ type: poMatches.length ? 'ambiguous_reference' : 'missing_purchase_order', fields: [], expected: 'Exactly one purchase order on file',
      observed: inv.po_reference, difference: null, evidence: { check: 'po_lookup', po_reference: inv.po_reference, matches: poMatches } });
  }

  if (candidate && !po) {
    if (blocked) out.push({ type: 'ambiguous_reference', fields: [], expected: 'A verified purchase order',
      observed: candidate.purchase_order_number, difference: null, poId: candidate.id,
      evidence: { check: 'po_manually_unlinked', po_reference: candidate.purchase_order_number } });
    const identity = checkPoSupplier(inv, candidate);
    if (!identity.ok && inv.supplier_name_raw) out.push({ type: 'supplier_mismatch', severity: identity.review ? 'medium' : 'high', fields: [],
      expected: candidate.supplier_name, observed: inv.supplier_name_raw, difference: null, poId: candidate.id,
      evidence: { check: 'po_supplier_identity', po_reference: candidate.purchase_order_number, review: identity.review, reason: identity.error } });
  }

  if (po) {
    const c = compareWithPo(inv, po);
    if (c.comparison) {
      const supplierEvidenceText = c.supplier.ok ? c.supplier.evidence : null;
      if (c.comparison.pendingLineMatches.length) {
        const candidates = c.comparison.pendingLineMatches.map(candidate => ({
          invoice_line_id: inv.lines[candidate.invoiceLine - 1].id,
          po_line_id: po.lines[candidate.poLine - 1].id,
          description: candidate.description, same_quantity: candidate.sameQuantity,
        }));
        const pending = new Set(candidates.map(candidate => candidate.invoice_line_id)).size;
        out.push({ type: 'ambiguous_reference', fields: [], expected: 'Reviewer confirmation of product matches',
          observed: `${pending} invoice line${pending === 1 ? '' : 's'} with possible PO matches`,
          difference: null, poId, evidence: { check: 'line_match_review', candidates } });
      }
      for (const l of c.comparison.lines.filter((x) => x.changed)) {
        const il = l.invoiceLine ? inv.lines[l.invoiceLine - 1] : null, pl = l.poLine ? po.lines[l.poLine - 1] : null;
        const { matchBasis, ...line } = l;
        const evidence = { engine: 'compareDocuments', line, invoice_line_id: il?.id ?? null, po_line_id: pl?.id ?? null, supplier_evidence: supplierEvidenceText,
          ...(matchBasis === 'reviewer_confirmed' ? { match_basis: matchBasis } : {}) };
        const base = { fields: ['lines'], difference: l.differenceCents, evidence, poId };
        // A line with both a price and a quantity change is one unit_price_mismatch carrying the engine's whole line difference.
        if (!il || !pl) out.push({ ...base, type: 'unmatched_line', expected: pl ? lineText(pl) : 'Not on the purchase order', observed: il ? lineText(il) : 'Not invoiced' });
        else if (il.unit_price !== pl.unit_price) out.push({ ...base, type: 'unit_price_mismatch', expected: toMoney(pl.unit_price), observed: toMoney(il.unit_price) });
        else out.push({ ...base, type: 'quantity_mismatch', expected: qtyText(pl.qty_milli), observed: qtyText(il.qty_milli) });
      }
      if (c.comparison.taxDifferenceCents) {
        const { taxDifferenceCents, differenceCents, invoiceTotal, poTotal } = c.comparison;
        out.push({ type: 'tax_mismatch', fields: ['tax_amount'], expected: toMoney(po.tax_amount), observed: toMoney(inv.tax_amount), difference: taxDifferenceCents, poId,
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

/** Record a decision only on a current candidate for the linked PO, then refresh findings in the same transaction. */
export async function reviewLineMatch(db: Db, orgId: string, invoiceId: string, actor: Actor, req: z.infer<typeof ReviewLineMatchRequest>) {
  const inv = await loadInvoice(db, orgId, invoiceId, true) ?? notFound();
  if (inv.archived_at || !PROCESSABLE.includes(inv.status) || inv.purchase_order_id !== req.purchase_order_id) {
    fail('conflict', 'The invoice or its linked purchase order changed. Reload before reviewing the match.');
  }
  const po = await loadPurchaseOrder(db, orgId, req.purchase_order_id) ?? notFound();
  const { comparison } = compareWithPo(inv, po);
  const current = comparison?.pendingLineMatches.some(candidate =>
    inv.lines[candidate.invoiceLine - 1].id === req.invoice_line_id && po.lines[candidate.poLine - 1].id === req.po_line_id);
  if (!current) fail('conflict', 'This suggested match is no longer pending. Reload to see the latest comparison.');

  const extraction = { ...inv.extraction, po_line_decisions: [...(inv.extraction?.po_line_decisions ?? []), req] };
  await db.query('update invoices set extraction = $1::jsonb where id = $2 and organization_id = $3', [JSON.stringify(extraction), invoiceId, orgId]);
  await audit(db, { orgId, actor, event: 'invoice.line_match_reviewed', targetType: 'invoice', targetId: invoiceId, next: req });
  return processInvoice(db, orgId, invoiceId, actor);
}

/**
 * Runs every check. Review reminders and PO availability track the current evidence; past findings and decisions stay in history.
 */
export async function processInvoice(db: Db, orgId: string, invoiceId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const inv = (await loadInvoice(tx, orgId, invoiceId, true)) ?? notFound();
    if (inv.archived_at) {
      if (actor.type !== 'system') fail('conflict', 'Restore this invoice before processing it.');
      return { invoice_id: inv.id, status: inv.status, created: 0 };
    }
    if (!PROCESSABLE.includes(inv.status)) fail('conflict', `Invoice is ${inv.status} and cannot be revalidated.`);

    const suppliers = await tx.query<{ id: string; supplier_name: string; normalized_name: string }>(
      'select id, supplier_name, normalized_name from suppliers where organization_id = $1 order by supplier_name', [orgId]);
    const norm = normalizeVendor(inv.supplier_name_raw);
    const onFile = norm ? suppliers.find((s) => s.normalized_name === norm) : undefined;
    const poMatches = inv.po_reference ? await tx.query<{ id: string; purchase_order_number: string }>(
      `select id, purchase_order_number from purchase_orders where organization_id = $1 and lower(trim(purchase_order_number)) = lower(trim($2))
       order by purchase_order_number`, [orgId, inv.po_reference]) : [];
    const candidate = poMatches.length === 1 ? await loadPurchaseOrder(tx, orgId, poMatches[0].id) : null;
    const blocked = !!candidate && (await tx.query(
      'select 1 from invoice_po_unlinks where organization_id = $1 and invoice_id = $2 and purchase_order_id = $3',
      [orgId, inv.id, candidate.id])).length > 0;
    const po = candidate && !blocked && checkPoSupplier(inv, candidate).ok ? candidate : null;

    const links = { supplier_id: onFile?.id ?? null, purchase_order_id: po?.id ?? null };
    if (links.supplier_id !== inv.supplier_id || links.purchase_order_id !== inv.purchase_order_id) {
      await tx.query('update invoices set supplier_id = $1, purchase_order_id = $2 where id = $3 and organization_id = $4', [links.supplier_id, links.purchase_order_id, inv.id, orgId]);
      await audit(tx, { orgId, actor, event: 'invoice.linked', targetType: 'invoice', targetId: inv.id,
        previous: { supplier_id: inv.supplier_id, purchase_order_id: inv.purchase_order_id }, next: links });
    }

    const findings = findDiscrepancies({ inv: { ...inv, ...links }, po, poMatches, candidate, blocked,
      duplicates: await duplicateCandidates(tx, orgId, inv) });
    const active = new Set(findings.map(evidenceHash));
    const reminders = await tx.query<{ id: string; status: string; evidence_hash: string; automatic: boolean }>(
      `select d.id, d.status, d.evidence_hash, coalesce((
         select a.new_state ->> 'reason' = 'no_longer_detected' from audit_events a
          where a.organization_id = d.organization_id and a.target_type = 'discrepancy' and a.target_id = d.id::text
            and a.event_type = 'discrepancy.status_changed' order by a.id desc limit 1
       ), false) as automatic
       from discrepancies d where d.invoice_id = $1 and d.organization_id = $2
         and (d.deterministic_evidence ->> 'check' in ('extraction', 'po_reference', 'po_lookup', 'supplier_on_file', 'currency', 'line_match_review', 'po_supplier_identity', 'po_manually_unlinked', 'mixed_currency_po')
           or d.deterministic_evidence ->> 'engine' in ('supplierEvidence', 'comparePair')
           or (d.deterministic_evidence ->> 'engine' = 'compareDocuments' and d.discrepancy_type in ('unmatched_line', 'unit_price_mismatch', 'quantity_mismatch', 'tax_mismatch'))
           or (d.discrepancy_type = 'potential_extraction_error' and d.deterministic_evidence ? 'unsure_fields'))`,
      [inv.id, orgId]);
    for (const reminder of reminders) {
      const detected = active.has(reminder.evidence_hash);
      const open = ['open', 'investigating', 'awaiting_supplier'].includes(reminder.status);
      const status = !detected && open ? 'dismissed'
        : detected && reminder.status === 'dismissed' && reminder.automatic ? 'open' : null;
      if (!status) continue;
      await tx.query('update discrepancies set status = $1 where id = $2 and organization_id = $3', [status, reminder.id, orgId]);
      await audit(tx, { orgId, actor, event: 'discrepancy.status_changed', targetType: 'discrepancy', targetId: reminder.id,
        previous: { status: reminder.status }, next: { status, reason: detected ? 'detected_again' : 'no_longer_detected' } });
    }
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
