import {arithmeticChecks} from './arithmetic.js';
import {supplierEvidence} from './supplier.js';
import {cents,money} from './engine.js';
const norm=s=>s.trim().toLowerCase();
export function validateDocument(d,kind){
 if(d?.type==='credit_note')throw Error('Credit notes are unsupported in this demo. Keep this credit separate; it must not be processed as a payable invoice.');
 if(!d||typeof d!=='object'||d.type!==kind)throw Error(`Choose a ${kind==='invoice'?'invoice':'purchase order'} JSON document with the correct type.`);
 for(const k of ['number','vendor','poNumber','currency'])if(typeof d[k]!=='string'||!d[k].trim()||d[k].length>150)throw Error(`Document needs a valid ${k}.`);
 if(d.currency!=='USD')throw Error('This demo supports USD documents only.');
 if(!Array.isArray(d.lines)||!d.lines.length||d.lines.length>100)throw Error('Include between 1 and 100 line items.');
 const seen=new Set();for(const l of d.lines){if(!l||typeof l.sku!=='string'||!l.sku.trim()||typeof l.description!=='string')throw Error('Every line needs an SKU and description.');if(seen.has(norm(l.sku)))throw Error('Each SKU must appear only once per document.');seen.add(norm(l.sku));if(!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>100000||typeof l.unitPrice!=='number'||!Number.isFinite(l.unitPrice)||l.unitPrice<0||l.unitPrice>1000000||Math.abs(l.unitPrice*100-cents(l.unitPrice))>0.00001)throw Error('Use positive whole-number quantities and nonnegative prices with at most two decimals.');}
 for(const k of ['tax','total'])if(typeof d[k]!=='number'||!Number.isFinite(d[k])||d[k]<0||Math.abs(d[k]*100-cents(d[k]))>0.00001)throw Error(`Document needs a nonnegative ${k} with at most two decimals.`);
 for(const [key,value] of [['subtotal',d.subtotal],['taxRate',d.taxRate],...d.lines.map((l,i)=>[`line ${i+1} amount`,l.amount])])if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000||Math.abs(value*100-cents(value))>0.00001))throw Error(`Invalid ${key}. Use a nonnegative number with at most two decimals.`);
 if(kind==='purchase_order'&&norm(d.number)!==norm(d.poNumber))throw Error('Purchase order number must match its poNumber.');return d;
}
export function compareDocuments(invoice,po){
 validateDocument(invoice,'invoice');validateDocument(po,'purchase_order');
 const vendorEvidence=supplierEvidence(invoice,po);
 if(norm(invoice.poNumber)!==norm(po.number))throw Error('Purchase order reference mismatch. Select the PO referenced on the invoice.');
 const skus=[...new Set([...po.lines,...invoice.lines].map(l=>norm(l.sku)))];
 const lines=skus.map(sku=>{const i=invoice.lines.find(l=>norm(l.sku)===sku),p=po.lines.find(l=>norm(l.sku)===sku);const invoiced=i?i.quantity*cents(i.unitPrice):0,expected=p?p.quantity*cents(p.unitPrice):0;return {sku:i?.sku||p.sku,description:i?.description||p.description,invoice:i||null,po:p||null,invoicedCents:invoiced,expectedCents:expected,differenceCents:invoiced-expected,changed:!i||!p||i.quantity!==p.quantity||cents(i.unitPrice)!==cents(p.unitPrice),invoiceLine:i?invoice.lines.indexOf(i)+1:null,poLine:p?po.lines.indexOf(p)+1:null};});
 const arithmetic=[...arithmeticChecks(invoice).map(c=>({...c,document:'invoice'})),...arithmeticChecks(po).map(c=>({...c,document:'purchase_order'}))];
 const taxDifferenceCents=cents(invoice.tax)-cents(po.tax),differenceCents=cents(invoice.total)-cents(po.total);return {vendorEvidence,arithmetic,lines,taxDifferenceCents,differenceCents,hasDiscrepancy:lines.some(l=>l.changed)||taxDifferenceCents!==0||differenceCents!==0||arithmetic.length>0,invoiceTotal:invoice.total,poTotal:po.total};
}
export function correctionDraft(invoice,po,result){
 const evidence=result.lines.filter(l=>l.changed).map(l=>`${l.sku} (${l.description}): invoice line ${l.invoiceLine??'missing'} shows ${l.invoice?`${l.invoice.quantity} × ${money(l.invoice.unitPrice)}`:'no item'}; PO line ${l.poLine??'missing'} shows ${l.po?`${l.po.quantity} × ${money(l.po.unitPrice)}`:'no item'}. Line difference: ${money(l.differenceCents/100)}.`);
 for(const check of result.arithmetic||[])evidence.push(`${check.document==='invoice'?'Invoice':'PO'} arithmetic: ${check.message}`);
 if(result.taxDifferenceCents)evidence.push(`Tax: invoice ${money(invoice.tax)}; PO ${money(po.tax)}.`);
 return `Subject: Please review invoice ${invoice.number} against ${po.number}\n\nHello ${invoice.vendor},\n\nWhile reviewing invoice ${invoice.number}, we found differences from purchase order ${po.number}:\n\n${evidence.join('\n')}\n\nThe invoice total is ${money(invoice.total)} and the purchase order total is ${money(po.total)}, a net difference of ${money(result.differenceCents/100)}. Please confirm the differences and provide a corrected invoice, or the documentation authorizing any changes.\n\nThis invoice remains on hold pending review.\n\nThank you,\nOak & Elm Creative\n\n[Draft only — review before sending]`;
}
export function reviewedExport(invoice,po,result,reviewed){if(!reviewed)throw Error('Confirm your evidence review before exporting.');return {schemaVersion:2,arithmetic:result.arithmetic||[],supplierEvidence:result.vendorEvidence,supplierReview:invoice.supplierReview||null,invoiceNumber:invoice.number,purchaseOrderNumber:po.number,vendor:invoice.vendor,currency:'USD',invoiceTotal:invoice.total,purchaseOrderTotal:po.total,netDifference:result.differenceCents/100,reviewStatus:'evidence_reviewed',resolutionStatus:result.hasDiscrepancy?'awaiting_vendor_correction':'matched_pending_user_approval',paymentStatus:result.hasDiscrepancy?'ON_HOLD':'NOT_APPROVED',paymentApproved:false,lines:result.lines.map(l=>({sku:l.sku,invoiceLine:l.invoiceLine,poLine:l.poLine,invoiceQuantity:l.invoice?.quantity??null,poQuantity:l.po?.quantity??null,invoiceUnitPrice:l.invoice?.unitPrice??null,poUnitPrice:l.po?.unitPrice??null,difference:l.differenceCents/100,changed:l.changed})),reviewedAt:new Date().toISOString()};}
export function reviewCsv(data){const cell=v=>'"'+String(v??'').replace(/^[\s]*[=+@\-]/,"'$&").replaceAll('"','""')+'"';const keys=['invoiceNumber','purchaseOrderNumber','vendor','currency','invoiceTotal','purchaseOrderTotal','netDifference','reviewStatus','resolutionStatus','paymentStatus','paymentApproved'];return keys.join(',')+'\r\n'+keys.map(k=>cell(data[k])).join(',');}
