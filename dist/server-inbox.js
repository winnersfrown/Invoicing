import {lineReviewReasons} from './extraction-validation.js';
import {percentageCents,toCents} from './arithmetic.js';
// Server-backed inbox, invoice detail, evidence viewer and resolution controls (signed-in mode only).
// The top half is pure request building (unit-tested); createServerInbox() is the DOM layer.
import {extractFile, parseExtractedText} from './extraction.js';
import {extractAndReview, reviewExisting} from './extraction-review.js';
import {validateDocument} from './matching-engine.js';
import {renderLineMatchReview} from './line-match-review.js';
import {ACTION_TEXT, alreadyApproved, decisionMessage, evidenceText, fill, formatMoney, h, investigationView, renderInvestigation} from './investigation-ui.js';

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
    const percentage = typeof l.ratePercent === 'number' && Number.isFinite(l.ratePercent);
    const basis = Number(l.quantity);
    if(percentage && (!(basis>0) || l.ratePercent<0)) throw Error(`Line ${i+1}: invalid percentage basis or rate.`);
    const q = percentage ? 1 : basis;
    if (!(q > 0 && q <= 100000)) throw Error(`Line ${i + 1}: quantity must be between 0 and 100,000.`);
    const computed = percentage ? percentageCents(toCents(basis),l.ratePercent) : null;
    const unit = toMoneyString(percentage ? (computed==null?null:computed/100) : l.unitPrice);
    if (unit == null) throw Error(`Line ${i + 1}: unit price is missing.`);
    return {sku: text(l.sku), description: String(l.description ?? '').trim().slice(0, 500), quantity: q, unit_price: unit, line_total: toMoneyString(l.amount), tax_amount: toMoneyString(l.taxAmount)};
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
 * Keep extraction confidence separate from the choices saved in the source review.
 */
