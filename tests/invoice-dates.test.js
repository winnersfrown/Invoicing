import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLayoutText} from '../dist/layout-extraction.js';
import {readInvoiceDate, invoiceDateIssue} from '../dist/invoice-dates.js';

const parse = text => parseLayoutText(text, 'invoice');
const dates = d => [d.date, d.due];

test('French invoice reads 09/03/2026 as 9 March from the document language', () => {
  const d = parse('FACTURE\nAtelier Lumière SARL\nN° de facture : F-2026-031\nDate de facture : 09/03/2026\nÉchéance : 08/04/2026\nTotal TTC : 1 200,00 €');
  assert.deepEqual(dates(d), ['2026-03-09', '2026-04-08']);
  const f = d.extraction.fields.date;
  assert.equal(f.value, '2026-03-09');
  assert.equal(f.sourceText, '09/03/2026');
  assert.equal(f.label, 'Date de facture');
  assert.match(f.evidence[0].text, /Date de facture : 09\/03\/2026/);
  assert.match(f.reason, /day\/month/);
  assert.ok(!f.needsConfirmation);
  assert.equal(d.extraction.fields.due.sourceText, '08/04/2026');
});

test('US invoice keeps month/day from the US address and USD', () => {
  const d = parse('INVOICE\nVendor: Cedar Supply LLC\n123 Main St, Austin, TX 78701\nInvoice Date: 03/09/2026\nDue Date: 04/08/2026\nTotal: $500.00 USD');
  assert.deepEqual(dates(d), ['2026-03-09', '2026-04-08']);
  assert.match(d.extraction.fields.date.reason, /month\/day/);
});

test('UK invoice reads day/month from VAT, pound and postcode signals', () => {
  const d = parse('Thames Office Ltd\n1 High Street, London SW1A 1AA\nVAT Reg No: GB123456789\nInvoice date: 09/03/2026\nDue date: 08/04/2026\nTotal: £120.00');
  assert.deepEqual(dates(d), ['2026-03-09', '2026-04-08']);
});

