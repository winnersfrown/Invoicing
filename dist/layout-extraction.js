import {readDocumentMetadata} from './document-metadata.js';
import {arithmeticChecks} from './arithmetic.js';
import {readMoney, readSummary} from './invoice-money.js';

const amount = value => readMoney(value)?.value ?? null;
const aliases = {
 sku: /^(?:sku|code|item\s*(?:code|no\.?|number)|product\s*code)$/i,
 description: /^(?:description|details|product|item(?:\s*description)?|particulars|service)$/i,
 quantity: /^(?:qty\.?|quantity|units)(?:\s*\/\s*value)?$/i,
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
 for(let i=0;i<tokens.length;i++){let key;let count=1;for(const n of [3,2,1]){if(i+n>tokens.length)continue;const label=tokens.slice(i,i+n).map(t=>t.text.trim()).join(' ');key=Object.keys(aliases).find(k=>aliases[k].test(label));if(key){count=n;break;}}if(key){mapped.push({key,x:tokens[i].x,right:tokens[i+count-1].x+tokens[i+count-1].width});i+=count-1;}}
 if(mapped.some(c=>c.key==='quantity')&&mapped.some(c=>c.key==='unitPrice'))return {positions:mapped};
 if(headers.includes('quantity')&&headers.includes('unitPrice'))return {headers};
 return null;
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
 for (const token of row.tokens) {
  const numericStart = numeric[0].x - 14;
  const column = token.x < numericStart && text.length
   ? text.findLast(c=>token.x>=c.x-8) ?? text[0]
   : numeric.reduce((best,c)=>{
      const distance = anchor => Math.min(Math.abs(token.x-anchor.x), Math.abs(token.x+token.width-anchor.right));
      return distance(c)<distance(best)?c:best;
    });
  values[column.key] = [values[column.key],token.text.trim()].filter(Boolean).join(' ');
 }
 return values;
}