export function extractedInvoice({method, read, final, sourceText = null}) {
  const out = {}, missing = [], uncertain = [], field_confidence = {}, reviewed_fields = [];
  for (const [field, get] of Object.entries(FIELDS)) {
    const value = get(final);
    out[field] = value;
    if (value == null) missing.push(field);
    else if (JSON.stringify(safe(get, read)) === JSON.stringify(value) && !hasExtractionRisk(read, field)) field_confidence[field] = 1;
    else if (!final?.extractionReviewed) uncertain.push(field);
    if (value != null && final?.extractionReviewed) reviewed_fields.push(field);
  }
  const present = Object.keys(FIELDS).length - missing.length;
  const supportLabels = {...read?.extraction?.fields, ...final?.extraction?.fields};
  if(final?.lineItemReview?.confirmed)supportLabels.lineItemReview=final.lineItemReview;
  const customer = text(final?.customer)?.slice(0, 250);
  if (customer) supportLabels.customer = {...supportLabels.customer, reviewedValue: customer};
  for(const field of ['shipping','discount']) {
    if (final?.[field]!=null) supportLabels[field]={...supportLabels[field],reviewedValue:toMoneyString(final[field])};
  }
  if(final?.taxInclusive===true) supportLabels.taxInclusive={reviewedValue:true};
  // Signed adjustments (charges, discounts, credits, payments) replace the single shipping/discount pair for server checks.
  if(Array.isArray(final?.adjustments)) supportLabels.adjustments={reviewedValue:final.adjustments.map(a=>({kind:a.kind,cents:Number.isSafeInteger(a.cents)?a.cents:null,appliesTo:a.appliesTo||'total'}))};
  if(final?.pricingCurrency&&final.pricingCurrency!==final.currency) supportLabels.pricingCurrency={reviewedValue:final.pricingCurrency};
  if(final?.pricingTotal!=null) supportLabels.pricingTotal={reviewedValue:toMoneyString(final.pricingTotal)};
  if(final?.exchangeRate) supportLabels.exchangeRate={reviewedValue:final.exchangeRate};
  if(final?.amountDue!=null) supportLabels.amountDue={reviewedValue:toMoneyString(final.amountDue)};

  return {
    supplier_name: out.supplier_name, invoice_number: out.invoice_number, invoice_date: isoDate(final?.date ?? final?.issued), due_date: isoDate(final?.due),
    po_reference: out.po_reference, currency: out.currency, subtotal: toMoneyString(final?.subtotal), tax_amount: out.tax_amount, total_amount: out.total_amount,
    lines: out.lines ?? [], source_text: sourceText == null ? null : String(sourceText).slice(0, 200000),
    extraction: {method, confidence: present ? Math.round(Object.keys(field_confidence).length / present * 100) / 100 : null, field_confidence, missing, uncertain, reviewed_fields, source_refs: sourceReferences(read), support_labels: supportLabels, confidence_meaning: 'Heuristic field agreement, not a calibrated probability.'},
  };
}
const FIELD_KEYS={supplier_name:'vendor',invoice_number:'number',po_reference:'poNumber',currency:'currency',tax_amount:'tax',total_amount:'total'};
function hasExtractionRisk(d, field){const entries=Object.entries(d?.extraction?.fields||{}).filter(([k])=>field==='lines'?k.startsWith('lines.'):k===FIELD_KEYS[field]);return entries.some(([,v])=>v.support!=='supported');}
function sourceReferences(d){
  const refs = Object.entries(d?.extraction?.fields ?? {}).flatMap(([key,v]) => {
    const e = v.evidence?.[0];
    return e ? [[key, {page: e.page, excerpt: e.text.slice(0,500)}]] : [];
  });
  const byPath = new Map(refs);
  for (const [field, path] of Object.entries(FIELD_KEYS)) if (byPath.has(path)) byPath.set(field, byPath.get(path));
  return Object.fromEntries(byPath);
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
const KIND_LABEL = {extraction_error: 'EXTRACTION ERROR', missing_document: 'MISSING DOCUMENT', review_requirement: 'REVIEW REQUIRED'};
const words = s => (s ? s[0].toUpperCase() + s.slice(1).replaceAll('_', ' ') : '');
const when = s => (s ? new Date(s).toLocaleString() : '');
const safeUrl = u => { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : null; } catch { return null; } };
const REVIEW_LABELS = {supplier_name: 'Supplier name', currency: 'Payable currency', po_reference: 'Purchase-order reference'};
/** One line per flagged field: why it is flagged and the document text it was read from. */
function fieldDetails(flagged, e, extraction) {
  return flagged.map(f => {
    const label = REVIEW_LABELS[f] ?? FIELD_LABELS[f] ?? words(f);
    const ref = extraction?.source_refs?.[f], confidence = extraction?.field_confidence?.[f];
    if (e.missing?.includes(f)) return `${label}: not found in the document.`;
    const read = ref?.excerpt ? `read from “${ref.excerpt}”${ref.page ? ` (page ${ref.page})` : ''}` : 'no source text was captured for it';
    return `${label}: ${read}${confidence != null ? `, confidence ${confidence}` : ''}.`;
  });
}
const FIELD_LABELS = {invoice_number: 'Invoice number', invoice_date: 'Invoice date', due_date: 'Due date', total_amount: 'Total', subtotal: 'Subtotal', tax_amount: 'Tax', lines: 'Line items'};
export function warningPresentation(warning, extraction = null) {
  const e = warning.deterministic_evidence ?? {};
  if (e.check === 'po_manually_unlinked') return {
    kind: 'review_requirement', group: 'Review required', title: 'Purchase order unlinked',
    message: `A reviewer unlinked ${e.po_reference}. This invoice will stay unlinked from that order.`,
    fields: ['po_reference'], manualReview: true,
  };
  if (e.check === 'po_supplier_identity') return {
    kind: 'review_requirement', group: 'Review required', title: e.review ? 'Confirm supplier identity' : 'Supplier mismatch',
    message: `Invoice supplier: ${warning.observed_value}. Purchase order ${e.po_reference} supplier: ${warning.expected_value}. Verify the supplier and PO reference before matching.`,
    fields: ['supplier_name', 'po_reference'], manualReview: true,
  };
  if (e.check === 'line_match_review') return {kind: 'review_requirement', group: 'Review required', title: 'Review suggested product matches'};
  if (warning.discrepancy_type === 'missing_purchase_order' || e.suspected_type === 'missing_purchase_order') {
    const reference = e.po_reference ?? warning.observed_value;
    return reference
      ? {kind: 'missing_document', group: 'Missing documents', title: 'Purchase order needed', message: `${reference} is referenced on the invoice. Upload the purchase order ${reference} to compare this invoice.`, upload: true}
      : {kind: 'review_requirement', group: 'Review required', title: 'Purchase-order reference missing', message: 'Check the original invoice for a purchase-order reference. Enter it here if listed.', fields: ['po_reference']};
  }
  if (warning.discrepancy_type === 'potential_extraction_error') {
    const flagged = [...new Set([...(e.missing ?? []), ...(e.uncertain ?? []), ...(e.unsure_fields ?? [])])];
    const fields = flagged.filter(f => Object.hasOwn(REVIEW_LABELS, f));
    const details = e.check === 'extraction' || !e.check ? fieldDetails(flagged, e, extraction) : undefined;
    if (flagged.length === 1 && fields[0] === 'currency') return {
      kind: 'review_requirement', group: 'Review required', title: 'Confirm payable currency', message: 'Check the intended currency against the invoice or supplier records.', fields, details,
    };
    if (flagged.length === 1 && flagged[0] === 'tax_amount' && e.missing?.includes('tax_amount')) return {
      kind: 'extraction_error', group: 'Review required', title: 'Invoice tax amount missing', message: e.tax_proposal?.reason || 'The invoice tax amount is unavailable. Review the source before comparing tax.', needsSourceReview: true,
    };
    const title = e.check === 'date_order' ? 'Review invoice dates'
      : ['currency_conversion', 'mixed_currency_po'].includes(e.check) ? 'Review currency details' : 'Review extracted fields';
    const message = e.check === 'extraction'
      ? `Check these fields against the original invoice: ${flagged.map(f => REVIEW_LABELS[f] ?? words(f)).join(', ')}.` : warning.observed_value;
    const kind = ['extraction', 'financial_inputs'].includes(e.check) || !e.check ? 'extraction_error' : 'review_requirement';
    return {kind, group: 'Review required', title, message, fields, details, needsSourceReview: !flagged.length || fields.length !== flagged.length};
  }
  return {kind: 'discrepancy', group: 'Discrepancies', title: words(warning.discrepancy_type)};
}
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
    const final=lineReviewReasons(d,undefined,true).length
      ? await reviewExisting({...d,lines:d.lines||[]},source) : d;
    return final && {method:'json',read:d,final,sourceText:source};
  }
  let source, layout=[], method = 'labeled_text';
  if (/\.txt$/i.test(file.name)) source = await file.text();
  else {
    let ocr = false;
    const extracted = await extractFile(file, m => { if (/OCR|image text/i.test(m)) ocr = true; progress(m); }, {detailed:true});
    source=extracted.text; layout=extracted.layout;
    method = /\.pdf$/i.test(file.name) && !ocr ? 'pdf_text' : 'ocr';
  }
  const read = parseExtractedText(source, 'invoice', layout);
  const final = await reviewExisting(structuredClone(read), source, /\.txt$/i.test(file.name) ? null : file);
  return final && {method, read, final, sourceText: source};
}

