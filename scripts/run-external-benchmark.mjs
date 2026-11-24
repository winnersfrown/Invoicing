// Run the app's extraction pipeline over an external invoice benchmark and write
// a predictions JSON in the benchmark's format, plus per-document diagnostics.
// Usage: node scripts/run-external-benchmark.mjs <benchmark dir> <code root> <out.json>
//          [--only=pdf|image] [--timeout=ms] [--limit=n]
// PDFs follow extractFile's text-layer path (PDF.js rows -> groupPdfRows ->
// parseExtractedText), including its 5-page limit. Images use tesseract.js in Node:
// the first PSM 3 pass, then PSM 6 if no total was found. The browser's canvas
// retries (straightening, scan enhancement, crops, ruled grids) need a DOM canvas
// and do not run here, so image results understate the browser path.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [bench, root, out] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
if (!bench || !root || !out) {
  console.error('Usage: node scripts/run-external-benchmark.mjs <benchmark dir> <code root> <out.json> [--only=pdf|image] [--timeout=ms] [--limit=n]');
  process.exit(2);
}
const load = p => import(pathToFileURL(path.join(root, p)).href);
const {getDocument} = await load('node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const {groupPdfRows} = await load('dist/layout-extraction.js');
const {parseExtractedText} = await load('dist/extraction.js');
const {ocrRows} = await load('dist/ocr-layout.js');
const corpus = path.join(bench, 'corpus', 'v1');
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const timeout = Number(opt.timeout || 180000);
let docs = manifest.documents.filter(d => !opt.only || (opt.only === 'pdf') === /\.pdf$/i.test(d.file));
if (opt.limit) docs = docs.slice(0, Number(opt.limit));

let worker;
async function ocr(file) {
  if (!worker) {
    const T = (await load('node_modules/tesseract.js/src/index.js')).default;
    worker = await T.createWorker('eng', 1);
  }
  const read = async mode => {
    await worker.setParameters({tessedit_pageseg_mode: mode});
    return ocrRows((await worker.recognize(file, {}, {text: true, blocks: true})).data, 1);
  };
  const parse = rows => parseExtractedText(rows.map(r => r.text).join('\n'), 'invoice', rows);
  let rows = await read('3'), d = parse(rows);
  if (d.total == null) {
    const retry = await read('6'), r = parse(retry);
    if (r.total != null) { rows = retry; d = r; }
  }
  return {rows, d};
}

async function pdfRead(file) {
  const pdf = await getDocument({data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false, verbosity: 0}).promise;
  try {
    if (pdf.numPages > 5) throw Error('This demo accepts PDFs up to 5 pages.');
    const rows = [];
    for (let n = 1; n <= pdf.numPages; n++) rows.push(...groupPdfRows((await (await pdf.getPage(n)).getTextContent()).items, n));
    if (rows.map(r => r.text).join('\n').trim().length < 40) throw Error('No text layer (browser would OCR the page).');
    return {rows, d: parseExtractedText(rows.map(r => r.text).join('\n'), 'invoice', rows)};
  } finally { await pdf.destroy(); }
}

const num = v => (Number.isFinite(v) ? v : null);
const predictions = {}, diagnostics = {};
for (const doc of docs) {
  const file = path.join(corpus, doc.file), started = Date.now();
  let result, error = null;
  try {
    const job = /\.pdf$/i.test(file) ? pdfRead(file) : ocr(file);
    let timer;
    result = await Promise.race([job, new Promise((_, no) => { timer = setTimeout(() => no(Error('timeout')), timeout); })]).finally(() => clearTimeout(timer));
  } catch (e) {
    error = e.message;
    if (error === 'timeout' && worker) { await worker.terminate().catch(() => {}); worker = null; }
  }
  const d = result?.d, f = d?.extraction?.fields || {};
  const review = d?.arithmeticReview || {};
  const contradictions = (review.contradictions || d?.arithmetic || []).map(c => c.message || c.path);
  const uncertain = (review.uncertain || []).map(c => c.message || c.path);
  const multiple = Boolean(d?.additionalInvoices?.length);
  predictions[doc.doc_id] = d ? {
    vendor_name: d.vendor || null,
    invoice_number: d.number || null,
    invoice_date: d.date || null,
    due_date: d.due || null,
    currency: d.currency || null,
    subtotal: num(d.subtotal),
    // Tax printed only in the payable currency (dual-currency invoices) is kept apart as payableTax.
    tax: num(d.tax) ?? (Number.isSafeInteger(d.payableTax?.cents) ? d.payableTax.cents / 100 : null),
    total_amount: num(d.total),
    document_type: d.documentType || 'invoice',
    line_items: (d.lines || []).map(l => ({description: l.description || '', amount: num(l.amount)})),
    // The app stops the upload for multi-invoice files and shows contradictions.
    flagged: multiple || contradictions.length > 0,
    references: []
  } : {};
  diagnostics[doc.doc_id] = {
    error, ms: Date.now() - started, ocr: !/\.pdf$/i.test(file),
    warning: multiple ? 'multiple_invoices' : contradictions.length ? 'contradiction' : uncertain.length ? 'uncertain' : 'none',
    contradictions, uncertain,
    needsConfirmation: Object.entries(f).filter(([, v]) => v?.needsConfirmation).map(([k, v]) => ({field: k, candidates: (v.candidates || []).map(c => c.value)})),
    amountDue: num(d?.amountDue), pricingCurrency: d?.pricingCurrency || null, pricingTotal: num(d?.pricingTotal),
    referenceTotal: num(d?.referenceTotal), exchangeRate: d?.exchangeRate?.rate ?? null,
    taxes: (d?.taxes || []).map(t => ({label: t.label, cents: t.cents, rate: t.ratePercent, treatment: t.treatment})),
    adjustments: (d?.adjustments || []).map(a => ({kind: a.kind, cents: a.cents, appliesTo: a.appliesTo})),
    payableTax: d?.payableTax ? {currency: d.payableTax.currency, cents: d.payableTax.cents} : null,
    taxInclusive: Boolean(d?.taxInclusive)
  };
  console.log(`${doc.doc_id} ${diagnostics[doc.doc_id].ms}ms ${error || diagnostics[doc.doc_id].warning}`);
}
if (worker) await worker.terminate();
fs.writeFileSync(out, JSON.stringify({system: 'Rekono extraction (' + root + ')', run_date: new Date().toISOString().slice(0, 10), documents: predictions, diagnostics}, null, 1));
