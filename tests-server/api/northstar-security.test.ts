import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { scriptedModel } from '../../server/agent/model';
import { ensureWorkspace } from '../../server/services/workspace';
import { agentEnv } from '../agent/env';
import { invoiceBody } from './helpers';

it('keeps both Northstar originals, the human decision and linked audit history after a correction', async () => {
  const env = await agentEnv(scriptedModel());
  try {
    const reviewer = randomUUID();
    await ensureWorkspace(env.db, env.storage, reviewer);
    const get = async (path: string) => (await env.http('GET', path, reviewer)).body.data;
    const [original] = await get('/api/invoices');
    const [po] = await get('/api/purchase-orders');
    expect(original).toMatchObject({ invoice_number: 'NS-1068', total_amount: '660.00', purchase_order_id: po.id });
    expect(po).toMatchObject({ purchase_order_number: 'PO-2026-042', total_amount: '600.00' });
    const [finding] = await get(`/api/invoices/${original.id}/discrepancies`);
    expect(finding).toMatchObject({ difference_amount: '60.00', discrepancy_type: 'unit_price_mismatch' });
    const investigation = await env.investigate(reviewer, finding.id);
    expect(investigation.result.recommended_action).toBe('request_corrected_invoice');
    const decision = await env.http('POST', `/api/discrepancies/${finding.id}/resolve`, reviewer, {
      decision: 'approved', approved_action: 'request_corrected_invoice', investigation_id: investigation.id, notes: 'Request PO price.',
      actor_id: randomUUID(),
    });
    expect(decision.body.data.resolution.reviewer_id).toBe(reviewer);
    const draft = await env.http('POST', `/api/discrepancies/${finding.id}/draft-message`, reviewer, { requested_correction: 'Use PO price.' });
    expect(draft.body.data.sent).toBe(false);
    const corrected = await env.http('POST', '/api/invoices', reviewer, invoiceBody({
      invoice_number: 'NS-1068', supplier_name: po.supplier_name, po_reference: po.purchase_order_number,
      subtotal: '600.00', total_amount: '600.00', lines: po.lines,
    }, { supersedes_invoice_id: original.id }));
    expect(corrected.body.data).toMatchObject({ status: 'validated', total_amount: '600.00', supersedes_invoice_id: original.id });
    const replacement = corrected.body.data.id;
    expect(await get(`/api/invoices/${original.id}`)).toMatchObject({ status: 'superseded', total_amount: '660.00' });
    expect(await get(`/api/invoices/${original.id}/history`)).toContainEqual(expect.objectContaining({
      actor_id: reviewer, new_state: { status: 'superseded', superseded_by: replacement },
    }));
    expect(await get(`/api/invoices/${replacement}/history`)).toContainEqual(expect.objectContaining({
      actor_id: reviewer, new_state: expect.objectContaining({ supersedes_invoice_id: original.id }),
    }));
    expect(await get(`/api/investigations/${investigation.id}`)).toMatchObject({ id: investigation.id });
    const objects = await env.db.query<{document_storage_path: string}>('select document_storage_path from invoices where id = any($1::uuid[])', [[original.id, replacement]]);
    expect(objects).toHaveLength(2);
    for (const row of objects) expect(env.storage.objects.has(row.document_storage_path)).toBe(true);
    const laterDecision = await env.http('POST', `/api/discrepancies/${finding.id}/resolve`, reviewer, { decision: 'rejected' });
    expect(laterDecision.status).toBe(409);
    const history = await get(`/api/discrepancies/${finding.id}/history`);
    expect(history.resolutions).toContainEqual(expect.objectContaining({ id: decision.body.data.resolution.id }));
    const outsider = await env.newOrg();
    for (const id of [original.id, replacement]) {
      expect((await env.http('GET', `/api/invoices/${id}`, outsider.reviewer)).status).toBe(404);
    }
  } finally {
    await env.close();
  }
});
