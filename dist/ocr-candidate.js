import {toCents} from './arithmetic.js';

const lookalikes = ['I1', 'O0', 'S5', 'B8', 'Z2'];

function plausibleSkuConflict(first, second) {
  if (!first || !second || first.length !== second.length) return false;
  const a = first.toUpperCase();
  const b = second.toUpperCase();
  let differences = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!lookalikes.some(pair => pair.includes(a[i]) && pair.includes(b[i]))) return false;
    differences++;
  }
  // Multiple substituted characters are too weak to establish row identity.
  return differences === 1;
}

const comparableDescription = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function samePrintedRow(a, b) {
  if (!a?.bbox || !b?.bbox || a.page !== b.page || a.coordinateSpace !== b.coordinateSpace) return false;
  const {bbox: one} = a;
  const {bbox: two} = b;
  const overlap = Math.min(one.y1, two.y1) - Math.max(one.y0, two.y0);
  return Math.min(one.x1, two.x1) > Math.max(one.x0, two.x0) &&
    overlap > 0 && overlap >= Math.min(one.y1 - one.y0, two.y1 - two.y0) / 2;
}

const field = (doc, index, key) => doc.extraction.fields[`lines.${index}.${key}`];

// Require a unique counterpart for each protected amount. An OCR lookalike is
// only evidence of correspondence when the row, description and amount agree.
export function checkRuledCandidate(previous, candidate, ruledRows) {
  const claimed = new Set();
  const conflicts = [];
  const ruledSkuCells = new Map(ruledRows.map(row => [row.gridEvidence.sku.bbox, row]));
  for (const [index, old] of previous.lines.entries()) {
    const printed = field(previous, index, 'amount');
    if (!Number.isFinite(old.amount) || (!old.sku && printed?.support !== 'supported')) continue;
    const priorSku = field(previous, index, 'sku');
    const priorRow = printed?.evidence.at(-1);
    const matches = [];
    for (const [nextIndex, next] of candidate.lines.entries()) {
      if (!Number.isFinite(next.amount) || toCents(next.amount) !== toCents(old.amount)) continue;
      const nextAmount = field(candidate, nextIndex, 'amount');
      if (!samePrintedRow(priorRow, nextAmount?.evidence.at(-1))) continue;
      const newSku = field(candidate, nextIndex, 'sku');
      const row = ruledSkuCells.get(newSku?.evidence[0]?.bbox);
      if (next.sku === old.sku && old.sku) {
        matches.push({nextIndex});
        continue;
      }
      const description = comparableDescription(old.description);
      if (!description || description !== comparableDescription(next.description)) continue;
      if (!old.sku) matches.push({nextIndex});
      else if (row && plausibleSkuConflict(old.sku, next.sku)) {
        matches.push({nextIndex, conflict:{row, fallbackSku:old.sku, evidence:priorSku?.evidence || []}});
      }
    }
    if (matches.length !== 1 || claimed.has(matches[0].nextIndex)) return null;
    const [{nextIndex, conflict}] = matches;
    claimed.add(nextIndex);
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}
