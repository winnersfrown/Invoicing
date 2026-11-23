// Draws synthetic invoice images for OCR tests. All businesses are fictional.
// Usage: node scripts/make-ocr-fixtures.mjs            → tests/fixtures/ocr/*.png and *.json
//        node scripts/make-ocr-fixtures.mjs --holdout  → benchmark/phase0-holdout/*.png and *.json
//          (drawn after the Phase 0 extraction code was frozen; never tune the code against them)
import fs from 'node:fs';
import {createCanvas} from '@napi-rs/canvas';

const holdout = process.argv.includes('--holdout');
const out = new URL(holdout ? '../benchmark/phase0-holdout/' : '../tests/fixtures/ocr/', import.meta.url);
fs.mkdirSync(out, {recursive: true});

/**
 * columns: [{key, label, x, align}] in drawing order; rows hold the same keys.
 * The expected answer is written next to the image so tests never depend on the drawing code.
 */
function draw(name, doc) {
  const width = 1240, height = 1500, canvas = createCanvas(width, height), g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); g.fillStyle = '#111';
  const text = (s, x, y, size = 22, align = 'left', weight = '') => {
    g.font = `${weight} ${size}px Arial`; g.textAlign = align; g.fillText(s, x, y);
  };
  text(doc.supplier, 80, 110, 40, 'left', 'bold');
  doc.supplierLines.forEach((s, i) => text(s, 80, 150 + i * 30));
  text('INVOICE', width - 80, 110, 40, 'right', 'bold');
  doc.meta.forEach(([k, v], i) => { text(k, width - 380, 160 + i * 32); text(v, width - 80, 160 + i * 32, 22, 'right'); });
  text('Bill to', 80, 330, 22, 'left', 'bold');
  doc.billTo.forEach((s, i) => text(s, 80, 362 + i * 30));

  let y = 500;
  g.fillRect(70, y - 34, width - 140, 2);
  for (const c of doc.columns) text(c.label, c.x, y, 22, c.align, 'bold');
  g.fillRect(70, y + 14, width - 140, 2);
  y += 60;
  for (const row of doc.rows) {
    for (const c of doc.columns) {
      const value = row[c.key];
      if (Array.isArray(value)) value.forEach((part, i) => text(part, c.x, y + i * 28, 22, c.align));
      else text(value, c.x, y, 22, c.align);
    }
    y += Array.isArray(row.description) ? 28 * row.description.length + 30 : 52;
  }
  g.fillRect(70, y - 20, width - 140, 2);
  y += 30;
  for (const [k, v] of doc.totals) { text(k, width - 380, y, 22, 'left', k.startsWith('Total') ? 'bold' : ''); text(v, width - 80, y, 22, 'right', k.startsWith('Total') ? 'bold' : ''); y += 36; }
  fs.writeFileSync(new URL(`${name}.png`, out), canvas.toBuffer('image/png'));
  fs.writeFileSync(new URL(`${name}.json`, out), JSON.stringify(doc.expected, null, 2) + '\n');
}

const morganLines = [
  ['SMM-001', 'Social Media Strategy Plan', 1, 100],
  ['CNT-002', 'Content Creation (5 posts)', 5, 100],
  ['RPT-003', 'Scheduling & Reporting', 1, 100],
  ['IGS-004', 'Instagram Story Design (3 slides)', 3, 50],
  ['HTG-005', 'Hashtag Research', 1, 50],
];
const usd = n => `$${n.toFixed(2)}`;
const morgan = {
  supplier: 'Morgan Maxwell', supplierLines: ['Social Media Consulting', '18 Harbor Lane, Portland, OR 97201'],
  meta: [['Invoice No.', 'MM-2041'], ['Invoice Date', '2026-11-03'], ['Due Date', '2026-12-03'], ['PO Number', 'PO-2030-077']],
  billTo: ['Oak & Elm Creative (fictional)', '400 Pine Street, Portland, OR 97204'],
  rows: morganLines.map(([sku, description, quantity, price]) => ({sku, description, quantity: String(quantity), price: usd(price), amount: usd(quantity * price)})),
  totals: [['Subtotal', usd(900)], ['Tax (10%)', usd(90)], ['Total Due', usd(990)]],
  expected: {
    vendor: 'Morgan Maxwell', number: 'MM-2041', currency: 'USD', subtotal: 900, tax: 90, total: 990,
    lines: morganLines.map(([sku, description, quantity, unitPrice]) => ({sku, description, quantity, unitPrice, amount: quantity * unitPrice})),
  },
};

