import {readDocumentMetadata} from './document-metadata.js';
import {arithmeticReview,FEE_KINDS} from './arithmetic.js';
import {readMoney, readSummary, readExchangeRate, sharedSymbols} from './invoice-money.js';

const amount = value => readMoney(value)?.value ?? null;
const aliases = {
 sku: /^(?:sku|code|item\s*(?:code|no\.?|number)|product\s*code)$/i,
 description: /^(?:description|details|product|item(?:\s*description)?|particulars|service)$/i,
 quantity: /^(?:qty\.?|quantity|units|hours|hrs\.?|days)(?:\s*\/\s*value)?$/i,
 unitPrice: /^(?:unit\s*(?:price|cost)|price|rate)$/i,
 tax: /^(?:vat|tax|gst)\s*(?:%|rate)$/i,
 amount: /^(?:amount|line\s*total|extended(?:\s*price)?|total)(?:\s+(?:excl\.?|incl\.?|net|gross))?$/i
};
export function groupPdfRows(items,page=1){
 const rows=[];
 for(const item of items.filter(i=>i.str?.trim()).sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4])){const y=item.transform[5];let row=rows.find(r=>Math.abs(r.y-y)<=3);if(!row){row={y,page,method:'pdf-text',tokens:[]};rows.push(row);}row.tokens.push({text:item.str,x:item.transform[4],width:item.width||0});}
 return rows.map(r=>{r.tokens.sort((a,b)=>a.x-b.x);return {...r,text:r.tokens.map(t=>t.text).join('  '),bbox:{x0:r.tokens[0].x,y0:r.y,x1:Math.max(...r.tokens.map(t=>t.x+t.width)),y1:r.y+12}};});
}
function columns(row){
 const cells=row.text.split(/\s*\|\s*|\t+| {2,}/).filter(Boolean);
 let headers=cells.map(c=>Object.keys(aliases).find(k=>aliases[k].test(c.trim())));
 
 const tokens=row.tokens||[];const mapped=[];
 for(let i=0;i<tokens.length;i++){let key;let count=1;for(const n of [3,2,1]){if(i+n>tokens.length)continue;const label=tokens.slice(i,i+n).map(t=>t.text.trim()).join(' ');key=Object.keys(aliases).find(k=>aliases[k].test(label));if(key){count=n;break;}}if(key){mapped.push({key,label:tokens.slice(i,i+count).map(t=>t.text.trim()).join(' '),x:tokens[i].x,right:tokens[i+count-1].x+tokens[i+count-1].width});i+=count-1;}}
 // "Item" beside a separate "Description" column holds the item code.
 const sku = (list, labels) => {const d=list.flatMap((k,i)=>k==='description'?[i]:[]);if(d.length>1&&!list.includes('sku'))list[d.find(i=>/^item$/i.test(labels[i].trim()))??d[1]]='sku';return list;};
 const keys=sku(mapped.map(c=>c.key),mapped.map(c=>c.label));mapped.forEach((c,i)=>{c.key=keys[i];});
 headers=sku(headers,cells);
 if(mapped.some(c=>c.key==='quantity')&&mapped.some(c=>c.key==='unitPrice'))return {positions:mapped,order:mapped.map(c=>c.key)};
 if(headers.includes('quantity')&&headers.includes('unitPrice'))return {headers,order:headers.filter(Boolean)};
 return null;
}

const numberToken = /^[$€£]?\d[\d,]*(?:\.\d{1,3})?$/;
// A code has letters and digits; one printed after the description must also contain a hyphen.
const skuLike = (s, after = false) => /^(?=.*\d)(?=.*[A-Z])[A-Z0-9][A-Z0-9._/-]{1,19}$/i.test(s) && (!after || s.includes('-'));
const centsOf = s => Math.round((readMoney(s)?.value ?? NaN) * 100);
/**
 * Splits a row such as "SMM-001 Social Media Strategy Plan $100.00 1 $100.00" into its columns
 * without a usable header. Trailing numbers are assigned by arithmetic (quantity × unit price =
 * amount), so a price printed before the quantity never lands in the description.
 * Returns null when the numbers cannot be assigned with confidence.
 */
