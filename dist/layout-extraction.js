import {readDocumentMetadata} from './document-metadata.js';
import {arithmeticChecks} from './arithmetic.js';
const amount=s=>{const value=String(s??'').trim().replace(/^\$\s*/,'').replace(/,/g,'');return /^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):null;};
const aliases={sku:/^(?:sku|item\s*(?:code|no\.?|number)|product\s*code)$/i,description:/^(?:description|details|product|item(?:\s*description)?)$/i,quantity:/^(?:qty\.?|quantity|units)$/i,unitPrice:/^(?:unit\s*(?:price|cost)|price|rate)$/i,amount:/^(?:amount|line\s*total|extended(?:\s*price)?|total)$/i};
export function groupPdfRows(items,page=1){
 const rows=[];
 for(const item of items.filter(i=>i.str?.trim()).sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4])){const y=item.transform[5];let row=rows.find(r=>Math.abs(r.y-y)<=3);if(!row){row={y,page,method:'pdf-text',tokens:[]};rows.push(row);}row.tokens.push({text:item.str,x:item.transform[4],width:item.width||0});}
 return rows.map(r=>{r.tokens.sort((a,b)=>a.x-b.x);return {...r,text:r.tokens.map(t=>t.text).join('  '),bbox:{x0:r.tokens[0].x,y0:r.y,x1:Math.max(...r.tokens.map(t=>t.x+t.width)),y1:r.y+12}};});
}
function columns(row){
 const cells=row.text.split(/\s*\|\s*|\t+| {2,}/).filter(Boolean);
 let headers=cells.map(c=>Object.keys(aliases).find(k=>aliases[k].test(c.trim())));
 
 const tokens=row.tokens||[];const mapped=[];
 for(let i=0;i<tokens.length;i++){let key;let count=1;for(const n of [3,2,1]){const label=tokens.slice(i,i+n).map(t=>t.text).join(' ');key=Object.keys(aliases).find(k=>aliases[k].test(label));if(key){count=n;break;}}if(key){mapped.push({key,x:tokens[i].x});i+=count-1;}}
 if(mapped.some(c=>c.key==='quantity')&&mapped.some(c=>c.key==='unitPrice'))return {positions:mapped};
 if(headers.includes('quantity')&&headers.includes('unitPrice'))return {headers};
 return null;
}
// Description/SKU text starts in its column and can run far from the heading.
function tableColumnDistance(token, column) {
 const textColumn = column.key === 'description' || column.key === 'sku';
 return Math.abs(token.x - column.x) * (textColumn && token.x >= column.x ? 0.5 : 1);
}
export function parseLayoutText(text,kind,layout=[]){
 const inputRows=layout.length?layout:text.split(/\r?\n/).map((text,i)=>({text,page:1,row:i+1,method:'text'}));
 // Label-only rows are common in PDFs with stacked metadata. Preserve both source passages.
 const standalone=/^(?:vendor|supplier|seller|from|invoice(?:\s*(?:number|no\.?|#))?|purchase\s*order(?:\s*(?:number|no\.?|reference))?|p\.?o\.?(?: reference)?|currency|invoice date|issue date|due date|subtotal|sub total|tax|vat|grand total|total|amount due|balance due)\s*[:#]?$/i;
 const rawRows=[];for(let i=0;i<inputRows.length;i++){const r=inputRows[i],next=inputRows[i+1];if(standalone.test(r.text.trim())&&next&&!(/^invoice$/i.test(r.text.trim())&&/\s/.test(next.text.trim()))&&r.page===next.page&&!standalone.test(next.text.trim())&&!/[:#]/.test(next.text)&&next.text.trim()){rawRows.push({...r,text:r.text.trim().replace(/[:#]$/,'')+': '+next.text.trim(),sourceRows:[r,next]});i++;}else rawRows.push(r);}
 const rows=rawRows.flatMap(row=>row.text.split(/ {2,}(?=(?:vendor|supplier|seller|from|invoice(?:\s+(?:no\.?|number|date))?|purchase order|po(?: reference)?|currency|due(?: date)?|subtotal|tax|total)\s*[:#])/i).map(text=>({...row,text})));
 const d={type:kind,vendor:'',customer:'',number:'',poNumber:'',currency:'',date:'',due:'',subtotal:null,tax:null,taxRate:null,total:null,lines:[],note:'Extracted values require source verification.'};
 const fields={};const set=(key,value,row,support='supported',reason='')=>{if(row.method==='ocr'&&(!Number.isFinite(row.ocrConfidence)||row.ocrConfidence<80))support='uncertain';const evidence={text:row.sourceRows?row.sourceRows.map(r=>r.text).join(' → '):row.text,page:row.page||1,row:row.sourceRows?.[0]?.row||row.row||Math.max(0,inputRows.indexOf(row.sourceRows?.[0]||row),rows.indexOf(row))+1,bbox:row.bbox||null,method:row.method||'text'};if(fields[key]&&JSON.stringify(fields[key].value)!==JSON.stringify(value)){fields[key].support='uncertain';fields[key].reason='Conflicting labeled values; verify the source.';fields[key].evidence.push(evidence);return;}if(fields[key]?.support==='uncertain'&&!reason){support='uncertain';reason=fields[key].reason;}fields[key]={value,support,reason:reason||(support==='supported'?'Explicit label or recognized table column.':row.method==='ocr'?'OCR or column interpretation needs verification against the source.':'Inferred from row pattern; verify against the source.'),evidence:[...(fields[key]?.evidence||[]),evidence]};if(!key.startsWith('lines.'))d[key]=value;};
 const labels=[['supplierId',/^(?:supplier\s*id|vendor\s*id|tax\s*id)\s*[:#]\s*(.+)$/i],['subtotal',/^(?:sub\s*total|net\s*amount)\s*:?\s*\$?\s*([\d,.]+)$/i],['tax',/^(?:tax|vat|sales\s*tax)(?:\s*\(?([\d.]+)%\)?)?\s*:?\s*\$?\s*([\d,.]+)$/i],['taxRate',/^(?:tax|vat)\s*rate\s*:?\s*([\d.]+)%$/i],['total',/^(?:grand\s*total|invoice\s*total|total(?:\s*due)?|amount\s*due|balance\s*due)(?:\s*\([A-Z]{3}\))?\s*:?\s*\$?\s*([\d,.]+)$/i]];
 readDocumentMetadata(inputRows,kind,fields,set);
 let table=null, page;
 for(const row of rows){if(row.page!==page){table=null;page=row.page;}const t=row.text.trim();if(!t)continue;
 let labeled=false;for(const [key,re] of labels){const m=t.match(re);if(!m)continue;labeled=true;let v=key==='tax'?amount(m[2]):['subtotal','taxRate','total'].includes(key)?amount(m[1]):m[1].trim();set(key,v,row);if(key==='tax'&&m[1])set('taxRate',amount(m[1]),row);break;}
 if(labeled){table=null;continue;}
 const head=columns(row);if(head){table=head;continue;}
 let l=null,support='supported';
 if(table){let values={};if(table.positions&&row.tokens?.length){for(const token of row.tokens){const col=table.positions.reduce((best,c)=>tableColumnDistance(token,c)<tableColumnDistance(token,best)?c:best);values[col.key]=(values[col.key]?values[col.key]+' ':'')+token.text;}}else{const cells=t.split(/\s*\|\s*|\t+| {2,}/).filter(Boolean);if(cells.length===table.headers?.length)table.headers.forEach((k,i)=>{if(k)values[k]=cells[i];});}if(values.quantity!=null&&values.unitPrice!=null)l={sku:values.sku||'',description:values.description||'',quantity:amount(values.quantity),unitPrice:amount(values.unitPrice),amount:amount(values.amount)};}
 if(!l){const m=t.match(/^([\w-]+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})(?:\s+\$?([\d,]+\.\d{2}))?$/);if(m){l={sku:m[1],description:m[2],quantity:Number(m[3]),unitPrice:amount(m[4]),amount:amount(m[5])};support='uncertain';}}
 if(l){const n=d.lines.length;d.lines.push(l);for(const key of Object.keys(l))set(`lines.${n}.${key}`,l[key],row,l[key]==null||l[key]===''?'uncertain':support);}
 else if(table&&d.lines.length&&!/\d/.test(t)){const l=d.lines.at(-1);l.description+=' '+t;set(`lines.${d.lines.length-1}.description`,l.description,row,'uncertain');}
 }
 if(kind==='purchase_order'){d.number=d.poNumber;fields.number=fields.poNumber;}
 for(const key of ['vendor','number','poNumber','currency','subtotal','tax','total'])if(!fields[key])fields[key]={value:d[key],support:'missing',reason:key==='poNumber'?'No PO reference found. Leave blank if the document does not list one.':key==='vendor'?'No supplier identified. Check the issuer or letterhead.':'No unambiguous labeled value found.',evidence:[]};
 d.extraction={method:'layout-aware-v1',confidenceMeaning:'Heuristic support labels, not calibrated probabilities.',fields};
 d.arithmetic=arithmeticChecks(d);
 for(const c of d.arithmetic)if(fields[c.path]){fields[c.path].support='inconsistent';fields[c.path].reason=c.message;}
 return d;
}