if (!holdout) {
// The standard order: SKU, description, quantity, unit price, amount.
draw('morgan-maxwell', {...morgan, columns: [
  {key: 'sku', label: 'SKU', x: 80, align: 'left'},
  {key: 'description', label: 'Description', x: 260, align: 'left'},
  {key: 'quantity', label: 'Qty', x: 760, align: 'right'},
  {key: 'price', label: 'Unit Price', x: 950, align: 'right'},
  {key: 'amount', label: 'Amount', x: 1160, align: 'right'},
]});

// A holdout layout the extraction changes were not built against: description first,
// amount before quantity, and a wrapped description.
const holdoutLines = [
  ['Brand Workshop (half day)', 'BW-110', 1, 640],
  [['Website Copy Edit', '(home and about pages)'], 'WC-220', 2, 175],
  ['Photo Retouching', 'PR-330', 12, 15],
];
draw('holdout-reordered', {
  supplier: 'Lumen Field Studio', supplierLines: ['Creative Services', '9 Alder Court, Denver, CO 80202'],
  meta: [['Invoice No.', 'LFS-5520'], ['Invoice Date', '2026-10-28'], ['Due Date', '2026-11-27'], ['PO Number', 'PO-2030-081']],
  billTo: ['Oak & Elm Creative (fictional)', '400 Pine Street, Portland, OR 97204'],
  columns: [
    {key: 'description', label: 'Description', x: 80, align: 'left'},
    {key: 'sku', label: 'Item', x: 560, align: 'left'},
    {key: 'price', label: 'Rate', x: 830, align: 'right'},
    {key: 'quantity', label: 'Hours', x: 950, align: 'right'},
    {key: 'amount', label: 'Line Total', x: 1160, align: 'right'},
  ],
  rows: holdoutLines.map(([description, sku, quantity, price]) => ({description, sku, quantity: String(quantity), price: usd(price), amount: usd(quantity * price)})),
  totals: [['Subtotal', usd(1170)], ['Sales Tax (8%)', usd(93.6)], ['Total Due', usd(1263.6)]],
  expected: {
    vendor: 'Lumen Field Studio', number: 'LFS-5520', currency: 'USD', subtotal: 1170, tax: 93.6, total: 1263.6,
    lines: holdoutLines.map(([description, sku, quantity, unitPrice]) => ({sku, description: [].concat(description).join(' '), quantity, unitPrice, amount: quantity * unitPrice})),
  },
});
}