export function splitLineRow(text, order = []) {
 const words = text.trim().split(/\s+/);
 const numbers = [];
 while (words.length > 1 && numbers.length < 4 && numberToken.test(words.at(-1))) numbers.unshift(words.pop());
 if (numbers.length < 2) return null;
 let sku = '';
 if (skuLike(words[0])) sku = words.shift();
 else if (words.length > 1 && skuLike(words.at(-1), true)) sku = words.pop();
 const description = words.join(' ');
 if (!description || numberToken.test(description)) return null;
 // Quantities carry no currency symbol and are not printed with exactly two decimals.
 const isQuantity = s => !/^[$€£]/.test(s) && !/\.\d{2}$/.test(s) && /^\d+(?:\.\d+)?$/.test(s.replace(/,/g, ''));
 const make = (q, p, a) => ({sku, description, quantity: readMoney(q, 3)?.value ?? null, unitPrice: amount(p), amount: a == null ? null : amount(a)});
 if (numbers.length === 2) return isQuantity(numbers[0]) && !isQuantity(numbers[1]) ? make(numbers[0], numbers[1], null) : null;
 // A fourth number is a converted amount in a second currency column; the line is read in the first.
 if (numbers.length === 4) {
  const [q, p, a] = numbers;
  const line = isQuantity(q) && Math.round(Number(q.replace(/,/g, '')) * centsOf(p)) === centsOf(a) ? make(q, p, a) : null;
  return line && {...line, convertedAmount: amount(numbers[3])};
 }
 const [a, b, c] = numbers;
 const fits = (q, p) => isQuantity(q) && Math.round(Number(q.replace(/,/g, '')) * centsOf(p)) === centsOf(c);
 const priceFirst = order.indexOf('unitPrice') !== -1 && order.indexOf('unitPrice') < order.indexOf('quantity');
 const options = [[a, b], [b, a]].filter(([q, p]) => fits(q, p));
 if (options.length === 2) return make(...(priceFirst ? [b, a] : [a, b]), c);
 if (options.length === 1) return make(...options[0], c);
 // Nothing reconciles: keep the printed amount and let arithmetic review flag the row.
 if (isQuantity(a) && !isQuantity(b)) return make(a, b, c);
 if (isQuantity(b) && !isQuantity(a)) return make(b, a, c);
 return null;
}
const columnDistance = (token, column) => Math.min(
 Math.abs(token.x - column.x), Math.abs(token.x + token.width - column.right)
);

