// Hand-written clean invoices covering adjustment, currency and tax types. Reproductions of the stated cases,
// not the product owner's 109-invoice dataset. `wrong()` makes the matching deliberately wrong variant.
const L = 'Description | Qty | Unit Price | Amount\n';
export const clean = {
  'clean-us-fuel-surcharge': 'Currency: USD\n' + L + 'Diesel parts | 2 | 1,425.00 | 2,850.00\nSubtotal $2,850.00\nFreight $175.00\nFuel surcharge $342.00\nSales Tax (6.5%) $185.25\nTotal $3,552.25',
  'clean-us-credit-applied': 'Currency: USD\n' + L + 'Licences | 3 | 866.00 | 2,598.00\nSubtotal $2,598.00\nCredit applied (CM-1042) -$150.00\nSales Tax $146.88\nTotal $2,594.88',
  'usd-priced-zar-payable': L + 'Pump | 2 | 1,000.00 | 2,000.00\nSubtotal USD 2,000.00\nVAT (15%) USD 300.00\nTotal USD 2,300.00\nExchange rate: 1 USD = 18.25 ZAR\nAmount due ZAR 41,975.00',
  'gbp-with-eur-reference': L + 'Consulting | 10 | 100.00 | 1,000.00\nSubtotal GBP 1,000.00\nVAT (20%) GBP 200.00\nTotal GBP 1,200.00\nEquivalent total EUR 1,404.00 (for reference only)\nExchange rate: 1 GBP = 1.17 EUR',
  'cad-priced-usd-payable': L + 'Widgets | 4 | 250.00 | 1,000.00\nSubtotal CAD 1,000.00\nGST (5%) CAD 50.00\nPST (7%) CAD 70.00\nTotal CAD 1,120.00\nExchange rate: 1 CAD = 0.7310 USD\nAmount payable USD 818.72',
  'eur-two-vat-rates': L + 'Books | 1 | 100.00 | 100.00\nToner | 1 | 200.00 | 200.00\nSubtotal EUR 300.00\nVAT 7% on 100.00 7.00\nVAT 19% on 200.00 38.00\nTotal EUR 345.00',
  'eur-vat-inclusive': L + 'Parts | 1 | 119.00 | 119.00\nTotal incl. VAT EUR 119.00\nVAT 19% included 19.00',
  'gbp-zero-rated': L + 'Export goods | 1 | 500.00 | 500.00\nSubtotal GBP 500.00\nVAT (zero-rated) 0.00\nTotal GBP 500.00',
  'eur-exempt': L + 'Training | 1 | 800.00 | 800.00\nSubtotal EUR 800.00\nVAT exempt -\nTotal EUR 800.00',
  'us-state-county-tax': 'Currency: USD\n' + L + 'Chairs | 4 | 150.00 | 600.00\nSubtotal $600.00\nState sales tax (6%) $36.00\nCounty tax (1.5%) $9.00\nTotal $645.00',
  'us-handling-discount': 'Currency: USD\n' + L + 'Cables | 10 | 12.00 | 120.00\nSubtotal $120.00\nHandling fee $8.00\nTrade discount -$12.00\nSales Tax (8%) $9.60\nTotal $125.60',
  'us-deposit-balance-due': 'Currency: USD\n' + L + 'Install | 1 | 1,000.00 | 1,000.00\nSubtotal $1,000.00\nSales Tax (5%) $50.00\nTotal $1,050.00\nDeposit received -$300.00\nBalance due $750.00',
  'ca-hst': 'Currency: CAD\n' + L + 'Design | 5 | 80.00 | 400.00\nSubtotal 400.00\nHST (13%) 52.00\nTotal 452.00',
  'de-mwst-shipping': L + 'Papier | 5 | 20,00 | 100,00\nZwischensumme\nSubtotal 100,00 €\nShipping 10,00 €\nMwSt 19% 20,90 €\nTotal 130,90 €'
};
// Raise the last printed total-like amount by 10.00, keeping its formatting.
export function wrong(text) {
  const lines = text.split('\n');
  const i = lines.findLastIndex(l => /^(?:total|amount|balance)/i.test(l) && !/reference/i.test(l));
  lines[i] = lines[i].replace(/(\d[\d,.]*)([.,])(\d{2})(?!.*\d)/, (m, int, sep, dec) => {
    const group = sep === ',' ? '.' : ',', n = Number(int.replaceAll(group, '')) + 10;
    return n.toLocaleString('en-US').replaceAll(',', group) + sep + dec;
  });
  return lines.join('\n');
}
