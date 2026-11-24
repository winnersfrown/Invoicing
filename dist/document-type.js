// A standalone title or document-number label identifies a credit note. An
// adjustment such as "Credit note CN-15 applied" can occur on a normal invoice.
export function hasCreditTitle(text) {
 const title=/^(?:(?:tax\s+)?credit\s+(?:note|memo(?:randum)?)|nota\s+de\s+cr[ée]dito(?:\s*\(ndc\))?)$/i;
 return String(text??'').split(/\r?\n/).slice(0,25).some(row=>
  row.trim().split(/\s{2,}|\s*\|\s*/).some(cell=>title.test(cell.trim())) ||
  /^(?:credit\s+(?:note|memo)|ndc)\s*(?:no\.?|number|#)\s*[:#]?\s*[\w/-]*\d/i.test(row.trim()));
}