export function createServerInbox({api, root, onDetailClosed}) {
  let invoices = [], archivedInvoices = [], stopped = false;
  let refreshSequence = 0;
  const live = h('div', {class: 'match-message', role: 'status', 'aria-live': 'polite'});
  const say = msg => { live.textContent = msg; if (detail?.live) detail.live.textContent = msg; };
  const fail = e => say(e.message || String(e));
  const pickFile = (accept, onFile) => { const input = h('input', {type: 'file', accept, hidden: true, onchange: () => { const f = input.files[0]; input.remove(); if (f) onFile(f); }}); (document.querySelector('dialog[open]') ?? document.body).append(input); input.click(); };

  const rows = h('tbody');
  const archivedRows = h('tbody');
  const archiveTitle = h('h2', {}, 'Archived Invoices');
  const archivePanel = h('details', {class: 'panel archived-invoices'},
    h('summary', {}, archiveTitle),
    h('div', {class: 'table-scroll'}, h('table', {},
      h('thead', {}, h('tr', {}, ['INVOICE / SUPPLIER', 'AMOUNT', 'ARCHIVED', ''].map(label => h('th', {}, label)))), archivedRows)));
  const uploadInvoiceButton = h('button', {type: 'button', class: 'button primary', onclick: () => pickFile('.json,.txt,.pdf,.png,.jpg,.jpeg,.webp', f => busy(uploadInvoiceButton, () => uploadInvoice(f)))}, '↑ Upload invoice');
  function choosePurchaseOrder(button, onUploaded, notify = say) {
    pickFile('.json,.pdf,.png,.jpg,.jpeg,.webp', file => busy(button, async () => {
      if (await uploadPo(file, null, notify)) await onUploaded?.();
    }));
  }
  const uploadPoButton = h('button', {type: 'button', class: 'button secondary', onclick: ev => choosePurchaseOrder(ev.currentTarget)}, '↑ Upload purchase order');
  const refreshButton = h('button', {type: 'button', class: 'button secondary', onclick: () => busy(refreshButton, refresh)}, '↻ Refresh');
  const section = h('section', {id: 'server-inbox'},
    h('section', {class: 'panel'},
      h('div', {class: 'panel-heading'},
        h('div', {}, h('h2', {}, 'Workspace invoice inbox'), h('p', {}, 'Open an invoice to review its purchase order and resolve discrepancies.')),
        h('div', {class: 'actions'}, uploadInvoiceButton, uploadPoButton, refreshButton)),
      h('p', {class: 'match-note'}, 'Uploads: PDF, image, JSON or labeled TXT up to 3 MB. Fields are extracted in this browser and you review them before upload; the server re-validates everything.'),
      h('div', {class: 'table-scroll'}, h('table', {}, h('thead', {}, h('tr', {}, ['INVOICE / SUPPLIER', 'AMOUNT', 'PROCESSING', 'OPEN FINDINGS', 'AI INVESTIGATION', ''].map(t => h('th', {}, t)))), rows))),
    archivePanel, live);
  root.prepend(section);

  function identityCell(inv) {
    return h('td', {}, h('div', {class: 'vendor'}, h('span', {class: 'file-icon', 'aria-hidden': 'true'}, '▤'),
      h('div', {}, h('strong', {}, inv.invoice_number ?? 'No invoice number'), h('small', {}, inv.supplier_name ?? 'Unknown supplier'))));
  }
  function openCell(inv) {
    return h('td', {}, h('button', {type: 'button', class: 'row-action', onclick: () => openDetail(inv.id)}, 'Open ↗'));
  }
  function renderRows() {
    fill(rows, ...(invoices.length ? invoices.map(inv => {
      const [label, cls] = INVOICE_STATUS[inv.status] ?? [words(inv.status), ''];
      return h('tr', {},
        identityCell(inv),
        h('td', {}, formatMoney(inv.total_amount, inv.currency ?? 'USD')),
        h('td', {}, h('span', {class: `status ${cls}`}, label)),
        h('td', {}, String(inv.open_discrepancy_count)),
        h('td', {}, inv.investigation_status ? AI_STATUS[inv.investigation_status] ?? words(inv.investigation_status) : 'Not investigated'),
        openCell(inv));
    }) : [h('tr', {}, h('td', {colspan: '6', class: 'empty'}, 'No invoices yet. Upload an invoice to start.'))]));
  }
  async function refresh() {
    if (stopped) return;
    const sequence = ++refreshSequence;
    try {
      const lists = await Promise.all([api.get('/api/invoices'), api.get('/api/invoices/archived')]);
      if (stopped || sequence !== refreshSequence) return;
      [invoices, archivedInvoices] = lists;
      renderRows();
      archiveTitle.textContent = `Archived Invoices (${archivedInvoices.length})`;
      fill(archivedRows, archivedInvoices.length ? archivedInvoices.map(inv => h('tr', {},
        identityCell(inv), h('td', {}, formatMoney(inv.total_amount, inv.currency ?? 'USD')),
        h('td', {}, when(inv.archived_at)), openCell(inv)))
        : h('tr', {}, h('td', {colspan: '4', class: 'empty'}, 'No archived invoices.')));
    } catch (e) {
      if (!stopped && sequence === refreshSequence) fail(e);
    }
  }

  let lastUpload = null; // kept after a transient failure so "Try again" resends the same body (same Idempotency-Key)
  async function sendInvoice(body) {
    try {
      const inv = await api.send('POST', '/api/invoices', body);
      lastUpload = null;
      say(`Uploaded ${inv.invoice_number ?? inv.id}: ${inv.open_discrepancy_count} open finding${inv.open_discrepancy_count === 1 ? '' : 's'}.`);
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
  async function uploadPo(file, detailView = null, notify = say) {
    try {
      let d;
      if (/\.json$/i.test(file.name)) {
        if (file.size > 500000) throw Error('JSON purchase orders must be under 500 KB.');
        try { d = JSON.parse(await file.text()); } catch { throw Error('This JSON file could not be read.'); }
        d = validateDocument(d, 'purchase_order');
      } else d = await extractAndReview(file, 'purchase_order', notify);
      if (!d) { notify('Purchase order upload cancelled.'); return; }
      const po = await api.send('POST', '/api/purchase-orders', purchaseOrderRequest(d));
      if (detailView && !detailView.closed) {
        if (po.purchase_order_number.toLowerCase() === detailView.inv.po_reference?.toLowerCase()) {
          await api.send('POST', `/api/invoices/${detailView.id}/process`);
        }
        await loadDetail(detailView);
      }
      notify(`Purchase order ${po?.purchase_order_number ?? ''} saved.`);
      await refresh();
      return true;
    } catch (e) { notify(e.message); }
  }

  // ---------- detail dialog ----------
  function reviewField(d, field) {
    const inv = d.inv;
    const choice = h('select', {'aria-label': 'Field to review'},
      Object.entries(REVIEW_LABELS).map(([value, label]) => h('option', {value, selected: value === field}, label)));
    const value = h('input', {'aria-label': 'Reviewed value'});
    const error = h('p', {role: 'alert'});
    const sync = () => {
      value.value = inv[choice.value] ?? '';
      value.maxLength = choice.value === 'currency' ? 3 : 150;
      value.pattern = choice.value === 'currency' ? '[A-Za-z]{3}' : '';
      if (!value.pattern) value.removeAttribute('pattern');
      value.placeholder = choice.value === 'currency' ? 'USD, CAD, EUR…' : REVIEW_LABELS[choice.value];
      value.required = choice.value !== 'po_reference';
    };
    choice.addEventListener('change', sync);
    const dialog = h('dialog', {class: 'ocr-dialog', 'aria-labelledby': 'field-review-title'});
    const save = h('button', {type: 'submit', class: 'button primary'}, 'Save field review');
    const source = safeUrl(inv.document_url);
    dialog.append(h('form', {class: 'source-card', onsubmit: ev => {
      ev.preventDefault();
      busy(save, async () => {
        try {
          await api.send('POST', `/api/invoices/${inv.id}/review-fields`, {
            updated_at: inv.updated_at, values: {[choice.value]: value.value.trim() || null},
          });
          dialog.close();
          await loadDetail(d);
          await refresh();
          say('Field review saved. Invoice rechecked.');
        } catch (e) {
          error.textContent = e.message;
          if (e.code === 'conflict') {
            dialog.close();
            await loadDetail(d);
            say(e.message);
          }
        }
      });
    }}, h('h2', {id: 'field-review-title'}, 'Review invoice field'),
    source && h('a', {href: source, target: '_blank', rel: 'noopener noreferrer'}, 'Open original document ↗'),
    h('label', {class: 'draft-label'}, 'Field', choice), h('label', {class: 'draft-label'}, 'Value from the document or supplier records', value),
    error, h('div', {class: 'actions'}, save, h('button', {type: 'button', class: 'button secondary', onclick: () => dialog.close()}, 'Cancel'))));
    d.dialog.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    sync();
    dialog.showModal();
    value.focus();
  }

  let detail = null;
  async function openDetail(id, target) {
    if (stopped) return;
    detail?.close();
    const dialog = h('dialog', {class: 'server-detail', 'aria-labelledby': 'server-detail-title'});
    const d = detail = {dialog, ctrl: new AbortController(), id, closed: false, live: h('div', {class: 'match-message', role: 'status', 'aria-live': 'polite'}), close: () => dialog.open && dialog.close()};
    dialog.addEventListener('close', () => {
      d.closed = true;
      d.ctrl.abort();
      dialog.remove();
      if (detail === d) {
        detail = null;
        if (!stopped) onDetailClosed?.();
      }
    });
    document.body.append(dialog);
    dialog.append(h('div', {class: 'dialog-top'}, h('h2', {id: 'server-detail-title'}, 'Loading invoice…'), h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close invoice', onclick: () => dialog.close()}, '×')), d.live);
    dialog.showModal();
    await loadDetail(d);
    if (!d.closed && target) {
      const item = [...dialog.querySelectorAll('[data-ev]')].find(el => el.dataset.ev === target);
      if (item) {
        const parent = item.closest('details');
        if (parent) parent.open = true;
        item.scrollIntoView({block: 'center'});
        item.focus({preventScroll: true});
      }
    }
  }

  function confirmManagement(d, {title, message, action, body, success}) {
    const error = h('p', {class: 'match-error', role: 'alert', hidden: true});
    const dialog = h('dialog', {class: 'invoice-management-dialog', 'aria-labelledby': 'invoice-management-title', 'aria-describedby': 'invoice-management-description'});
    const cancel = h('button', {type: 'button', class: 'button secondary', autofocus: true, onclick: () => dialog.close()}, 'Cancel');
    const confirm = h('button', {type: 'button', class: 'button primary', onclick: ev => busy(ev.currentTarget, async () => {
      cancel.disabled = true;
      try {
        await api.send('POST', `/api/invoices/${d.id}/${action}`, body);
      } catch (e) {
        if (e.code === 'conflict') {
          dialog.close();
          await loadDetail(d);
          say(e.message);
        } else {
          error.textContent = e.message;
          error.hidden = false;
        }
        return;
      } finally { cancel.disabled = false; }
      dialog.close();
      if (action === 'archive') archivePanel.open = true;
      await Promise.all([refresh(), loadDetail(d)]);
      say(success);
    })}, title);
    dialog.addEventListener('cancel', e => { if (confirm.disabled) e.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), {once: true});
    dialog.append(h('div', {},
      h('h2', {id: 'invoice-management-title'}, title),
      h('div', {id: 'invoice-management-description'},
        h('p', {}, h('strong', {}, `${d.inv.invoice_number ?? 'Unnumbered invoice'} · ${d.inv.supplier_name ?? 'Unknown supplier'}`)),
        h('p', {}, message)),
      error, h('div', {class: 'actions'}, cancel, confirm)));
    document.body.append(dialog);
    dialog.showModal();
  }

  async function loadDetail(d) {
    let inv, discrepancies, management, po = null;
    try {
      [inv, discrepancies, management] = await Promise.all([
        api.get(`/api/invoices/${d.id}`), api.get(`/api/invoices/${d.id}/discrepancies`), api.get(`/api/invoices/${d.id}/history`),
      ]);
      if (inv.purchase_order_id) po = await api.get(`/api/purchase-orders/${inv.purchase_order_id}`);
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
    Object.assign(d, {lastDecision: new Map(discrepancies.map((x, i) => [x.id, histories[i]?.resolutions.at(-1) ?? null])), ctrl: new AbortController(), inv, po});
    renderDetail(d, discrepancies, investigations, management);
    d.notice = null; // shown once, on the card it was recorded for
  }

  function renderDetail(d, discrepancies, investigations, management) {
    const {inv, po} = d, cur = inv.currency ?? 'USD';
    const pricing = inv.extraction?.support_labels?.pricingCurrency?.reviewedValue;
    const pricingCur = typeof pricing === 'string' && /^[A-Z]{3}$/i.test(pricing) ? pricing.toUpperCase() : cur;
    const customer = inv.extraction?.support_labels?.customer?.reviewedValue;
    const evidenceBox = h('div', {class: 'evidence-viewer', tabindex: '-1', hidden: true});
    const docUrl = safeUrl(inv.document_url);
    const archived = Boolean(inv.archived_at);
    const editable = !archived && !['rejected', 'superseded'].includes(inv.status);
    const lifecycle = archived ? {
      title: 'Restore Invoice', action: 'restore',
      message: 'Return this invoice to the active inbox and recheck matching and duplicates.',
      success: 'Invoice restored to the active inbox.',
    } : {
      title: 'Archive Invoice', action: 'archive',
      message: 'Move this invoice out of the active inbox. Its original document, findings, and reviewer decisions will remain available.',
      success: 'Invoice moved to Archived Invoices.',
    };
    const managementButton = (config) => h('button', {type: 'button', class: 'button secondary',
      onclick: () => confirmManagement(d, config)}, config.title);
    const recheck = h('button', {type: 'button', class: 'button secondary', onclick: ev => busy(ev.currentTarget, async () => {
      try {
        await api.send('POST', `/api/invoices/${inv.id}/process`);
        await loadDetail(d);
        await refresh();
        say('Line matches rechecked.');
      } catch (e) { fail(e); }
    })}, 'Compare invoice & PO');
    const correct = field => h('button', {type: 'button', class: 'button secondary', onclick: () => reviewField(d, field)}, field === 'currency' ? 'Confirm currency' : field === 'po_reference' ? 'Correct PO reference' : 'Correct field');
    const correctedUpload = () => h('button', {type: 'button', class: 'button secondary', onclick: ev => {
      const b = ev.currentTarget;
      pickFile('.json,.txt,.pdf,.png,.jpg,.jpeg,.webp', f => busy(b, () => uploadInvoice(f, inv.id)));
    }}, 'Upload corrected invoice');
    const uploadOrder = () => h('button', {type: 'button', class: 'button secondary', onclick: ev => {
      const b = ev.currentTarget;
      pickFile('.json,.pdf,.png,.jpg,.jpeg,.webp', f => busy(b, () => uploadPo(f, d)));
    }}, 'Upload purchase order');
    const allInvoices = [...invoices, ...archivedInvoices];
    const original = allInvoices.find(x => x.id === inv.supersedes_invoice_id), replacement = allInvoices.find(x => x.supersedes_invoice_id === inv.id);
    const link = (other, prefix) => h('p', {class: 'check'}, prefix, ' ', h('button', {type: 'button', class: 'text-button', onclick: () => openDetail(other.id)}, `${other.invoice_number ?? 'invoice'} (${(INVOICE_STATUS[other.status] ?? [other.status])[0]}) ↗`));
    const field = (name, label, value) => h('tr', {'data-ev': `document:${inv.id}#${name}`}, h('td', {}, label), h('td', {}, h('strong', {}, value ?? 'Not extracted')));
    const lineRows = (prefix, ls, currency) => ls.map(l => h('tr', {'data-ev': `${prefix}:${l.id}`}, h('td', {}, h('small', {}, `Line ${l.line_number} · ${l.sku ?? 'no SKU'}`), h('strong', {}, l.description)),
      h('td', {}, String(l.quantity)), h('td', {}, formatMoney(l.unit_price, currency)), h('td', {}, formatMoney(l.line_total, currency))));
    const lineTable = (prefix, ls, ev, currency) => h('table', {}, h('thead', {}, h('tr', {}, ['LINE / ITEM', 'QTY', 'UNIT', 'AMOUNT'].map(t => h('th', {}, t)))), h('tbody', {'data-ev': ev}, lineRows(prefix, ls, currency)));

    const invoiceCard = h('article', {class: 'source-card', 'data-ev': `invoice:${inv.id}`},
      h('div', {class: 'source-heading'}, h('span', {class: 'eyebrow'}, 'INVOICE'), h('span', {class: `status ${(INVOICE_STATUS[inv.status] ?? ['', ''])[1]}`}, (INVOICE_STATUS[inv.status] ?? [words(inv.status)])[0])),
      h('h3', {}, inv.supplier_name ?? 'Unknown supplier'),
      original && link(original, 'Corrected invoice. It replaces'),
      replacement && link(replacement, 'Superseded. Replaced by corrected invoice'),
      !original && inv.supersedes_invoice_id && h('p', {class: 'check'}, 'Corrected invoice. It replaces an earlier invoice.'),
      h('table', {class: 'field-table'}, h('tbody', {},
        typeof customer === 'string' && field('customer', 'Customer (billed to)', customer),
        field('invoice_number', 'Invoice number', inv.invoice_number), field('invoice_date', 'Invoice date', inv.invoice_date), field('due_date', 'Due date', inv.due_date),
        field('po_reference', 'PO reference', inv.po_reference), field('currency', 'Payable currency', inv.currency),
        pricingCur !== cur && field('pricingCurrency', 'Pricing currency', pricingCur),
        field('subtotal', 'Subtotal', inv.subtotal && formatMoney(inv.subtotal, pricingCur)), field('tax_amount', 'Tax', inv.tax_amount && formatMoney(inv.tax_amount, pricingCur)),
        inv.extraction?.support_labels?.shipping?.reviewedValue && field('shipping', 'Shipping / freight', formatMoney(inv.extraction.support_labels.shipping.reviewedValue,pricingCur)),
        inv.extraction?.support_labels?.discount?.reviewedValue && field('discount', 'Discount', formatMoney(inv.extraction.support_labels.discount.reviewedValue,pricingCur)),
        pricingCur !== cur && field('pricingTotal', 'Pricing total', inv.extraction?.support_labels?.pricingTotal?.reviewedValue && formatMoney(inv.extraction.support_labels.pricingTotal.reviewedValue, pricingCur)),
        field('total_amount', 'Total', inv.total_amount && formatMoney(inv.total_amount, cur)))),
      lineTable('invoice_line', inv.lines ?? [], `document:${inv.id}#lines`, pricingCur),
      h('p', {class: 'hint'}, inv.extraction?.reviewed_fields?.includes('currency') ? `Currency confirmed by reviewer · ${inv.currency}` : `Extraction: ${inv.extraction?.method ?? 'unknown'}`),
      docUrl ? h('a', {href: docUrl, target: '_blank', rel: 'noopener noreferrer'}, 'Open original document ↗') : h('p', {class: 'hint'}, 'Original document link unavailable.'),
      editable && h('div', {class: 'actions'}, correct('supplier_name'), correctedUpload(), recheck));
    const poCard = po ? h('article', {class: 'source-card', 'data-ev': `po:${po.id}`},
      h('div', {class: 'source-heading'}, h('span', {class: 'eyebrow'}, 'PURCHASE ORDER'), h('span', {class: 'demo-badge'}, po.status.toUpperCase())),
      h('h3', {}, po.supplier_name), h('div', {class: 'source-meta'}, h('span', {}, po.purchase_order_number), h('span', {}, po.currency)),
      lineTable('po_line', po.lines, null, po.currency),
      h('div', {class: 'source-totals'}, h('span', {}, `Tax ${formatMoney(po.tax_amount, po.currency)}`), h('strong', {}, `Total ${formatMoney(po.total_amount, po.currency)}`)),
      editable && managementButton({
        title: 'Unlink Purchase Order', action: 'unlink-purchase-order', body: {purchase_order_id: po.id},
        message: `Remove the link to ${po.purchase_order_number} from ${po.supplier_name}. The order stays in the workspace and Sorikano will recheck this invoice’s findings.`,
        success: 'Purchase order unlinked. Invoice findings rechecked.',
      }))
      : h('article', {class: 'source-card'}, h('span', {class: 'eyebrow'}, 'PURCHASE ORDER'), h('p', {}, inv.po_reference ? `Reference on invoice: ${inv.po_reference}` : 'No PO reference saved.'));

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

    const groups = new Map();
    for (const [i, x] of discrepancies.entries()) {
      const view = warningPresentation(x, inv.extraction);
      const closed = CLOSED.includes(x.status);
      const group = closed ? 'Validation history' : view.group;
      const actions = editable && !closed ? (view.fields ?? []).map(correct) : [];
      if (editable && !closed && view.upload) actions.push(uploadOrder());
      if (editable && !closed && view.needsSourceReview) actions.push(correctedUpload());
      const evidence = x.deterministic_evidence;
      const summarize = lines => lines.map(line => ({...line, number: line.line_number}));
      const duplicate = x.discrepancy_type === 'duplicate_candidate' && evidence?.other_invoice_id;
      if (duplicate) actions.push(h('button', {type: 'button', class: 'button secondary', onclick: () => openDetail(evidence.other_invoice_id)}, 'Open suspected duplicate'));
      const card = evidence?.check === 'line_match_review' && !closed && po?.id === x.purchase_order_id
        ? renderLineMatchReview({
          candidates: evidence.candidates.map(c => ({invoiceLine: c.invoice_line_id, poLine: c.po_line_id, description: c.description, sameQuantity: c.same_quantity})),
          invoiceLines: summarize(inv.lines ?? []), poLines: summarize(po.lines),
          onReview: editable ? async (match, decision) => {
            try {
              await api.send('POST', `/api/invoices/${inv.id}/review-line-match`, {
                purchase_order_id: po.id, invoice_line_id: match.invoiceLine, po_line_id: match.poLine, decision,
              });
              await loadDetail(d);
              await refresh();
              say(decision === 'confirm' ? 'Product match confirmed. Line differences rechecked.' : 'Match rejected. Remaining candidates rechecked.');
            } catch (e) {
              if (e.code === 'conflict') await loadDetail(d);
              fail(e);
            }
          } : null,
        })
        : discrepancyCard(d, x, investigations[i], cur, showEvidence, view, actions);
      card.dataset.ev = `discrepancy:${x.id}`;
      card.tabIndex = -1;
      groups.set(group, [...(groups.get(group) ?? []), card]);
    }
    const sections = ['Review required', 'Missing documents', 'Discrepancies'].flatMap(group => groups.has(group)
      ? [h('h3', {}, group), ...groups.get(group)] : []);
    fill(d.dialog, 
      h('div', {class: 'dialog-top'}, h('div', {}, h('span', {class: 'eyebrow'}, 'PRIVATE WORKSPACE · INVOICE'), h('h2', {id: 'server-detail-title'}, `${inv.invoice_number ?? 'Invoice'} · ${inv.supplier_name ?? 'Unknown supplier'}`)),
        h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close invoice', onclick: () => d.dialog.close()}, '×')),
      h('div', {class: 'server-detail-body'},
        h('div', {class: 'actions invoice-management-actions'},
          archived && h('span', {class: 'status'}, `Archived ${when(inv.archived_at)}`), managementButton(lifecycle)),
        h('div', {class: 'pair-documents', 'data-ev': 'matching', tabindex: '-1'}, invoiceCard, poCard), evidenceBox,
        sections.length ? sections : h('p', {class: 'check ok'}, 'No open findings.'),
        groups.has('Validation history') && h('details', {}, h('summary', {}, 'Validation history'), groups.get('Validation history')),
        h('details', {'data-ev': 'invoice-history', tabindex: '-1'}, h('summary', {}, 'Invoice management history'),
          management.length ? management.map(event => h('div', {class: 'activity-item'},
            h('strong', {}, {'invoice.archived': 'Invoice archived', 'invoice.restored': 'Invoice restored',
              'invoice.purchase_order_unlinked': 'Purchase order unlinked'}[event.event_type]),
            h('small', {}, `${when(event.timestamp)} · reviewer ${event.actor_id}`)))
            : h('p', {}, 'No archive, restore, or unlink actions recorded.'))),
      d.live);
  }

  function discrepancyCard(d, x, investigation, cur, showEvidence, view, actions) {
    let inv = view.group === 'Review required' && investigation?.prompt_version === 'investigate-v1' ? null : investigation;
    const open = !CLOSED.includes(x.status);
    const actionable = open && !d.inv.archived_at && !['rejected', 'superseded'].includes(d.inv.status) && !view.manualReview;
    const panelHost = h('div');
    const status = h('p', {class: 'disc-status', role: 'status'});
    const notes = h('textarea', {name: 'notes', rows: '2', maxlength: '2000', 'aria-label': 'Decision notes', placeholder: 'What did you check? (recorded with your decision)'});
    const decide = (decision, label) => h('button', {type: 'button', class: decision === 'approved' ? 'button primary' : 'button secondary', 'data-decision': decision, onclick: ev => busy(ev.currentTarget, () => resolve(decision))}, label);
    const approveB = decide('approved', 'Approve recommendation'), rejectB = decide('rejected', 'Reject recommendation'), moreB = decide('more_info_requested', 'Request additional investigation');
    const investigateB = h('button', {type: 'button', class: 'button primary', onclick: ev => busy(ev.currentTarget, investigate)}, '✦ Investigate with AI');
    const draftHost = h('div'), historyHost = h('div');
    const pending = d.notice?.id === x.id ? d.notice : null; // set by resolve(); the card is rebuilt from server state after a decision
    const notice = pending && h('div', {class: 'decision-saved', role: 'status'}, h('p', {}, pending.message),
      h('div', {class: 'actions'}, ...stepButtons(pending.step)));
    function stepButtons(step) {
      const first = d.inv.extraction?.missing?.find(f => REVIEW_LABELS[f]) ?? d.inv.extraction?.uncertain?.find(f => REVIEW_LABELS[f]) ?? 'currency';
      const b = (label, fn) => h('button', {type: 'button', class: 'button secondary', onclick: fn}, label);
      const doc = safeUrl(d.inv.document_url);
      return {
        correct_field: [b('Correct field', () => reviewField(d, first))],
        review_extraction: [doc && b('Review extraction', () => window.open(doc, '_blank', 'noopener,noreferrer')), b('Correct field', () => reviewField(d, first))],
        upload_po: [b('Upload purchase order', ev => pickFile('.json,.pdf,.png,.jpg,.jpeg,.webp', f => busy(ev.currentTarget, () => uploadPo(f, d))))],
      }[step?.action] ?? [];
    }
    const card = h('article', {class: 'discrepancy-card', 'data-ev': `discrepancy:${x.id}`, tabindex: '-1'},
      h('div', {class: 'source-heading'}, h('strong', {}, view.title), h('span', {class: `status ${open ? 'review' : 'approved'}`}, view.group === 'Discrepancies' ? `${DISC_STATUS[x.status] ?? words(x.status)} · ${x.severity} severity` : DISC_STATUS[x.status])),
      view.kind && view.kind !== 'discrepancy' && h('small', {class: 'eyebrow warning-kind'}, KIND_LABEL[view.kind]),
      view.message && h('p', {}, view.message),
      x.discrepancy_type === 'duplicate_candidate' && Array.isArray(x.deterministic_evidence?.evidence)
        && h('ul', {class: 'warning-details'}, x.deterministic_evidence.evidence.map(reason => h('li', {}, reason))),
      view.details && h('ul', {class: 'warning-details'}, view.details.map(t => h('li', {}, t))),
      x.deterministic_evidence?.match_basis === 'reviewer_confirmed' && h('p', {},
        `${x.deterministic_evidence.line.description} · ${x.deterministic_evidence.line.invoice.sku} ↔ ${x.deterministic_evidence.line.po.sku} · Confirmed by reviewer`),
      actions.length > 0 && h('div', {class: 'actions'}, actions),
      view.group === 'Discrepancies' && h('dl', {class: 'disc-values'},
        h('div', {}, h('dt', {}, 'EXPECTED'), h('dd', {}, x.expected_value ?? '—')),
        h('div', {}, h('dt', {}, 'OBSERVED'), h('dd', {}, x.observed_value ?? '—')),
        h('div', {}, h('dt', {}, 'DIFFERENCE'), h('dd', {}, x.difference_amount ? formatMoney(x.difference_amount, x.deterministic_evidence?.currency ?? cur) : '—'))),
      actionable && view.group !== 'Missing documents' && investigateB, panelHost,
      actionable && view.group !== 'Missing documents' && h('div', {class: 'resolve-controls'}, h('label', {class: 'draft-label'}, 'Decision notes', notes), h('div', {class: 'actions'}, approveB, rejectB, moreB)),
      status, notice,
      h('div', {class: 'actions'},
        actionable && d.po && view.group === 'Discrepancies' && h('button', {type: 'button', class: 'text-button', onclick: ev => busy(ev.currentTarget, draft)}, 'Draft supplier correction request'),
        h('button', {type: 'button', class: 'text-button', 'aria-expanded': 'false', onclick: ev => busy(ev.currentTarget, () => history(ev.currentTarget))}, 'View resolution history')),
      draftHost, historyHost);

    function sync() {
      const v = investigationView(inv);
      fill(panelHost, (!view.manualReview || inv) && renderInvestigation(v, {canAct: actionable, onRetry: ev => busy(ev.currentTarget, investigate), onEvidence: showEvidence}));
      investigateB.hidden = v.state !== 'none';
      const done = Boolean(v.result) && alreadyApproved(d.lastDecision?.get(x.id), v.result.action.code, x.status);
      approveB.disabled = !v.result || done;
      approveB.textContent = done ? 'Already approved' : 'Approve recommendation';
      rejectB.disabled = !v.result;
      approveB.title = done ? 'This recommendation is already approved and nothing has changed since.' : v.result ? `Approves: ${ACTION_TEXT[v.result.action.code] ?? v.result.action.code}` : 'Needs a completed investigation';
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
        const message = decisionMessage(decision, r.next_step);
        d.notice = {id: x.id, message, step: r.next_step};
        say(`${message} Discrepancy is now ${DISC_STATUS[r.discrepancy.status] ?? r.discrepancy.status}; invoice is ${(INVOICE_STATUS[r.invoice_status] ?? [r.invoice_status])[0]}.`);
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
  return {refresh, openDetail, choosePurchaseOrder, stop() { stopped = true; detail?.close(); section.remove(); }};
}