test('ISO and dotted dates', () => {
  assert.deepEqual(dates(parse('Invoice date: 2026-03-09\nDue date: 2026-04-08\nTotal: 10.00')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Issued: 2026-11-12\nDue: 2026-12-12')), ['2026-11-12', '2026-12-12']);
  const de = parse('Muster GmbH\nRechnungsdatum: 09.03.2026\nFällig am: 08.04.2026\nGesamt: 100,00 EUR');
  assert.deepEqual(dates(de), ['2026-03-09', '2026-04-08']);
  assert.equal(de.extraction.fields.date.label, 'Rechnungsdatum');
});

test('month names in several languages and abbreviations', () => {
  for (const [text, iso] of [
    ['9 mars 2026', '2026-03-09'], ['3. März 2026', '2026-03-03'], ['Mar 9, 2026', '2026-03-09'],
    ['9-Mar-26', '2026-03-09'], ['9 de marzo de 2026', '2026-03-09'], ['9 maart 2026', '2026-03-09'],
    ['9 marzo 2026', '2026-03-09'], ['9 de março de 2026', '2026-03-09'], ['1er avril 2026', '2026-04-01'],
    ['12 févr. 2026', '2026-02-12'], ['September 3rd, 2026', '2026-09-03'], ['15 Okt. 2026', '2026-10-15'],
    ['7 mei 2026', '2026-05-07'], ['7 maggio 2026', '2026-05-07'], ['7 dez 2026', '2026-12-07'],
    ['30 July 2025', '2025-07-30'], ['2 Jan 2026', '2026-01-02']
  ]) assert.equal(readInvoiceDate(text)?.value, iso, text);
});

test('an unambiguous date elsewhere settles the order of an ambiguous one', () => {
  assert.deepEqual(dates(parse('Invoice No: A-1\nInvoice date: 04/05/2026\nDue date: 19/05/2026\nTotal: 100.00')), ['2026-05-04', '2026-05-19']);
  const us = parse('Invoice No: A-1\nInvoice date: 04/05/2026\nDue date: 05/19/2026\nTotal: 100.00');
  assert.deepEqual(dates(us), ['2026-04-05', '2026-05-19']);
  assert.match(us.extraction.fields.date.reason, /05\/19\/2026/);
});

test('a truly ambiguous 04/05/2026 is not guessed and needs confirmation', () => {
  const d = parse('Invoice No: A-1\nInvoice date: 04/05/2026\nTotal: 100.00');
  const f = d.extraction.fields.date;
  assert.equal(d.date, '');
  assert.equal(f.value, null);
  assert.equal(f.needsConfirmation, true);
  assert.deepEqual(f.candidates.map(c => c.value), ['2026-05-04', '2026-04-05']);
  assert.ok(f.candidates.every(c => c.label));
  assert.match(f.reason, /04\/05\/2026 could be 4 May or 5 April/);
  assert.equal(f.sourceText, '04/05/2026');
  assert.match(f.evidence[0].text, /Invoice date: 04\/05\/2026/);
  // Without context the low-level reader also refuses to pick.
  assert.equal(readInvoiceDate('04/05/2026').value, null);
  assert.equal(readInvoiceDate('05/05/2026').value, '2026-05-05');
});

test('issue, due, delivery and order dates under regional labels', () => {
  assert.deepEqual(dates(parse('Fecha de pedido: 01/03/2026\nFecha de entrega: 05/03/2026\nFecha de factura: 09/03/2026\nVencimiento: 08/04/2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Besteldatum: 01-03-2026\nLeverdatum: 05-03-2026\nFactuurdatum: 09-03-2026\nVervaldatum: 08-04-2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Data ordine: 01/03/2026\nData fattura: 09/03/2026\nScadenza: 08/04/2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Data de emissão: 09/03/2026\nData de vencimento: 08/04/2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Date de commande : 01/03/2026\nDate de livraison : 05/03/2026\nDate : 09/03/2026\nDate d\'échéance : 08/04/2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Seller: Cedar LLC, Austin, TX 78701\nOrder date: 03/01/2026\nDelivery date: 03/05/2026\nIssue date: 03/09/2026\nPayment due: 04/08/2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('PO date: 2026-03-01\nTax point: 9 March 2026\nPay by: 8 April 2026')), ['2026-03-09', '2026-04-08']);
  assert.deepEqual(dates(parse('Leistungsdatum: 01.03.2026\nRechnungsdatum: 09.03.2026\nZahlbar bis: 08.04.2026')), ['2026-03-09', '2026-04-08']);
});

test('the specific invoice-date label wins over the tax point', () => {
  const d = parse('Invoice date: 9 March 2026\nTax point: 28 February 2026\nDue date: 8 April 2026');
  assert.equal(d.date, '2026-03-09');
});

test('due date before invoice date still warns', () => {
  const d = parse('Invoice date: 2026-03-09\nDue date: 2026-03-01\nTotal: 10.00');
  assert.deepEqual(dates(d), ['2026-03-09', '2026-03-01']);
  assert.match(invoiceDateIssue(d.date, d.due), /8 days before invoice date/);
});

test('invalid dates are rejected, never rolled over', () => {
  for (const text of ['31/02/2026', '31.02.2026', '2026-02-30', '02/31/2026', '30 février 2026']) assert.equal(readInvoiceDate(text), null, text);
  const d = parse('Facture\nDate de facture : 31/02/2026\nTotal : 10,00 €');
  assert.equal(d.date, '');
  assert.ok(!d.extraction.fields.date?.value);
});

test('a date line with no label is offered as an uncertain invoice date', () => {
  const d = parse('Atelier Lumière SARL\nPériode : du 01/02/2026 au 28/02/2026\nParis, le 9 mars 2026\nFacture N° F-12\nTotal : 10,00 €');
  assert.equal(d.date, '2026-03-09');
  assert.equal(d.extraction.fields.date.support, 'uncertain');
  assert.equal(d.extraction.fields.date.sourceText, '9 mars 2026');
  assert.equal(parse('Invoice No: A-1\nDue date: 2026-04-08\nTotal: 10.00').date, '');
  assert.equal(parse('Invoice No: A-1\nTel: 01.23.45\nTotal: 10.00').date, '');
});
