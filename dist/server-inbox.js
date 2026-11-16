// Server-backed inbox, invoice detail, evidence viewer and resolution controls (signed-in mode only).
// The top half is pure request building (unit-tested); createServerInbox() is the DOM layer.
import {extractFile, parseExtractedText} from './extraction.js';
import {extractAndReview, reviewExisting} from './extraction-review.js';
import {validateDocument} from './matching-engine.js';
import {ACTION_TEXT, evidenceText, fill, formatMoney, h, investigationView, renderInvestigation} from './investigation-ui.js';

export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024; // server/contracts UPLOAD_MAX_BYTES
const MIME = {pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json', txt: 'text/plain'};

export function toMoneyString(n) {
  if (n == null || n === '') return null;
  const c = Math.round(Number(n) * 100);
  if (!Number.isSafeInteger(c)) throw Error(`Amount "${n}" is not a valid amount.`);
  return `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
}

/** The `file` part of CreateInvoiceRequest. */
export async function fileUpload({name, type, bytes}) {
  const ext = name.split('.').pop().toLowerCase();
  const mime = Object.values(MIME).includes(type) ? type : MIME[ext];
  if (!mime) throw Error('Upload a PDF, PNG, JPEG, WebP, JSON or TXT file.');
  if (bytes.length > UPLOAD_MAX_BYTES) throw Error(`${name} is ${(bytes.length / 1048576).toFixed(1)} MB. Files must be 3 MB or smaller to upload to the shared workspace.`);
  if (!bytes.length) throw Error(`${name} is empty.`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {name: name.slice(0, 255), mime_type: mime, size_bytes: bytes.length, sha256: [...hash].map(b => b.toString(16).padStart(2, '0')).join(''), content_base64: btoa(bin)};
}

const text = v => (v == null || String(v).trim() === '' ? null : String(v).trim());
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(text(v) ?? '') ? text(v) : null);
function lines(d) {
  return (Array.isArray(d?.lines) ? d.lines : []).map((l, i) => {
    const q = Number(l.quantity);
    if (!(q > 0 && q <= 100000)) throw Error(`Line ${i + 1}: quantity must be between 0 and 100,000.`);
    const unit = toMoneyString(l.unitPrice);
    if (unit == null) throw Error(`Line ${i + 1}: unit price is missing.`);
    return {sku: text(l.sku), description: String(l.description ?? '').trim().slice(0, 500), quantity: q, unit_price: unit, line_total: null, tax_amount: null};
  });
}
// Contract field -> how to read it from the app's document shape. These are the fields the extractor looks for.
const FIELDS = {
  supplier_name: d => text(d?.vendor), invoice_number: d => text(d?.number), po_reference: d => text(d?.poNumber),
  currency: d => { const c = text(d?.currency)?.toUpperCase() ?? null; if (c && !/^[A-Z]{3}$/.test(c)) throw Error(`Currency "${c}" must be a 3-letter code such as USD.`); return c; },
  tax_amount: d => toMoneyString(d?.tax), total_amount: d => toMoneyString(d?.total), lines: d => { const l = lines(d); return l.length ? l : null; },
};

/**
 * ExtractedInvoice from what the extractor read (`read`) and what the reviewer confirmed (`final`).
 * Empty fields stay null and are listed in `missing`. A field the reviewer entered or changed is listed in `uncertain`
 * with no confidence: the extractor did not read it. Dates and subtotal are sent only when the document states them.
 */
export function extractedInvoice({method, read, final, sourceText = null}) {
  const out = {}, missing = [], uncertain = [], field_confidence = {};
  for (const [field, get] of Object.entries(FIELDS)) {
    const value = get(final);
    out[field] = value;
    if (value == null) missing.push(field);
    else if (JSON.stringify(safe(get, read)) === JSON.stringify(value)) field_confidence[field] = 1;
    else uncertain.push(field);
  }
  const present = Object.keys(FIELDS).length - missing.length;
  return {
    supplier_name: out.supplier_name, invoice_number: out.invoice_number, invoice_date: isoDate(final?.issued), due_date: isoDate(final?.due),
    po_reference: out.po_reference, currency: out.currency, subtotal: toMoneyString(final?.subtotal), tax_amount: out.tax_amount, total_amount: out.total_amount,
    lines: out.lines ?? [], source_text: sourceText == null ? null : String(sourceText).slice(0, 200000),
    extraction: {method, confidence: present ? Math.round(Object.keys(field_confidence).length / present * 100) / 100 : null, field_confidence, missing, uncertain, source_refs: {}},
  };
}
function safe(get, d) { try { return get(d); } catch { return undefined; } }

/** CreatePurchaseOrderRequest from a verified purchase order document. Every field is required. */
export function purchaseOrderRequest(d) {
  const body = {supplier_name: text(d.vendor), purchase_order_number: text(d.number) ?? text(d.poNumber), currency: FIELDS.currency(d),
    tax_amount: toMoneyString(d.tax), total_amount: toMoneyString(d.total), lines: lines(d)};
  const missing = Object.entries(body).filter(([, v]) => v == null).map(([k]) => k.replaceAll('_', ' '));
  if (missing.length) throw Error(`The purchase order is missing: ${missing.join(', ')}.`);
  if (!body.lines.length) throw Error('The purchase order needs at least one line item.');
  return body;
}

// ---------- DOM ----------
const INVOICE_STATUS = {uploaded: ['Uploaded', ''], needs_extraction_review: ['Needs extraction review', 'review'], validated: ['Validated', 'approved'],
  exception: ['Exception', 'review'], resolved: ['Resolved', 'approved'], rejected: ['Rejected', 'rejected'], superseded: ['Superseded', '']};
const AI_STATUS = {queued: 'AI queued', in_progress: 'AI in progress', completed: 'AI completed', insufficient_evidence: 'AI: insufficient evidence', failed: 'AI failed'};
const DISC_STATUS = {open: 'Open', investigating: 'Investigating', awaiting_supplier: 'Awaiting supplier', resolved: 'Resolved', dismissed: 'Dismissed'};
const CLOSED = ['resolved', 'dismissed'];
const words = s => (s ? s[0].toUpperCase() + s.slice(1).replaceAll('_', ' ') : '');
const when = s => (s ? new Date(s).toLocaleString() : '');
const safeUrl = u => { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : null; } catch { return null; } };
function download(content, name) { const url = URL.createObjectURL(new Blob([content], {type: 'text/plain'})); const a = h('a', {href: url, download: name}); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

/** Runs fn with the button disabled; a second click while in flight is ignored. */
async function busy(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

/** Reads, extracts and has the user review an invoice file. Returns { method, read, final, sourceText } or null if cancelled. */
async function readInvoiceFile(file, progress) {
  if (file.size > UPLOAD_MAX_BYTES) throw Error(`${file.name} is larger than 3 MB. Files must be 3 MB or smaller to upload to the shared workspace.`);
  if (/\.json$/i.test(file.name)) {
    const source = await file.text();
    let d;
    try { d = JSON.parse(source); } catch { throw Error('This JSON file could not be read.'); }
    if (d?.type === 'credit_note') throw Error('Credit notes are not supported.');
    if (d?.type !== 'invoice') throw Error('The JSON file must describe an invoice ("type": "invoice").');
    return {method: 'json', read: d, final: d, sourceText: source};
  }
  let source, method = 'labeled_text';
  if (/\.txt$/i.test(file.name)) source = await file.text();
  else {
    let ocr = false;
    source = await extractFile(file, m => { if (/OCR|image text/i.test(m)) ocr = true; progress(m); });
    method = /\.pdf$/i.test(file.name) && !ocr ? 'pdf_text' : 'ocr';
  }
  const raw = parseExtractedText(source, 'invoice');
  const read = {...raw, currency: /^Currency[ \t]*:/mi.test(source) ? raw.currency : ''}; // the parser defaults USD; a default is not a reading
  const final = await reviewExisting(structuredClone(raw), source, /\.txt$/i.test(file.name) ? null : file);
  return final && {method, read, final, sourceText: source};
}

export function createServerInbox({api, root, user}) {
  const canAct = user.role !== 'viewer';
  let invoices = [], stopped = false;
  const live = h('div', {class: 'match-message', role: 'status', 'aria-live': 'polite'});
  const say = msg => { live.textContent = msg; if (detail?.live) detail.live.textContent = msg; };
  const fail = e => say(e.message || String(e));
  const pickFile = (accept, onFile) => { const input = h('input', {type: 'file', accept, hidden: true, onchange: () => { const f = input.files[0]; input.remove(); if (f) onFile(f); }}); (document.querySelector('dialog[open]') ?? document.body).append(input); input.click(); };

  const rows = h('tbody');
  const uploadInvoiceButton = h('button', {type: 'button', class: 'button primary', onclick: () => pickFile('.json,.txt,.pdf,.png,.jpg,.jpeg,.webp', f => busy(uploadInvoiceButton, () => uploadInvoice(f)))}, '↑ Upload invoice');
  const uploadPoButton = h('button', {type: 'button', class: 'button secondary', onclick: () => pickFile('.json,.pdf,.png,.jpg,.jpeg,.webp', f => busy(uploadPoButton, () => uploadPo(f)))}, '↑ Upload purchase order');
  const refreshButton = h('button', {type: 'button', class: 'button secondary', onclick: () => busy(refreshButton, refresh)}, '↻ Refresh');
  const section = h('section', {id: 'server-inbox'},
    h('section', {class: 'panel'},
      h('div', {class: 'panel-heading'},
        h('div', {}, h('h2', {}, 'Shared invoice inbox'), h('p', {}, 'Invoices stored in your organisation workspace. Validation runs on the server; AI investigations need a reviewer’s approval before anything changes.')),
        h('div', {class: 'actions'}, canAct && uploadInvoiceButton, canAct && uploadPoButton, refreshButton)),
      canAct && h('p', {class: 'match-note'}, 'Uploads: PDF, image, JSON or labeled TXT up to 3 MB. Fields are extracted in this browser and you review them before upload; the server re-validates everything.'),
      h('div', {class: 'table-scroll'}, h('table', {}, h('thead', {}, h('tr', {}, ['INVOICE / SUPPLIER', 'AMOUNT', 'PROCESSING', 'OPEN DISCREPANCIES', 'AI INVESTIGATION', ''].map(t => h('th', {}, t)))), rows))),
    live);
  root.prepend(section);

  function renderRows() {
    fill(rows, ...(invoices.length ? invoices.map(inv => {
      const [label, cls] = INVOICE_STATUS[inv.status] ?? [words(inv.status), ''];
      return h('tr', {},
        h('td', {}, h('div', {class: 'vendor'}, h('span', {class: 'file-icon', 'aria-hidden': 'true'}, '▤'), h('div', {}, h('strong', {}, inv.invoice_number ?? 'No invoice number'), h('small', {}, inv.supplier_name ?? 'Unknown supplier')))),
        h('td', {}, formatMoney(inv.total_amount, inv.currency ?? 'USD')),
        h('td', {}, h('span', {class: `status ${cls}`}, label)),
        h('td', {}, String(inv.open_discrepancy_count)),
        h('td', {}, inv.investigation_status ? AI_STATUS[inv.investigation_status] ?? words(inv.investigation_status) : 'Not investigated'),
        h('td', {}, h('button', {type: 'button', class: 'row-action', onclick: () => openDetail(inv.id)}, 'Open ↗')));
    }) : [h('tr', {}, h('td', {colspan: '6', class: 'empty'}, canAct ? 'No invoices yet. Upload an invoice to start.' : 'No invoices yet.'))]));
  }
  async function refresh() {
    try { invoices = await api.get('/api/invoices'); if (!stopped) renderRows(); } catch (e) { fail(e); }
  }

  let lastUpload = null; // kept after a transient failure so "Try again" resends the same body (same Idempotency-Key)
  async function sendInvoice(body) {
    try {
      const inv = await api.send('POST', '/api/invoices', body);
      lastUpload = null;
      say(`Uploaded ${inv.invoice_number ?? inv.id}: ${(INVOICE_STATUS[inv.status] ?? [inv.status])[0]}, ${inv.open_discrepancy_count} open discrepanc${inv.open_discrepancy_count === 1 ? 'y' : 'ies'}.`);
      await refresh();
      await openDetail(inv.id);
    } catch (e) {
      lastUpload = ['network', 'internal', 'rate_limited'].includes(e.code) ? body : null;
      fail(e);
      if (lastUpload) live.append(' ', h('button', {type: 'button', class: 'text-button', onclick: ev => busy(ev.currentTarget, () => sendInvoice(lastUpload))}, 'Try the upload again'));
    }
  }
  async function uploadInvoice(file, supersedesId) {
    try {
      say(`Reading ${file.name}…`);
      const r = await readInvoiceFile(file, say);
      if (!r) { say('Upload cancelled.'); return; }
      const body = {file: await fileUpload({name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer())}),
        extracted: extractedInvoice(r), ...(supersedesId ? {supersedes_invoice_id: supersedesId} : {})};
      say(`Uploading ${file.name}…`);
      await sendInvoice(body);
    } catch (e) { fail(e); }
  }
  async function uploadPo(file) {
    try {
      let d;
      if (/\.json$/i.test(file.name)) {
        if (file.size > 500000) throw Error('JSON purchase orders must be under 500 KB.');
        try { d = JSON.parse(await file.text()); } catch { throw Error('This JSON file could not be read.'); }
        d = validateDocument(d, 'purchase_order');
      } else d = await extractAndReview(file, 'purchase_order', say);
      if (!d) { say('Purchase order upload cancelled.'); return; }
      const po = await api.send('POST', '/api/purchase-orders', purchaseOrderRequest(d));
      say(`Purchase order ${po?.purchase_order_number ?? ''} saved. Invoices that reference it are being re-validated; refresh in a moment.`);
      await refresh();
    } catch (e) { fail(e); }
  }

  // ---------- detail dialog ----------
  let detail = null;
  async function openDetail(id) {
    detail?.close();
    const dialog = h('dialog', {class: 'server-detail', 'aria-labelledby': 'server-detail-title'});
    const d = detail = {dialog, ctrl: new AbortController(), id, closed: false, live: h('div', {class: 'match-message', role: 'status', 'aria-live': 'polite'}), close: () => dialog.open && dialog.close()};
    dialog.addEventListener('close', () => { d.closed = true; d.ctrl.abort(); dialog.remove(); if (detail === d) detail = null; });
    document.body.append(dialog);
    dialog.append(h('div', {class: 'dialog-top'}, h('h2', {id: 'server-detail-title'}, 'Loading invoice…'), h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close invoice', onclick: () => dialog.close()}, '×')), d.live);
    dialog.showModal();
    await loadDetail(d);
  }

  async function loadDetail(d) {
    let inv, discrepancies, pos = [];
    try {
      [inv, discrepancies] = await Promise.all([api.get(`/api/invoices/${d.id}`), api.get(`/api/invoices/${d.id}/discrepancies`)]);
      if (inv.purchase_order_id) pos = await api.get('/api/purchase-orders');
    } catch (e) { d.live.textContent = e.message; return; }
    if (d.closed) return;
    // No route returns a discrepancy's investigations, so the latest one is found through its audit history.
    const histories = await Promise.all(discrepancies.map(x => api.get(`/api/discrepancies/${x.id}/history`).catch(() => null)));
    const investigations = await Promise.all(histories.map(hst => {
      const ev = hst?.audit.filter(a => a.event_type === 'investigation.requested').at(-1);
      return ev ? api.get(`/api/investigations/${ev.target_id}`).catch(() => null) : null;
    }));
    if (d.closed) return;
    d.ctrl.abort(); // stop pollers from the previous render of this dialog
    Object.assign(d, {ctrl: new AbortController(), inv, po: pos.find(p => p.id === inv.purchase_order_id) ?? null});
    renderDetail(d, discrepancies, investigations);
  }

  function renderDetail(d, discrepancies, investigations) {
    const {inv, po} = d, cur = inv.currency ?? 'USD';
    const evidenceBox = h('div', {class: 'evidence-viewer', tabindex: '-1', hidden: true});
    const docUrl = safeUrl(inv.document_url);
    const original = invoices.find(x => x.id === inv.supersedes_invoice_id), replacement = invoices.find(x => x.supersedes_invoice_id === inv.id);
    const link = (other, prefix) => h('p', {class: 'check'}, prefix, ' ', h('button', {type: 'button', class: 'text-button', onclick: () => openDetail(other.id)}, `${other.invoice_number ?? 'invoice'} (${(INVOICE_STATUS[other.status] ?? [other.status])[0]}) ↗`));
    const field = (name, label, value) => h('tr', {'data-ev': `document:${inv.id}#${name}`}, h('td', {}, label), h('td', {}, h('strong', {}, value ?? 'Not extracted')));
    const lineRows = (prefix, ls) => ls.map(l => h('tr', {'data-ev': `${prefix}:${l.id}`}, h('td', {}, h('small', {}, `Line ${l.line_number} · ${l.sku ?? 'no SKU'}`), h('strong', {}, l.description)),
      h('td', {}, String(l.quantity)), h('td', {}, formatMoney(l.unit_price, cur)), h('td', {}, formatMoney(l.line_total, cur))));
    const lineTable = (prefix, ls, ev) => h('table', {}, h('thead', {}, h('tr', {}, ['LINE / ITEM', 'QTY', 'UNIT', 'AMOUNT'].map(t => h('th', {}, t)))), h('tbody', {'data-ev': ev}, lineRows(prefix, ls)));

    const invoiceCard = h('article', {class: 'source-card', 'data-ev': `invoice:${inv.id}`},
      h('div', {class: 'source-heading'}, h('span', {class: 'eyebrow'}, 'INVOICE'), h('span', {class: `status ${(INVOICE_STATUS[inv.status] ?? ['', ''])[1]}`}, (INVOICE_STATUS[inv.status] ?? [words(inv.status)])[0])),
      h('h3', {}, inv.supplier_name ?? 'Unknown supplier'),
      original && link(original, 'Corrected invoice. It replaces'),
      replacement && link(replacement, 'Superseded. Replaced by corrected invoice'),
      !original && inv.supersedes_invoice_id && h('p', {class: 'check'}, 'Corrected invoice. It replaces an earlier invoice.'),
      h('table', {class: 'field-table'}, h('tbody', {},
        field('invoice_number', 'Invoice number', inv.invoice_number), field('invoice_date', 'Invoice date', inv.invoice_date), field('due_date', 'Due date', inv.due_date),
        field('po_reference', 'PO reference', inv.po_reference), field('currency', 'Currency', inv.currency),
        field('subtotal', 'Subtotal', inv.subtotal && formatMoney(inv.subtotal, cur)), field('tax_amount', 'Tax', inv.tax_amount && formatMoney(inv.tax_amount, cur)),
        field('total_amount', 'Total', inv.total_amount && formatMoney(inv.total_amount, cur)))),
      lineTable('invoice_line', inv.lines ?? [], `document:${inv.id}#lines`),
      h('p', {class: 'hint'}, `Extraction: ${inv.extraction?.method ?? 'unknown'}${inv.extraction?.missing?.length ? ` · missing ${inv.extraction.missing.join(', ')}` : ''}${inv.extraction?.uncertain?.length ? ` · entered by reviewer: ${inv.extraction.uncertain.join(', ')}` : ''}`),
      docUrl ? h('a', {href: docUrl, target: '_blank', rel: 'noopener noreferrer'}, 'Open original document ↗') : h('p', {class: 'hint'}, 'Original document link unavailable.'),
      canAct && inv.status !== 'superseded' && h('button', {type: 'button', class: 'button secondary', onclick: ev => { const b = ev.currentTarget; pickFile('.json,.txt,.pdf,.png,.jpg,.jpeg,.webp', f => busy(b, () => uploadInvoice(f, inv.id))); }}, '↑ Upload corrected invoice'));
    const poCard = po ? h('article', {class: 'source-card', 'data-ev': `po:${po.id}`},
      h('div', {class: 'source-heading'}, h('span', {class: 'eyebrow'}, 'PURCHASE ORDER'), h('span', {class: 'demo-badge'}, po.status.toUpperCase())),
      h('h3', {}, po.supplier_name), h('div', {class: 'source-meta'}, h('span', {}, po.purchase_order_number), h('span', {}, po.currency)),
      lineTable('po_line', po.lines, null),
      h('div', {class: 'source-totals'}, h('span', {}, `Tax ${formatMoney(po.tax_amount, po.currency)}`), h('strong', {}, `Total ${formatMoney(po.total_amount, po.currency)}`)))
      : h('article', {class: 'source-card'}, h('span', {class: 'eyebrow'}, 'PURCHASE ORDER'), h('p', {}, inv.po_reference ? `No purchase order ${inv.po_reference} is on file yet.` : 'The invoice has no PO reference.'));

    function showEvidence(item) {
      d.dialog.querySelectorAll('.evidence-highlight').forEach(el => el.classList.remove('evidence-highlight'));
      const target = [...d.dialog.querySelectorAll('[data-ev]')].find(el => el.getAttribute('data-ev') === item.id);
      const onThisInvoice = /^(invoice|invoice_line|document):/.test(item.id);
      fill(evidenceBox, h('span', {class: 'eyebrow'}, 'EVIDENCE'), h('strong', {}, evidenceText(item)), h('p', {}, item.value),
        target ? h('p', {class: 'hint'}, 'Highlighted in the documents above.') : h('p', {class: 'hint'}, item.missing ? 'Not available.' : 'This item refers to a record not shown in the documents above.'),
        onThisInvoice && docUrl && h('a', {href: item.page ? `${docUrl}#page=${item.page}` : docUrl, target: '_blank', rel: 'noopener noreferrer'}, item.page ? `Open original document at page ${item.page} ↗` : 'Open original document ↗'));
      evidenceBox.hidden = false;
      if (target) { target.classList.add('evidence-highlight'); target.scrollIntoView({behavior: 'smooth', block: 'center'}); }
      say(`Evidence: ${evidenceText(item)}${target ? ', highlighted' : ''}.`);
    }

    const cards = discrepancies.map((x, i) => discrepancyCard(d, x, investigations[i], cur, showEvidence));
    fill(d.dialog, 
      h('div', {class: 'dialog-top'}, h('div', {}, h('span', {class: 'eyebrow'}, 'SHARED WORKSPACE · INVOICE'), h('h2', {id: 'server-detail-title'}, `${inv.invoice_number ?? 'Invoice'} · ${inv.supplier_name ?? 'Unknown supplier'}`)),
        h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close invoice', onclick: () => d.dialog.close()}, '×')),
      h('div', {class: 'server-detail-body'},
        h('div', {class: 'pair-documents'}, invoiceCard, poCard), evidenceBox,
        h('h3', {}, `Discrepancies (${discrepancies.length})`),
        cards.length ? cards : h('p', {class: 'check ok'}, 'No discrepancies. The deterministic checks passed.')),
      d.live);
  }

  function discrepancyCard(d, x, investigation, cur, showEvidence) {
    let inv = investigation;
    const open = !CLOSED.includes(x.status);
    const panelHost = h('div');
    const status = h('p', {class: 'disc-status', role: 'status'});
    const notes = h('textarea', {name: 'notes', rows: '2', maxlength: '2000', 'aria-label': 'Decision notes', placeholder: 'What did you check? (recorded with your decision)'});
    const decide = (decision, label) => h('button', {type: 'button', class: decision === 'approved' ? 'button primary' : 'button secondary', 'data-decision': decision, onclick: ev => busy(ev.currentTarget, () => resolve(decision))}, label);
    const approveB = decide('approved', 'Approve recommendation'), rejectB = decide('rejected', 'Reject recommendation'), moreB = decide('more_info_requested', 'Request additional investigation');
    const investigateB = h('button', {type: 'button', class: 'button primary', onclick: ev => busy(ev.currentTarget, investigate)}, '✦ Investigate with AI');
    const draftHost = h('div'), historyHost = h('div');
    const card = h('article', {class: 'discrepancy-card', 'data-ev': `discrepancy:${x.id}`, tabindex: '-1'},
      h('div', {class: 'source-heading'}, h('strong', {}, words(x.discrepancy_type)), h('span', {class: `status ${open ? 'review' : 'approved'}`}, `${DISC_STATUS[x.status] ?? words(x.status)} · ${x.severity} severity`)),
      h('dl', {class: 'disc-values'},
        h('div', {}, h('dt', {}, 'EXPECTED'), h('dd', {}, x.expected_value ?? '—')),
        h('div', {}, h('dt', {}, 'OBSERVED'), h('dd', {}, x.observed_value ?? '—')),
        h('div', {}, h('dt', {}, 'DIFFERENCE'), h('dd', {}, x.difference_amount ? formatMoney(x.difference_amount, cur) : '—'))),
      canAct && open && investigateB, panelHost,
      canAct && open && h('div', {class: 'resolve-controls'}, h('label', {class: 'draft-label'}, 'Decision notes', notes), h('div', {class: 'actions'}, approveB, rejectB, moreB)),
      status,
      h('div', {class: 'actions'},
        canAct && h('button', {type: 'button', class: 'text-button', onclick: ev => busy(ev.currentTarget, draft)}, 'Draft supplier correction request'),
        h('button', {type: 'button', class: 'text-button', 'aria-expanded': 'false', onclick: ev => busy(ev.currentTarget, () => history(ev.currentTarget))}, 'View resolution history')),
      draftHost, historyHost);

    function sync() {
      const v = investigationView(inv);
      fill(panelHost, renderInvestigation(v, {canAct: canAct && open, onRetry: ev => busy(ev.currentTarget, investigate), onEvidence: showEvidence}));
      investigateB.hidden = v.state !== 'none';
      approveB.disabled = !v.result;
      rejectB.disabled = !v.result;
      approveB.title = v.result ? `Approves: ${ACTION_TEXT[v.result.action.code] ?? v.result.action.code}` : 'Needs a completed investigation';
      return v;
    }
    async function watch() {
      let last = sync().state;
      if (!investigationView(inv).polling) return;
      const done = await api.pollInvestigation(inv.id, {signal: d.ctrl.signal, onUpdate: next => {
        inv = next;
        const v = sync();
        if (v.state !== last) { last = v.state; say(`AI investigation for ${words(x.discrepancy_type)}: ${v.label}.`); }
      }}).catch(e => { status.textContent = e.message; return null; });
      if (done && !d.ctrl.signal.aborted && investigationView(done).polling) status.textContent = 'The investigation is still running. Reopen the invoice later to see the result.';
    }
    async function investigate() {
      try {
        inv = await api.send('POST', `/api/discrepancies/${x.id}/investigate`, {});
        say(`AI investigation for ${words(x.discrepancy_type)}: ${investigationView(inv).label}.`);
        watch();
      } catch (e) { await failed(e); }
    }
    async function resolve(decision) {
      const body = {decision, notes: notes.value.trim(), ...(inv?.id ? {investigation_id: inv.id} : {}), ...(decision === 'approved' ? {approved_action: inv?.result?.recommended_action} : {})};
      try {
        const r = await api.send('POST', `/api/discrepancies/${x.id}/resolve`, body);
        say(`Decision recorded. Discrepancy is now ${DISC_STATUS[r.discrepancy.status] ?? r.discrepancy.status}; invoice is ${(INVOICE_STATUS[r.invoice_status] ?? [r.invoice_status])[0]}.`);
        await reload();
      } catch (e) { await failed(e); }
    }
    async function draft() {
      try {
        const m = await api.send('POST', `/api/discrepancies/${x.id}/draft-message`, {});
        const copy = h('textarea', {rows: '12', class: 'draft-copy', value: m.body, 'aria-label': 'Editable copy of the draft'});
        fill(draftHost, h('div', {class: 'hold-card'},
          h('div', {class: 'source-heading'}, h('strong', {}, 'Supplier correction request'), h('span', {class: 'payment-hold'}, 'DRAFT ONLY, NOTHING IS SENT')),
          h('details', {}, h('summary', {}, `Stored draft (saved ${when(m.created_at)})`), h('pre', {}, m.body)),
          h('label', {class: 'draft-label'}, 'Editable copy', copy),
          h('button', {type: 'button', class: 'text-button', onclick: () => { download(copy.value, `correction-request-${x.id.slice(0, 8)}.txt`); say('Draft downloaded. Nothing was sent.'); }}, '↓ Download as text')));
        say('Draft saved. Nothing was sent to the supplier.');
      } catch (e) { status.textContent = e.message; say(e.message); }
    }
    async function history(button) {
      if (button.getAttribute('aria-expanded') === 'true') { fill(historyHost, ); button.setAttribute('aria-expanded', 'false'); return; }
      try {
        const hst = await api.get(`/api/discrepancies/${x.id}/history`);
        fill(historyHost, h('div', {class: 'case-history'},
          h('h4', {}, 'Decisions'),
          hst.resolutions.length ? hst.resolutions.map(r => h('div', {class: 'activity-item'}, h('strong', {}, words(r.approval_status)),
            r.approved_action ? ` · ${ACTION_TEXT[r.approved_action] ?? r.approved_action}` : '', r.reviewer_notes ? ` · “${r.reviewer_notes}”` : '', h('small', {}, `${when(r.created_at)} · reviewer ${r.reviewer_id.slice(0, 8)}`)))
            : h('p', {}, 'No decisions recorded yet.'),
          h('h4', {}, 'Audit trail'),
          hst.audit.map(a => h('div', {class: 'activity-item'}, words(a.event_type.replace('.', ' ')), h('small', {}, `${when(a.timestamp)} · ${a.actor_type}`)))));
        button.setAttribute('aria-expanded', 'true');
      } catch (e) { status.textContent = e.message; }
    }
    async function failed(e) {
      status.textContent = e.message;
      say(e.message);
      if (['forbidden', 'conflict', 'not_found'].includes(e.code)) await reload(e.message);
    }
    async function reload(keep) {
      await loadDetail(d);
      refresh();
      const again = [...d.dialog.querySelectorAll('.discrepancy-card')].find(el => el.getAttribute('data-ev') === `discrepancy:${x.id}`);
      if (again) { if (keep) again.querySelector('.disc-status').textContent = keep; again.focus(); }
    }
    watch();
    return card;
  }

  refresh();
  return {refresh, stop() { stopped = true; detail?.close(); section.remove(); }};
}
