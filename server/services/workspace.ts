import invoice from '../../dist/samples/matching-invoice.json' with { type: 'json' };
import purchaseOrder from '../../dist/samples/matching-po.json' with { type: 'json' };
import { centsToMoney, CreateInvoiceRequest, CreatePurchaseOrderRequest } from '../contracts/index.ts';
import { asUser, type Db } from '../db/index.ts';
import { getMembership, type Caller } from './auth.ts';
import { createInvoice, createPurchaseOrder } from './invoices.ts';
import type { Storage } from './storage.ts';
import { sha256 } from './util.ts';

const amount = (dollars: number) => centsToMoney(Math.round(dollars * 100));
const line = (item: typeof invoice.lines[number]) => ({
  sku: item.sku,
  description: item.description,
  quantity: item.quantity,
  unit_price: amount(item.unitPrice),
  line_total: amount(item.quantity * item.unitPrice),
  tax_amount: null,
});

/** A verified user can provision one private workspace. Retries return their existing membership. */
export async function ensureWorkspace(db: Db, storage: Storage, userId: string): Promise<Caller> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [userId]);
    const existing = await getMembership(tx, userId);
    if (existing) return existing;

    const [{ id: orgId }] = await tx.query<{ id: string }>(
      'insert into organizations (name) values ($1) returning id', ['Sorikano Demo Workspace']);
    const caller = { userId, orgId, role: 'reviewer' } as const;
    await tx.query('insert into organization_memberships (user_id, organization_id, role) values ($1, $2, $3)',
      [userId, orgId, caller.role]);

    await asUser(tx, userId, async () => {
      await createPurchaseOrder(tx, caller, CreatePurchaseOrderRequest.parse({
        supplier_name: purchaseOrder.vendor,
        purchase_order_number: purchaseOrder.number,
        currency: purchaseOrder.currency,
        tax_amount: amount(purchaseOrder.tax),
        total_amount: amount(purchaseOrder.total),
        lines: purchaseOrder.lines.map(line),
      }));

      const source = JSON.stringify(invoice, null, 2);
      const bytes = Buffer.from(source);
      await createInvoice(tx, caller, CreateInvoiceRequest.parse({
        file: {
          name: 'matching-invoice.json',
          mime_type: 'application/json',
          size_bytes: bytes.length,
          sha256: sha256(bytes),
          content_base64: bytes.toString('base64'),
        },
        extracted: {
          supplier_name: invoice.vendor,
          invoice_number: invoice.number,
          invoice_date: invoice.issued,
          due_date: invoice.due,
          po_reference: invoice.poNumber,
          currency: invoice.currency,
          subtotal: null,
          tax_amount: amount(invoice.tax),
          total_amount: amount(invoice.total),
          lines: invoice.lines.map(line),
          source_text: source,
          extraction: { method: 'json', confidence: null },
        },
      }), storage);
    });
    return caller;
  });
}
