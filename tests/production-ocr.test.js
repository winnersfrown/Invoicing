import test from 'node:test';
import assert from 'node:assert/strict';
import {findDarkTable} from '../dist/ocr-ruled-table.js';
import {parseExtractedText} from '../dist/extraction.js';
import {invoiceDateReviewIssue} from '../dist/invoice-dates.js';

test('a dark heading, a five-column item grid and a merged summary use distinct cell bounds',()=>{
  const width=500, height=700;
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  const fill=(left,top,right,bottom,value)=>{
    for(let y=top;y<bottom;y++)data.fill(value,(y*width+left)*4,(y*width+right)*4);
  };
  const edges=[10,65,250,337,405,490];
  fill(10,120,491,152,0);
  for(const x of edges)fill(x,152,x+2,304,0);
  for(const y of [182,212,242,272,302])fill(10,y,491,y+2,0);
  for(const x of [304,405,490])fill(x,302,x+2,367,0);
  for(const y of [334,366])fill(304,y,491,y+2,0);
  fill(304,366,492,398,0);
  const grid=findDarkTable({data,width,height});
  assert.equal(grid.heading.length,5);
  assert.equal(grid.rowCells.length,5);
  assert.equal(grid.summaries.length,3);
  assert.ok(grid.summaries[0][0].x > grid.rowCells[0][2].x);
  assert.equal(findDarkTable({data:data.fill(255),width,height}),null);
});

test('ruled cell evidence retains reversed columns and a printed subtotal discrepancy',()=>{
  const cells={sku:'SK-246',description:'Print and bind',unitPrice:'25',quantity:'4',amount:'$100'};
  const row=text=>({text,page:1,method:'ocr',ocrConfidence:95});
  const heading=['SKU','Description','Rate','Qty','Total'].map(row);
  const layout=[
    {...row('SK-246 Print and bind 25 4 $100'),gridCells:cells,gridHeading:heading,
      gridEvidence:Object.fromEntries(Object.entries(cells).map(([key,value])=>[key,row(value)]))},
    {...row('Subtotal  $103'),summaryCell:true,sourceRows:[row('Subtotal'),row('$103')]},
    {...row('Tax 10%  $10.30'),summaryCell:true},
    {...row('Total  $113.30'),summaryCell:true},
  ];
  const d=parseExtractedText('','invoice',layout);
  assert.deepEqual(d.lines,[{sku:'SK-246',description:'Print and bind',quantity:4,unitPrice:25,amount:100}]);
  assert.equal(d.extraction.fields['lines.0.quantity'].evidence[0].text,'Qty → 4');
  assert.equal(d.extraction.fields.subtotal.evidence[0].text,'Subtotal → $103');
  assert.equal(d.subtotal,103);
  assert.equal(d.tax,10.3);
  assert.equal(d.total,113.3);
  assert.equal(d.currency,'');
  assert.equal(d.extraction.fields.currency.needsConfirmation,true);
  assert.ok(d.arithmetic.some(issue=>issue.code==='printed_line_sum'&&issue.differenceCents===300));
});

test('buyer metadata follows its printed column when OCR interleaves other labels',()=>{
  const row=(text,x,y)=>({text,page:1,method:'ocr',ocrConfidence:95,bbox:{x0:x,y0:y,x1:x+150,y1:y+20},
    tokens:[{text,x,width:150}]});
  const rows=[
    row('NORTHWIND',350,20),row('INVOICE',20,42),row('STUDIO',350,62),
    row('Issued to:',20,140),row('Invoice No: 00456',350,140),
    row('Date: 11.03.2030',350,166),row('Casey Owens',20,165),
    row('Due Date: 11.02.2030',350,190),row('Bright Grove Unlimited',20,191),
    row('PO Reference: PO-2030-082',350,220),row('101 Test Street, Sample City',20,216),
    row('Account Name: Northwind Studio',20,500),
  ];
  const d=parseExtractedText('','invoice',rows);
  assert.equal(d.number,'00456');
  assert.equal(d.poNumber,'PO-2030-082');
  assert.equal(d.vendor,'Northwind Studio');
  assert.equal(d.extraction.fields.vendor.support,'supported');
  assert.equal(d.customer,'Casey Owens · Bright Grove Unlimited');
  assert.equal(d.extraction.fields.date.sourceText,'11.03.2030');
  assert.equal(d.extraction.fields.date.needsConfirmation,true);
  assert.equal(d.extraction.fields.due.needsConfirmation,true);
  assert.match(invoiceDateReviewIssue(d),/precedes.*both date formats/);
});

test('unambiguous, chronological dates stay supported without a warning',()=>{
  const d=parseExtractedText('Invoice No: 00456\nDate: 14 April 2030\nDue Date: 30 April 2030','invoice');
  assert.equal(d.date,'2030-04-14');
  assert.equal(d.due,'2030-04-30');
  assert.equal(invoiceDateReviewIssue(d),'');
});