if (holdout) {
  const money = (n, symbol = '$') => `${symbol}${n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  const base = {billTo: ['Oak & Elm Creative (fictional)', '400 Pine Street, Portland, OR 97204']};
  // Each case: supplier, layout columns, lines [sku, description (string or wrapped array), quantity, unitPrice], tax rate, money format.
  const cases = [
    {name: 'quill-ledger', supplier: 'Quill & Ledger Bookkeeping', address: '72 Market Street, Salem, OR 97301', number: 'QL-30418', po: 'PO-2031-004', taxRate: 0,
      columns: [['quantity', 'Qty', 120, 'right'], ['description', 'Description', 180, 'left'], ['price', 'Unit Price', 900, 'right'], ['amount', 'Amount', 1160, 'right']],
      lines: [['', 'Monthly bookkeeping (October)', 1, 450], ['', 'Payroll run', 2, 85], ['', 'Sales tax filing', 1, 120], ['', 'Receipt scanning (per 100)', 3, 15]]},
    {name: 'harbor-print', supplier: 'Harbor Print Works', address: '15 Dock Road, Astoria, OR 97103', number: 'HPW-7781', po: 'PO-2031-009', taxRate: 0, plain: true,
      columns: [['description', 'Description', 80, 'left'], ['quantity', 'Qty', 700, 'right'], ['price', 'Rate', 900, 'right'], ['amount', 'Total', 1160, 'right']],
      lines: [['', 'Trade show banners', 4, 312.5], ['', 'Brochures, tri-fold (box of 500)', 3, 1250], ['', 'Design proof revisions', 2, 60]]},
    {name: 'northwind-rentals', supplier: 'Northwind Event Rentals', address: '300 Fair Way, Eugene, OR 97401', number: 'NER-2207', po: 'PO-2031-012', taxRate: 0,
      columns: [['sku', 'Code', 80, 'left'], ['description', 'Item', 230, 'left'], ['quantity', 'Days', 760, 'right'], ['price', 'Daily Rate', 950, 'right'], ['amount', 'Amount', 1160, 'right']],
      lines: [['TNT-20', 'Frame tent 20x20', 3, 180], ['CHR-100', ['Folding chairs', '(set of 100)'], 3, 95], ['LGT-08', 'String lights 80 ft', 2, 40], ['GEN-5K', 'Generator 5 kW', 3, 110]]},
    {name: 'cedar-lane', supplier: 'Cedar Lane Landscaping', address: '9 Orchard Court, Bend, OR 97701', number: 'CLL-1190', po: 'PO-2031-015', taxRate: 0,
      columns: [['description', 'Description', 80, 'left'], ['quantity', 'Hours', 700, 'right'], ['price', 'Rate', 900, 'right'], ['amount', 'Amount', 1160, 'right']],
      lines: [['', 'Hedge trimming', 2.5, 60], ['', 'Leaf removal', 4, 45], ['', 'Irrigation check', 1.5, 70]]},
    {name: 'bright-arc', supplier: 'Bright Arc Electrical', address: '440 Volt Avenue, Medford, OR 97501', number: 'BAE-5562', po: 'PO-2031-021', taxRate: 0.08,
      columns: [['sku', 'SKU', 80, 'left'], ['description', 'Description', 240, 'left'], ['price', 'Unit Price', 760, 'right'], ['quantity', 'Qty', 900, 'right'], ['amount', 'Amount', 1160, 'right']],
      lines: [['OUT-15A', 'Duplex outlet 15A', 12, 4.25], ['BRK-20', 'Circuit breaker 20A', 4, 18.9], ['WIR-12', 'Copper wire 12 AWG (250 ft)', 1, 129], ['BOX-1G', 'Single gang box', 12, 1.6], ['LAB-HR', 'Electrician labor', 6, 95]]},
    {name: 'copper-kettle', supplier: 'Copper Kettle Catering', address: '18 Bay Street, Newport, OR 97365', number: 'CKC-0917', po: 'PO-2031-024', taxRate: 0.1,
      columns: [['description', 'Description', 80, 'left'], ['quantity', 'Qty', 700, 'right'], ['price', 'Price', 900, 'right'], ['amount', 'Line Total', 1160, 'right']],
      lines: [['', 'Lunch boxes, vegetarian', 25, 14.5], ['', 'Coffee service (per guest)', 40, 3.75], ['', 'Pastry platter', 2, 48]]},
  ];
  for (const c of cases) {
    const symbol = c.plain ? '' : '$';
    const subtotal = Math.round(c.lines.reduce((s, l) => s + l[2] * l[3] * 100, 0)) / 100;
    const tax = Math.round(subtotal * c.taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    draw(c.name, {...base, supplier: c.supplier, supplierLines: [c.address],
      meta: [['Invoice No.', c.number], ['Invoice Date', '2026-11-12'], ['Due Date', '2026-12-12'], ['PO Number', c.po]],
      columns: c.columns.map(([key, label, x, align]) => ({key, label, x, align})),
      rows: c.lines.map(([sku, description, quantity, price]) => ({sku, description, quantity: String(quantity), price: money(price, symbol), amount: money(quantity * price, symbol)})),
      totals: [['Subtotal', money(subtotal, symbol)], ...(c.taxRate ? [[`Tax (${Math.round(c.taxRate * 100)}%)`, money(tax, symbol)]] : []), ['Total Due', money(total, symbol)]],
      expected: {vendor: c.supplier, number: c.number, subtotal, tax: c.taxRate ? tax : null, total,
        lines: c.lines.map(([sku, description, quantity, unitPrice]) => ({sku, description: [].concat(description).join(' '), quantity, unitPrice, amount: Math.round(quantity * unitPrice * 100) / 100}))}});
  }
}
console.log('Wrote', fs.readdirSync(out).join(', '));
