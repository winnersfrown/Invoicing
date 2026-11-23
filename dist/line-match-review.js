import {h, fill} from './investigation-ui.js';

export function renderLineMatchReview({candidates, invoiceLines, poLines, onReview}) {
 const invoice = new Map(invoiceLines.map(line => [line.id, line]));
 const po = new Map(poLines.map(line => [line.id, line]));
 const groups = new Map();
 for (const candidate of candidates) {
  if (!invoice.has(candidate.invoiceLine) || !po.has(candidate.poLine)) continue;
  if (!groups.has(candidate.invoiceLine)) groups.set(candidate.invoiceLine, []);
  groups.get(candidate.invoiceLine).push(candidate);
 }
 const label = line => `Line ${line.number} · ${line.sku} · ${line.description} (qty ${line.quantity})`;
 let saving = false;
 const panel = h('article', {class: 'discrepancy-card'},
  h('h4', {}, 'Review suggested product matches'),
  h('p', {}, 'Confirm a pair when both lines refer to the same product. Price and quantity differences are checked after confirmation.'));
 for (const [invoiceLine, matches] of groups) {
  const details = h('div', {'aria-live': 'polite'});
  const select = h('select', {'aria-label': `PO candidate for ${invoice.get(invoiceLine).sku}`},
   ...matches.map((match, index) => h('option', {value: String(index)}, label(po.get(match.poLine)))));
  const render = () => {
   const selected = matches[select.selectedIndex];
   fill(details,
    matches.length === 1 && h('p', {}, 'Purchase order · ', label(po.get(selected.poLine))),
    h('p', {class: 'hint'}, `${selected.description === 'same' ? 'Same description' : 'Similar descriptions'} · ${selected.sameQuantity ? 'same quantity' : 'different quantities'}`),
    selected.reasons?.length && h('ul', {class: 'hint'}, ...selected.reasons.map(reason => h('li', {}, reason))));
  };
  select.addEventListener('change', render);
  const act = (decision, title, style) => h('button', {
   type: 'button', class: `button ${style}`,
   onclick: async () => {
    if (saving) return;
    saving = true;
    const buttons = [...panel.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try { await onReview(matches[select.selectedIndex], decision); }
    finally {
     saving = false;
     buttons.forEach(button => { button.disabled = false; });
    }
   },
  }, title);
  panel.append(h('div', {class: 'hold-card'},
   h('p', {}, 'Invoice · ', h('strong', {}, label(invoice.get(invoiceLine)))),
   matches.length > 1 && h('label', {}, 'Purchase-order candidate ', select), details,
   onReview && h('div', {class: 'actions'}, act('confirm', 'Confirm match', 'primary'), act('reject', 'Reject match', 'secondary'))));
  render();
 }
 return panel;
}
