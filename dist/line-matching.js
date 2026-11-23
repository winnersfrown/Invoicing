const skuKey = sku => sku.trim().toLowerCase();
const descriptionTokens = description => new Set(description.match(/[\p{L}\p{N}]+/gu) ?? []);
const dimensions = description => (description.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(' ');
const generic = new Set(['item', 'product', 'service', 'misc', 'miscellaneous', 'goods', 'fee']);
const pairKey = ({invoiceLine, poLine}) => `${invoiceLine}:${poLine}`;

function normalizeDescription(description) {
 return description.normalize('NFKC').toLowerCase()
  .replace(/(?<=\d)\s*[x×]\s*(?=\d)/gu,'x')
  .replace(/(?<=\d)\s+(?=mm\b|cm\b|m\b|in\b|ft\b)/gu,'');
}

function suggestion(invoice, po) {
 const invoiceDescription = normalizeDescription(invoice.description);
 const poDescription = normalizeDescription(po.description);
 const left = descriptionTokens(invoiceDescription);
 const right = descriptionTokens(poDescription);
 const common = [...left].filter(word => right.has(word) && !generic.has(word));
 if (!common.length) return null;

 // Different printed measurements or model numbers are a reason to leave the lines separate.
 const invoiceNumbers = dimensions(invoiceDescription);
 const poNumbers = dimensions(poDescription);
 if (invoiceNumbers && poNumbers && invoiceNumbers !== poNumbers) return null;

 const exact = left.size === right.size && [...left].every(word => right.has(word));
 const sameQuantity = invoice.quantity === po.quantity;
 const short = Math.min(left.size, right.size);
 const long = Math.max(left.size, right.size);
 const contained = common.length === short && common.length / long >= 0.5;
 const overlap = common.length >= 2 && common.length / (left.size + right.size - common.length) >= 0.5;
 if (!exact && !(sameQuantity && (contained || overlap)) && !(contained && common.length >= 2)) return null;
 return {
  description: exact ? 'same' : 'similar',
  sameQuantity,
 };
}

/** Reserve exact SKUs and recorded reviewer matches before considering descriptions. */
export function matchLines(invoice, po, decisions) {
 const bySku = new Map(invoice.map((line, index) => [skuKey(line.sku), index + 1]));
 const openInvoice = new Set(invoice.map((_, index) => index + 1));
 const openPo = new Set(po.map((_, index) => index + 1));
 const pairs = [];
 const add = (invoiceLine, poLine, matchBasis) => {
  openInvoice.delete(invoiceLine);
  openPo.delete(poLine);
  pairs.push({invoiceLine, poLine, matchBasis});
 };
 po.forEach((line, index) => {
  const invoiceLine = bySku.get(skuKey(line.sku));
  if (invoiceLine) add(invoiceLine, index + 1, 'exact_sku');
 });
 const rejected = new Set();
 for (const decision of decisions) {
  if (decision.decision === 'reject') rejected.add(pairKey(decision));
  if (decision.decision === 'confirm' && openInvoice.has(decision.invoiceLine) && openPo.has(decision.poLine)) {
   add(decision.invoiceLine, decision.poLine, 'reviewer_confirmed');
  }
 }

 const pendingLineMatches = [];
 for (const invoiceLine of openInvoice) {
  for (const poLine of openPo) {
   if (rejected.has(pairKey({invoiceLine, poLine}))) continue;
   const reason = suggestion(invoice[invoiceLine - 1], po[poLine - 1]);
   if (reason) pendingLineMatches.push({invoiceLine, poLine, ...reason});
  }
 }
 const pendingInvoice = new Set(pendingLineMatches.map(match => match.invoiceLine));
 const pendingPo = new Set(pendingLineMatches.map(match => match.poLine));
 for (const poLine of openPo) if (!pendingPo.has(poLine)) pairs.push({invoiceLine: null, poLine, matchBasis: 'unmatched'});
 for (const invoiceLine of openInvoice) if (!pendingInvoice.has(invoiceLine)) pairs.push({invoiceLine, poLine: null, matchBasis: 'unmatched'});
 pairs.sort((a, b) => (a.poLine ?? Infinity) - (b.poLine ?? Infinity) || (a.invoiceLine ?? 0) - (b.invoiceLine ?? 0));
 return {pairs, pendingLineMatches};
}