function separateOcrPrice(token, description, prices, numericStart) {
 if (!description || token.x < description.x - 8 || token.x >= numericStart || !prices.length) return null;
 const source = token.text.trim();
 // Use an explicit currency marker to avoid splitting model numbers or measurements.
 const tail = source.match(/\s+((?:[A-Z]{0,3}[$€£₹¥₤]|[A-Z]{3}\s)\s*\d(?:[\d., '’]*\d)?)$/u);
 if (!tail || !readMoney(tail[1])?.marker) return null;
 const right = token.x + token.width;
 const start = token.x + token.width * (tail.index + tail[0].indexOf(tail[1])) / source.length;
 const price = {text:tail[1], x:start, width:right-start};
 const nearest = prices.reduce((best, column)=>columnDistance(price,column)<columnDistance(price,best)?column:best);
 // This is an estimated word boundary. Require the price run to reach its printed column.
 if (right < nearest.x || columnDistance(price, nearest) > Math.max(14, nearest.right-nearest.x)) return null;
 return {description:source.slice(0,tail.index), price:price.text, column:nearest.key};
}

function tableValues(row, table) {
 const values = {};
 if (!table.positions || !row.tokens?.length) {
  const cells = row.text.trim().split(/\s*\|\s*|\t+| {2,}/);
  if (cells.length === table.headers?.length) table.headers.forEach((key,i)=>{if(key)values[key]=cells[i];});
  return values;
 }
 const positions = table.positions;
 const numeric = positions.filter(c=>!['description','sku'].includes(c.key));
 const text = positions.filter(c=>['description','sku'].includes(c.key));
 const description = text.find(c=>c.key==='description');
 const prices = numeric.filter(c=>['unitPrice','amount'].includes(c.key));
 const numericStart = numeric[0].x - 14;
 const append = (key, value) => { values[key] = [values[key],value].filter(Boolean).join(' '); };
 for (const token of row.tokens) {
  const split = row.method==='ocr' && separateOcrPrice(token,description,prices,numericStart);
  if (split) {
   append('description',split.description);
   append(split.column,split.price);
   values.recoveredPrice = true;
   continue;
  }
  const column = token.x < numericStart && text.length
   ? text.findLast(c=>token.x>=c.x-8) ?? text[0]
   : numeric.reduce((best,c)=>columnDistance(token,c)<columnDistance(token,best)?c:best);
  append(column.key,token.text.trim());
 }
 return values;
}

function tableLine(values) {
 const rate = values.unitPrice?.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
 const quantity = readMoney(values.quantity, rate ? 3 : 2)?.value ?? null;
 const unitPrice = amount(values.unitPrice);
 const printed = amount(values.amount);
 if (values.recoveredPrice && values.description && (unitPrice != null || printed != null)) {
  // Keep the recoverable fields even if OCR missed the quantity or another amount.
  return {sku:values.sku || '', description:values.description, quantity, unitPrice, amount:printed};
 }
 if (quantity == null || (unitPrice == null && (!rate || printed == null))) return null;
 return {
  sku: values.sku || '', description: values.description || '', quantity, unitPrice, amount: printed,
  ...(rate ? {ratePercent:Number(rate[1].replace(',','.'))} : {})
 };
}
export function parseLayoutText(text,kind,layout=[]){
 const inputRows=layout.length?layout:text.split(/\r?\n/).map((text,i)=>({text,page:1,row:i+1,method:'text'}));
 // Label-only rows are common in PDFs with stacked metadata. Preserve both source passages.
 const standalone=/^(?:vendor|supplier|seller|from|invoice(?:\s*(?:number|no\.?|#))?|purchase\s*order(?:\s*(?:number|no\.?|reference))?|p\.?o\.?(?: reference)?|currency|invoice date|issue date|due date|subtotal|sub total|tax|vat|grand total|total|amount due|balance due)\s*[:#]?$/i;
 const rawRows=[];for(let i=0;i<inputRows.length;i++){const r=inputRows[i],next=inputRows[i+1];if(!r.gridCells&&standalone.test(r.text.trim())&&next&&!next.gridCells&&!(/^invoice$/i.test(r.text.trim())&&/\s/.test(next.text.trim()))&&r.page===next.page&&!standalone.test(next.text.trim())&&!readSummary(next.text.trim())&&!/[:#]/.test(next.text)&&next.text.trim()){rawRows.push({...r,text:r.text.trim().replace(/[:#]$/,'')+': '+next.text.trim(),sourceRows:[r,next]});i++;}else rawRows.push(r);}
 const rows=rawRows.flatMap(row=>row.gridCells?[row]:row.text.split(/ {2,}(?=(?:vendor|supplier|seller|from|invoice(?:\s+(?:no\.?|number|date))?|purchase order|po(?: reference)?|currency|due(?: date)?|subtotal|tax|total)\s*[:#])/i).map(text=>({...row,text})));
 const d={type:kind,vendor:'',customer:'',number:'',poNumber:'',currency:'',date:'',due:'',subtotal:null,tax:null,taxRate:null,total:null,shipping:null,discount:null,lines:[],note:'Extracted values require source verification.'};
 const fields={};const set=(key,value,row,support='supported',reason='')=>{if(row.method==='ocr'&&(!Number.isFinite(row.ocrConfidence)||row.ocrConfidence<80))support='uncertain';const evidence={text:row.sourceRows?row.sourceRows.map(r=>r.text).join(' → '):row.text,page:row.page||1,row:row.sourceRows?.[0]?.row||row.row||Math.max(0,inputRows.indexOf(row.sourceRows?.[0]||row),rows.indexOf(row))+1,bbox:row.bbox||null,method:row.method||'text',...(row.coordinateSpace?{coordinateSpace:row.coordinateSpace}:{})};if(fields[key]&&JSON.stringify(fields[key].value)!==JSON.stringify(value)){fields[key].support='uncertain';fields[key].reason='Conflicting labeled values; verify the source.';fields[key].evidence.push(evidence);return;}if(fields[key]?.support==='uncertain'&&!reason){support='uncertain';reason=fields[key].reason;}fields[key]={value,support,reason:reason||(support==='supported'?'Explicit label or recognized table column.':row.method==='ocr'?'OCR or column interpretation needs verification against the source.':'Inferred from row pattern; verify against the source.'),evidence:[...(fields[key]?.evidence||[]),evidence]};if(!key.includes('.'))d[key]=value;};
 readDocumentMetadata(inputRows.filter(row=>!row.gridCells),kind,fields,set);
 const summaries=[];let exchange=null;
 let table=null, page;
 for(const row of rows){
  if(row.page!==page){table=null;page=row.page;}
  const t=row.text.trim();
  if (/^(?:brought|carried)\s+forward\b/i.test(t)) continue;
  if(row.gridCells){
   const {description,quantity,unitPrice,amount:printed}=row.gridCells;
   const line={sku:'',description,quantity:readMoney(quantity,3)?.value??null,unitPrice:amount(unitPrice),amount:amount(printed)};
   const index=d.lines.length;
   d.lines.push(line);
   for(const [key,value] of Object.entries(line))set(`lines.${index}.${key}`,value,row,'uncertain','Read from a ruled table cell. Verify against the original invoice.');
   table=null;
   continue;
  }
  if(!t)continue;
  const supplierId = t.match(/^(?:supplier\s*id|vendor\s*id|tax\s*id)\s*[:#]\s*(.+)$/i);
  if(supplierId){set('supplierId',supplierId[1].trim(),row);continue;}
  const rateLine=t.match(/^(?:vat|tax)\s+rate\s*:?\s*(\d+(?:[.,]\d+)?)\s*%$/i);
  if(rateLine){set('taxRate',Number(rateLine[1].replace(',','.')),row);continue;}
  const fx=!exchange&&readExchangeRate(t);
  if(fx){exchange={...fx,row};continue;}
  const summary=readSummary(t,Boolean(table));
  if(summary){summaries.push({...summary,row});table=null;continue;}
 const head=columns(row);if(head){table=head;continue;}
 let l=null,support='supported';
 if(table){
  const values=tableValues(row,table);
  l=tableLine(values);
  if(values.recoveredPrice) support='uncertain';
 }
 // A money value inside the description means the columns were misread; split the row by arithmetic instead.
 if(l&&/[$€£]?\d[\d,]*\.\d{2}\s*$/.test(l.description||'')){const split=splitLineRow(t,table?.order);if(split){l=split;support='uncertain';}}
 if(!l){l=splitLineRow(t,table?.order);if(l)support='uncertain';}
 // Last resort for garbled rows: keep the line with a blank amount so totals stay uncertain rather
 // than contradicted. A first word only counts as the SKU when it looks like a code.
 if(!l){const m=t.match(/^(\S+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})(?:\s+\$?([\d,]+\.\d{2}))?$/);if(m){const code=skuLike(m[1]);l={sku:code?m[1]:'',description:code?m[2]:`${m[1]} ${m[2]}`,quantity:Number(m[3]),unitPrice:amount(m[4]),amount:amount(m[5])};support='uncertain';}}
 if(l){const n=d.lines.length;d.lines.push(l);for(const key of Object.keys(l))set(`lines.${n}.${key}`,l[key],row,l[key]==null||l[key]===''?'uncertain':support);}
 else if(table?.positions&&d.lines.length&&!/\d/.test(t)&&row.tokens?.length&&
   Math.abs(row.tokens[0].x-(table.positions.find(c=>c.key==='description')?.x??Infinity))<=10&&
   !/^(?:continued|payment|terms|thank|page|bank)\b/i.test(t)){
   const line=d.lines.at(-1), key=`lines.${d.lines.length-1}.description`;
   const previous=fields[key].evidence.at(-1);
   delete fields[key];
   line.description+=(line.description?' ':'')+t;
   set(key,line.description,{...row,sourceRows:[previous,row]},'uncertain');
 }
 }
 // OCR reads a leading I or O as 1 or 0. When the other item codes start with letters, offer both
 // readings for confirmation instead of keeping or silently changing the code.
 const letterCodes = d.lines.filter(l=>/^[A-Z]{2,}/i.test(l.sku||'')).length;
 d.lines.forEach((l,i)=>{
  const m=(l.sku||'').match(/^([01])([A-Z]{1,5})(?=[-\d])/i);
  const key=`lines.${i}.sku`;
  if(!m||!fields[key]||!fields[key].evidence.some(e=>e.method==='ocr')||letterCodes<2)return;
  const alternative=(m[1]==='1'?'I':'O')+l.sku.slice(1);
  Object.assign(fields[key],{support:'uncertain',needsConfirmation:true,
   reason:`"${l.sku}" starts with ${m[1]}, which OCR often reads for ${m[1]==='1'?'I':'O'}; the other item codes start with letters. Confirm the code.`,
   candidates:[{value:l.sku,label:`${l.sku} (as read)`},{value:alternative,label:alternative}]});
 });
 // The same confusion in a PO reference ("P0-2030-077") stops the purchase order from linking.
 const po=fields.poNumber;
 if(po&&typeof po.value==='string'&&/^P0(?=[-\s#/]?\d)/i.test(po.value)&&po.evidence.some(e=>e.method==='ocr')){
  const alternative=po.value.replace(/^(P)0/i,'$1O');
  Object.assign(po,{support:'uncertain',needsConfirmation:true,
   reason:`"${po.value}" starts with P0; OCR often reads the letter O as zero in "PO". Confirm the purchase-order reference.`,
   candidates:[{value:alternative,label:alternative},{value:po.value,label:`${po.value} (as read)`}]});
 }
 const context = inputRows.map(r=>r.text).join(' ');
 const usAddress = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/;
 const totalKeys = ['total','amountDue','referenceTotal'];
 const isReference = s => s.key==='referenceTotal'||s.reference;
 // A shared symbol ($, R, kr, ¥, £) resolves only through a currency named by the printed exchange rate.
 const rowCurrency = s => s.currency || (exchange && (sharedSymbols[s.marker]||[]).find(c=>c===exchange.base||c===exchange.quote)) || '';

 // Currencies: the line-item (pricing) currency and the payable currency are kept separately.
 let pricing = summaries.find(s=>!totalKeys.includes(s.key)&&s.currency)?.currency || fields.currency?.value || '';
 if(!pricing) pricing = summaries.find(s=>totalKeys.includes(s.key)&&!isReference(s)&&s.currency)?.currency || '';
 const foreign = s => totalKeys.includes(s.key) && s.value!=null && Boolean(pricing) && Boolean(rowCurrency(s)) && rowCurrency(s)!==pricing;
 const payableRows = summaries.filter(s=>foreign(s)&&!isReference(s));
 const payable = payableRows.length && (exchange||summaries.some(s=>totalKeys.includes(s.key)&&!foreign(s)&&s.value!=null))
   ? payableRows.find(s=>s.key==='amountDue')||payableRows.at(-1) : null;
 const inPricing = s => !foreign(s);
 if(payable){
  const code=rowCurrency(payable);
  set('currency',code,payable.row,payable.currency?'supported':'uncertain',payable.currency?'Currency of the amount payable.':`The ${payable.marker} symbol matches ${code} in the printed exchange rate. Confirm the payable currency.`);
  const pricingRow=summaries.find(s=>inPricing(s)&&!isReference(s)&&s.currency)?.row||summaries.find(s=>inPricing(s))?.row||payable.row;
  set('pricingCurrency',pricing,pricingRow,'supported','Currency of the line items and subtotal.');
  set('total',payable.value,payable.row);
 } else for(const s of summaries) {
  if(s.currency && !(isReference(s)&&s.currency!==pricing) && !fields.currency?.evidence.some(e=>e.page===s.row.page&&e.text.trim()===s.row.text.trim()))set('currency',s.currency,s.row);
 }
 const payableCurrency = payable ? rowCurrency(payable) : pricing;
 const reference = summaries.find(s=>isReference(s)&&s.value!=null&&rowCurrency(s)&&rowCurrency(s)!==payableCurrency);
 if(reference){set('referenceTotal',reference.value,reference.row,'supported','Printed for reference only; not the amount payable.');d.referenceTotal={currency:rowCurrency(reference),value:reference.value};}
 if(exchange)set('exchangeRate',exchange.rate,exchange.row,exchange.base?'supported':'uncertain',exchange.base?'Printed exchange rate.':'Exchange rate printed without its currencies; direction assumed from pricing to payable currency.');

 if(!fields.currency){
  const shared = summaries.find(s=>!s.currency&&sharedSymbols[s.marker]);
  if(shared){
   const candidates = sharedSymbols[shared.marker];
   const usRows = shared.marker==='$' ? inputRows.slice(0,18).filter(r=>usAddress.test(r.text)) : [];
   const signals = {USD:usRows.length===1||usRows.length===2, ZAR:/\+27\b|\.co\.za\b/.test(context), ZMW:/\+260\b|\.co\.zm\b/.test(context),
    GBP:/\+44\b|\.co\.uk\b|United Kingdom|\bGB\s?\d{9}\b/.test(context), CAD:/\.ca\b|Canada\b|\b[A-Z]\d[A-Z] \d[A-Z]\d\b/.test(context), AUD:/\+61\b|\.com\.au\b|Australia\b/.test(context),
    JPY:/\+81\b|\.jp\b|Japan\b/.test(context), CNY:/\+86\b|\.cn\b|China\b/.test(context), SEK:/\+46\b|\.se\b|Sweden\b/.test(context),
    NOK:/\+47\b|\.no\b|Norway\b/.test(context), DKK:/\+45\b|\.dk\b|Denmark\b/.test(context)};
   const named = candidates.filter(c=>new RegExp(`\\b${c}\\b`).test(context));
   const signalled = named.length===1 ? named : candidates.filter(c=>signals[c]);
   if(signalled.length===1){
    const code=signalled[0], address=code==='USD'&&!named.length;
    set('currency',code,address?{...shared.row,sourceRows:[shared.row,...usRows]}:shared.row,'uncertain',
     named.length?`The ${shared.marker} symbol with ${code} named in the document. Confirm the currency.`
     :code==='ZAR'?'Rand notation and South African supplier details. Confirm currency.':code==='ZMW'?'Kwacha notation and Zambian supplier details. Confirm currency.'
     :address?'Dollar amount and US address. Confirm the billing currency.':`The ${shared.marker} symbol with regional supplier details. Confirm the currency.`);
   } else if(!['R','K'].includes(shared.marker)) {
    set('currency','',shared.row,'uncertain',`The ${shared.marker} symbol is shared by several currencies${candidates.length?` (${candidates.join(', ')})`:''}; confirm the currency.`);
    Object.assign(fields.currency,{needsConfirmation:true,candidates:candidates.map(value=>({value,label:value}))});
   }
  }
 }

 // Amounts in the pricing currency.
 const exclusive = summaries.find(s=>s.key==='subtotalExclusive');
 const included = summaries.some(s=>s.included);
 const grossSubtotal = summaries.find(s=>s.key==='subtotal');
 const flagUnreadable = (key,s)=>{set(key,null,s.row,'uncertain',`An amount is printed here ("${s.text}") but could not be read. It stays unknown, not zero; enter it from the original.`);Object.assign(fields[key],{needsConfirmation:true,candidates:[]});};
 const priced = summaries.filter(s=>inPricing(s)&&!(isReference(s)&&totalKeys.includes(s.key)));
 const firstTotal = priced.findIndex(s=>s.key==='total');
 const adjustmentRows = priced.filter(s=>s.key==='adjustment');
 const balanceStage = s => s.kind==='payment' || (firstTotal>=0 && priced.indexOf(s)>firstTotal);
 const hasBalance = adjustmentRows.some(balanceStage);
 const totalKey = payable ? 'pricingTotal' : 'total';
 d.adjustments = adjustmentRows.map((s,i)=>{
  const path=`adjustments.${i}`;
  if(s.unreadable)flagUnreadable(path,s);else set(path,s.value,s.row);
  return {kind:s.kind,description:s.label,cents:s.value==null?null:Math.round(s.value*100),taxable:s.taxable,appliesTo:balanceStage(s)?'balance':'total',
   ...(s.rate!=null?{ratePercent:s.rate}:{}),sourceText:s.row.text,evidence:fields[path].evidence,path};
 });
 let taxRows = priced.filter(s=>s.key==='tax');
 const taxTotal = priced.find(s=>s.key==='taxTotal');
 if(taxTotal && !taxRows.length) taxRows=[taxTotal];
 else if(taxTotal){if(taxTotal.unreadable)flagUnreadable('taxTotal',taxTotal);else set('taxTotal',taxTotal.value,taxTotal.row);}
 d.taxes = taxRows.map((s,i)=>{
  const path=`taxes.${i}`;
  if(s.unreadable)flagUnreadable(path,s);else set(path,s.value,s.row,'supported',s.treatment?`Printed as ${s.treatment.replace('_','-')}; a valid zero tax, not an error.`:'');
  return {label:s.label,ratePercent:s.rate,basisCents:s.basis==null?null:Math.round(s.basis*100),cents:s.value==null?null:Math.round(s.value*100),
   ...(s.treatment?{treatment:s.treatment}:{}),...(s.included?{included:true}:{}),sourceText:s.row.text,evidence:fields[path].evidence,path};
 });
 if(taxRows.length===1){const [s]=taxRows;if(s.unreadable)flagUnreadable('tax',s);else set('tax',s.value,s.row);if(s.rate!=null)set('taxRate',s.rate,s.row);}
 else if(taxRows.length){
  const known=d.taxes.every(t=>Number.isSafeInteger(t.cents));
  set('tax',known?d.taxes.reduce((sum,t)=>sum+t.cents,0)/100:null,{...taxRows[0].row,sourceRows:taxRows.map(s=>s.row)},known?'supported':'uncertain',
   known?`Sum of ${taxRows.length} separately listed taxes.`:'One of the listed taxes is unreadable, so the tax total is unknown.');
 }
 for(const s of priced) {
  if(s.key==='subtotalExclusive')set('subtotal',s.value,s.row);
  else if(s.key==='subtotal'&&!exclusive&&!included){if(s.unreadable)flagUnreadable('subtotal',s);else set('subtotal',s.value,s.row);}
  else if(s.key==='taxableAmount'&&s.value!=null)set(priced.some(x=>/^subtotal/.test(x.key))?'taxableAmount':'subtotal',s.value,s.row);
  else if(s.key==='total'&&!isReference(s)&&s.value!=null)set(totalKey,s.value,s.row);
  else if(s.key==='amountDue'&&s.value!=null){
   set('amountDue',s.value,s.row);
   // Without payments or credits below the total, the balance due is the invoice total; a different value is a conflict to review.
   if(!hasBalance)set(totalKey,s.value,s.row);
  }
 }
 if(!fields[totalKey]){const s=priced.find(x=>['total','amountDue'].includes(x.key)&&x.unreadable);if(s)flagUnreadable(totalKey,s);}
 const fee=d.adjustments.filter(a=>FEE_KINDS.includes(a.kind)&&a.cents!=null), off=d.adjustments.filter(a=>['discount','credit_applied'].includes(a.kind)&&a.appliesTo==='total'&&a.cents!=null);
 d.shipping=fee.length?fee.reduce((s,a)=>s+a.cents,0)/100:null;
 d.discount=off.length?-off.reduce((s,a)=>s+a.cents,0)/100:null;
 if(included&&!exclusive&&d.tax!=null&&(grossSubtotal||d.total!=null)){
  const gross=grossSubtotal?.value??d.total;
  const basis=grossSubtotal?.row??priced.find(s=>s.key==='total'||s.key==='amountDue').row;
  const tax=taxRows[0].row;
  if(gross>=d.tax)set('subtotal',Math.round(gross*100-d.tax*100)/100,{...basis,sourceRows:[basis,tax]},'uncertain','Net subtotal calculated from the tax-inclusive amount minus the displayed tax.');
 }
 d.taxInclusive=included;
 if(kind==='purchase_order'){d.number=d.poNumber;fields.number=fields.poNumber;}
 for(const key of ['vendor','number','poNumber','currency','subtotal','tax','total'])if(!fields[key])fields[key]={value:d[key],support:'missing',reason:key==='poNumber'?'No PO reference found. Leave blank if the document does not list one.':key==='vendor'?'No supplier identified. Check the issuer or letterhead.':'No unambiguous labeled value found.',evidence:[]};
 d.extraction={method:'layout-aware-v1',confidenceMeaning:'Heuristic support labels, not calibrated probabilities.',fields,ruledTable:inputRows.some(row=>row.gridCells)};
 if(exchange)d.exchangeRate={base:exchange.base,quote:exchange.quote,rate:exchange.rate,decimals:exchange.decimals,sourceText:exchange.sourceText,evidence:fields.exchangeRate.evidence};
 d.arithmeticReview=arithmeticReview(d);
 d.arithmetic=[...d.arithmeticReview.contradictions,...d.arithmeticReview.conversions.filter(c=>c.status==='contradiction')];
 for(const c of d.arithmetic)if(fields[c.path]){fields[c.path].support='inconsistent';fields[c.path].reason=c.message;}
 // Likely OCR misreads must be confirmed or corrected by the reviewer before the invoice can be classed as erroneous.
 for(const c of d.arithmeticReview.uncertain)for(const s of c.suspects||[])if(fields[s.path]&&s.quantity)Object.assign(fields[s.path],{support:'uncertain',needsConfirmation:true,
  reason:`OCR may have dropped a decimal point in this quantity: ${s.quantity.read} as read; ${s.quantity.candidate} reconciles with the unit price and the printed amount. Confirm against the original.`,
  candidates:[{value:s.quantity.candidate,label:`${s.quantity.candidate} would reconcile`},{value:s.quantity.read,label:`${s.quantity.read} as read by OCR`}]});
 for(const c of d.arithmeticReview.uncertain)for(const s of c.suspects||[])if(fields[s.path]&&!s.quantity)Object.assign(fields[s.path],{support:'uncertain',reason:`OCR may have misread this amount: ${(s.readCents/100).toFixed(2)} as read; ${(s.candidateCents/100).toFixed(2)} would make “${c.label}” reconcile.`,needsConfirmation:true,suspectedBy:c.code,
  candidates:[{value:s.readCents/100,label:`${(s.readCents/100).toFixed(2)} as read by OCR`},{value:s.candidateCents/100,label:`${(s.candidateCents/100).toFixed(2)} would reconcile`}]});
 return d;
}