function tableLine(values) {
 const rate = values.unitPrice?.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
 const quantity = readMoney(values.quantity, rate ? 3 : 2)?.value ?? null;
 const unitPrice = amount(values.unitPrice);
 const printed = amount(values.amount);
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
 const rawRows=[];for(let i=0;i<inputRows.length;i++){const r=inputRows[i],next=inputRows[i+1];if(!r.gridCells&&standalone.test(r.text.trim())&&next&&!next.gridCells&&!(/^invoice$/i.test(r.text.trim())&&/\s/.test(next.text.trim()))&&r.page===next.page&&!standalone.test(next.text.trim())&&!/[:#]/.test(next.text)&&next.text.trim()){rawRows.push({...r,text:r.text.trim().replace(/[:#]$/,'')+': '+next.text.trim(),sourceRows:[r,next]});i++;}else rawRows.push(r);}
 const rows=rawRows.flatMap(row=>row.gridCells?[row]:row.text.split(/ {2,}(?=(?:vendor|supplier|seller|from|invoice(?:\s+(?:no\.?|number|date))?|purchase order|po(?: reference)?|currency|due(?: date)?|subtotal|tax|total)\s*[:#])/i).map(text=>({...row,text})));
 const d={type:kind,vendor:'',customer:'',number:'',poNumber:'',currency:'',date:'',due:'',subtotal:null,tax:null,taxRate:null,total:null,shipping:null,discount:null,lines:[],note:'Extracted values require source verification.'};
 const fields={};const set=(key,value,row,support='supported',reason='')=>{if(row.method==='ocr'&&(!Number.isFinite(row.ocrConfidence)||row.ocrConfidence<80))support='uncertain';const evidence={text:row.sourceRows?row.sourceRows.map(r=>r.text).join(' → '):row.text,page:row.page||1,row:row.sourceRows?.[0]?.row||row.row||Math.max(0,inputRows.indexOf(row.sourceRows?.[0]||row),rows.indexOf(row))+1,bbox:row.bbox||null,method:row.method||'text',...(row.coordinateSpace?{coordinateSpace:row.coordinateSpace}:{})};if(fields[key]&&JSON.stringify(fields[key].value)!==JSON.stringify(value)){fields[key].support='uncertain';fields[key].reason='Conflicting labeled values; verify the source.';fields[key].evidence.push(evidence);return;}if(fields[key]?.support==='uncertain'&&!reason){support='uncertain';reason=fields[key].reason;}fields[key]={value,support,reason:reason||(support==='supported'?'Explicit label or recognized table column.':row.method==='ocr'?'OCR or column interpretation needs verification against the source.':'Inferred from row pattern; verify against the source.'),evidence:[...(fields[key]?.evidence||[]),evidence]};if(!key.startsWith('lines.'))d[key]=value;};
 readDocumentMetadata(inputRows.filter(row=>!row.gridCells),kind,fields,set);
 const summaries=[];
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
  const summary=readSummary(t,Boolean(table));
  if(summary){summaries.push({...summary,row});table=null;continue;}
 const head=columns(row);if(head){table=head;continue;}
 let l=null,support='supported';
 if(table) l=tableLine(tableValues(row,table));
 if(!l){const m=t.match(/^([\w-]+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})(?:\s+\$?([\d,]+\.\d{2}))?$/);if(m){l={sku:m[1],description:m[2],quantity:Number(m[3]),unitPrice:amount(m[4]),amount:amount(m[5])};support='uncertain';}}
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
 const exclusive = summaries.find(s=>s.key==='subtotalExclusive');
 const included = summaries.some(s=>s.included);
 const context = inputRows.map(r=>r.text).join(' ');
 const usAddress = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/;
 const dollarSummary = summaries.find(s=>s.marker==='$');

 const grossSubtotal = summaries.find(s=>s.key==='subtotal');
 for(const summary of summaries) {
  const {key,value,row,currency,rate}=summary;
  if(currency && !fields.currency?.evidence.some(e=>e.page===row.page&&e.text.trim()===row.text.trim()))set('currency',currency,row);
  if(key==='subtotalExclusive')set('subtotal',value,row);
  else if(key!=='subtotal'||(!exclusive&&!included))set(key,value,row);
  if(key==='tax'&&rate!=null)set('taxRate',rate,row);
 }
 if(!fields.currency){
  const region = summaries.find(s=>s.marker==='R'||s.marker==='K');
  if(region?.marker==='R'&&/\+27\b|\.co\.za\b/.test(context))set('currency','ZAR',region.row,'uncertain','Rand notation and South African supplier details. Confirm currency.');
  if(region?.marker==='K'&&/\+260\b|\.co\.zm\b/.test(context))set('currency','ZMW',region.row,'uncertain','Kwacha notation and Zambian supplier details. Confirm currency.');
 }
 if(!fields.currency && dollarSummary) {
  const usRows=inputRows.slice(0,18).filter(r=>usAddress.test(r.text));
  if(usRows.length===1||usRows.length===2) {
   const rows=[dollarSummary.row,...usRows];
   set('currency','USD',{...dollarSummary.row,sourceRows:rows},'uncertain','Dollar amount and US address. Confirm the billing currency.');
  } else set('currency','',dollarSummary.row,'uncertain','The dollar symbol needs currency confirmation.');
 }
 if(included&&!exclusive&&d.tax!=null&&(grossSubtotal||d.total!=null)){
  const gross=grossSubtotal?.value??d.total;
  const basis=grossSubtotal?.row??summaries.find(s=>s.key==='total').row;
  const tax=summaries.find(s=>s.key==='tax').row;
  if(gross>=d.tax)set('subtotal',Math.round(gross*100-d.tax*100)/100,{...basis,sourceRows:[basis,tax]},'uncertain','Net subtotal calculated from the tax-inclusive amount minus the displayed tax.');
 }
 d.taxInclusive=included;
 if(kind==='purchase_order'){d.number=d.poNumber;fields.number=fields.poNumber;}
 for(const key of ['vendor','number','poNumber','currency','subtotal','tax','total'])if(!fields[key])fields[key]={value:d[key],support:'missing',reason:key==='poNumber'?'No PO reference found. Leave blank if the document does not list one.':key==='vendor'?'No supplier identified. Check the issuer or letterhead.':'No unambiguous labeled value found.',evidence:[]};
 d.extraction={method:'layout-aware-v1',confidenceMeaning:'Heuristic support labels, not calibrated probabilities.',fields,ruledTable:inputRows.some(row=>row.gridCells)};
 d.arithmetic=arithmeticChecks(d);
 for(const c of d.arithmetic)if(fields[c.path]){fields[c.path].support='inconsistent';fields[c.path].reason=c.message;}
 return d;
}
