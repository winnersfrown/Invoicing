import { comparePair } from '../../dist/duplicates-engine.js';
import type { EvidenceItem } from '../contracts/index';
import { loadInvoice, toCents, type Db, type Invoice } from '../db/index';
import { notFound } from './util';

type DupRow = { id: string; status: string; supplier_name_raw: string | null; invoice_number: string | null; total: number | null; source_text: string | null; document_sha256: string };
const engineDoc = (r: DupRow) => ({ id: r.id, status: r.status, fields: { vendor: r.supplier_name_raw, number: r.invoice_number, total: r.total == null ? null : r.total / 100 }, source: r.source_text, fingerprint: r.document_sha256 });

/**
 * Engine duplicate candidates for one invoice against the rest of its organisation. Superseded and rejected
 * invoices, and the invoice it replaces (or that replaces it), are not candidates.
 * ponytail: loads every live invoice in the org; prefilter by supplier/total/hash in SQL past ~10k invoices.
 */
export async function duplicateCandidates(db: Db, orgId: string, inv: Invoice) {
  const others = await db.query(
    `select id, status, supplier_name_raw, invoice_number, total_amount::text as total_amount, source_text, document_sha256 from invoices
     where organization_id = $1 and id <> $2 and status not in ('superseded', 'rejected')
       and id is distinct from $3::uuid and supersedes_invoice_id is distinct from $2::uuid`, [orgId, inv.id, inv.supersedes_invoice_id]);
  const me = engineDoc({ ...inv, total: inv.total_amount });
  return others.map((o) => {
    const { stamp: _stamp, ...pair } = comparePair(me, engineDoc({ ...(o as DupRow), total: toCents(o.total_amount) }));
    return { other: { id: o.id as string, invoice_number: o.invoice_number as string | null }, pair };
  }).filter((x) => x.pair.candidate);
}

/** Agent tool find_duplicate_candidates and GET /api/invoices/:id/duplicate-candidates. */
export async function findDuplicateCandidates(db: Db, orgId: string, invoiceId: string) {
  const inv = (await loadInvoice(db, orgId, invoiceId)) ?? notFound();
  const found = await duplicateCandidates(db, orgId, inv);
  const candidates = found.map(({ other, pair }) => ({ other_invoice_id: other.id, other_invoice_number: other.invoice_number, level: pair.level, evidence: pair.evidence, content_similarity: pair.content }));
  const evidence: EvidenceItem[] = found.map(({ other, pair }) => ({
    id: `duplicate:${[inv.id, other.id].sort().join(':')}`, label: `${pair.level} with invoice ${other.invoice_number ?? '(no number)'}`.slice(0, 200),
    value: pair.evidence.join(' ').slice(0, 2000),
  }));
  return { data: { invoice_id: inv.id, candidates }, evidence };
}
