import {invoiceDateIssue} from './invoice-dates.js';
import {extractFile,parseExtractedText,parseBaselineText} from './extraction.js';
import {validateExtractionReview} from './extraction-validation.js';
import {arithmeticReview,arithmeticChecks,adjustmentsOf,taxesOf,pendingConfirmations,pathValue,correctField,ADJUSTMENT_KINDS,FEE_KINDS} from './arithmetic.js';

// Document text is untrusted: every value is set with textContent or as a DOM property, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}
const fmt = v => v == null ? '' : String(v);

/**
 * Generic confirmation rule: a field with needsConfirmation stays pending until the reviewer confirms it
 * (its path is in `confirmed`) or changes its value. Pure, so it is testable without a DOM.
 */
export function withReviewerConfirmations(d, original, confirmed) {
  const fields = structuredClone(d.extraction?.fields || {});
  for (const [path, f] of Object.entries(fields)) {
    if (!f.needsConfirmation) continue;
    const changed = JSON.stringify(pathValue(d, path) ?? null) !== JSON.stringify(pathValue(original, path) ?? null);
    if (confirmed.has(path) || changed) Object.assign(f, {confirmed: true, needsConfirmation: false, reviewedValue: pathValue(d, path)});
  }
  return {...d, extraction: {...d.extraction, fields}};
}

/** Apply reviewer choices {path: value} (a date candidate, a currency, a corrected OCR amount); every check reruns. Throws if a pending field is left open. */
export function applyConfirmations(d, choices) {
  const next = Object.entries(choices).reduce((doc, [path, value]) => correctField(doc, path, value), d);
  const open = pendingConfirmations(next);
  if (open.length) throw Error(`Confirm or correct ${open.map(p => p.label || p.path).join(', ')}: ${open[0].reason || 'it needs review'}`);
  return next;
}

/** Checks shown while reviewing: contradictions, uncertain results, conversions and unconfirmed fields. */
export function reviewStatus(d) {
  return {...arithmeticReview(d), contradictions: arithmeticChecks(d), pending: pendingConfirmations(d)};
}

export async function extractAndReview(file,kind,progress){const {text,layout}=await extractFile(file,progress,{detailed:true,kind}),data=parseExtractedText(text,kind,layout);data.baselineExtraction=parseBaselineText(text,kind);return reviewExisting(data,text,file);}

export function reviewExisting(data,text,file=null){
 if(data.additionalInvoices?.length){
  const ranges=[data.firstInvoicePages,...data.additionalInvoices].map(({firstPage,lastPage})=>firstPage===lastPage?String(firstPage):`${firstPage}–${lastPage}`).join(', ');
  throw Error(`This file contains multiple invoices. Split it by page range (${ranges}) and upload each invoice separately.`);
 }
 const kind=data.type;
 return new Promise(resolve=>{
  const fields=data.extraction?.fields||{};
  const url=file?URL.createObjectURL(file):null;
  const confirmed=new Set(), choices={};
  const dialog=el('dialog',{className:'ocr-dialog'});
  const sourceEvidence=el('div',{className:'source-evidence','aria-live':'polite',text:'Select “Show source evidence” to highlight the extracted source passage.'});
  const support=path=>{
   const f=fields[path];
   if(!f)return [];
   return [el('small',{className:`field-risk ${f.confirmed||f.support==='supported'?'supported':'uncertain'}`,dataset:{supportPath:path},text:f.confirmed?'Confirmed by reviewer':`${f.support} · ${f.reason}`}),
    f.evidence?.length?el('button',{type:'button',className:'text-button',dataset:{evidence:path},text:'Show source evidence'}):null];
  };
  const input=(name,label,value,number=false)=>el('label',{},label,
   el('input',{name,value:fmt(value),...(number?{type:'number',step:'any'}:{})}),support(name));

  const original=file?(/\.pdf$/i.test(file.name)?el('iframe',{title:'Original PDF',src:url}):el('img',{alt:'Uploaded document',src:url})):el('pre',{text});
  const left=el('section',{},el('h3',{text:'Original document'}),original,sourceEvidence,
   el('details',{},el('summary',{text:'Extracted text'}),el('pre',{text})),
   data.baselineExtraction?el('details',{},el('summary',{text:'Baseline parser comparison'}),el('p',{text:'Original regex parser using the same PDF.js / Tesseract text; no probability or accuracy claim.'}),el('pre',{text:JSON.stringify(data.baselineExtraction,null,2)})):null);

  const dual=Boolean(data.pricingCurrency&&data.pricingCurrency!==data.currency);
  const top=[['vendor','Vendor'],...(kind==='invoice'?[['customer','Customer (billed to)']]:[]),['supplierId','Supplier identifier (optional)'],['number','Document number'],['poNumber','PO reference'],
   ['currency',dual?'Payable currency':'Currency'],...(dual?[['pricingCurrency','Line-item (pricing) currency']]:[]),['date','Invoice date (YYYY-MM-DD)'],['due','Due date (YYYY-MM-DD)']];
  const amounts=[['subtotal',data.taxInclusive?'Net subtotal (before tax)':'Displayed subtotal'],...(dual?[['pricingTotal',`Invoice total (${data.pricingCurrency})`]]:[]),
   ['total',dual?`Amount payable (${data.currency||'payable currency'})`:'Displayed invoice total'],['amountDue','Balance due (after payments or credits, if printed)'],...(data.exchangeRate?[['exchangeRate','Exchange rate']]:[])];
  const fieldsHost=el('div',{className:'ocr-fields'},top.map(([k,l])=>input(k,l,data[k])),amounts.map(([k,l])=>input(k,l,pathValue(data,k),true)));

  // Taxes and adjustments are lists: several taxes and several charges or reductions per invoice.
  const taxHost=el('div',{className:'ocr-lines'}), adjustmentHost=el('div',{className:'ocr-lines'});
  let taxIndex=0, adjustmentIndex=0;
  const removable=row=>el('button',{type:'button',className:'text-button danger',text:'Remove',onclick:()=>{row.remove();renderChecks();}});
  function addTax(t={}){
   const i=taxIndex++;
   const row=el('div',{className:'ocr-line'},
    el('label',{},'Tax label',el('input',{dataset:{key:'label'},value:fmt(t.label||'Tax')})),
    el('label',{},'Rate (%)',el('input',{dataset:{key:'ratePercent'},type:'number',step:'any',min:0,value:fmt(t.ratePercent)})),
    el('label',{},'Printed tax amount (blank = unknown)',el('input',{name:`taxes.${i}`,dataset:{key:'cents'},type:'number',step:'any',value:t.cents==null?'':String(t.cents/100)}),support(t.path||`taxes.${i}`)));
   row.append(removable(row));row._tax=t;taxHost.append(row);
  }
  function addAdjustment(a={kind:'other_fee',taxable:'unknown',appliesTo:'total'}){
   const i=adjustmentIndex++;
   const select=(key,options,value)=>el('select',{dataset:{key}},options.map(([v,l])=>el('option',{value:v,text:l,selected:String(value)===v})));
   const row=el('div',{className:'ocr-line'},
    el('label',{},'Kind',select('kind',ADJUSTMENT_KINDS.map(k=>[k,k.replace('_',' ')]),a.kind)),
    el('label',{},'Description',el('input',{dataset:{key:'description'},value:fmt(a.description)})),
    el('label',{},'Amount (negative for reductions)',el('input',{name:`adjustments.${i}`,dataset:{key:'cents'},type:'number',step:'any',value:a.cents==null?'':String(a.cents/100)}),support(a.path||`adjustments.${i}`)),
    el('label',{},'Taxable',select('taxable',[['unknown','Unknown'],['true','Yes'],['false','No']],a.taxable)),
    el('label',{},'Applies to',select('appliesTo',[['total','Invoice total'],['balance','Balance due (after total)']],a.appliesTo||'total')));
   row.append(removable(row));row._adjustment=a;adjustmentHost.append(row);
  }
  taxesOf(data).forEach(addTax);
  adjustmentsOf(data).forEach(addAdjustment);

  const lineHost=el('div',{className:'ocr-lines'});let rowIndex=0;
  function addLine(l={}){
   const index=rowIndex++;
   const cols=[['sku','SKU','text'],['description','Description','text'],['quantity',l.ratePercent!=null?'Percentage basis':'Quantity','number'],...(l.ratePercent!=null?[['ratePercent','Rate (%)','number']]:[['unitPrice','Unit price','number']]),['amount','Printed amount','number']];
   const row=el('div',{className:'ocr-line'},cols.map(([k,label,type])=>el('label',{},label,
     el('input',{name:`lines.${index}.${k}`,dataset:{key:k},type,value:fmt(l[k]),...(type==='number'?{min:k==='quantity'?0.001:0,step:k==='quantity'?'.001':'any'}:{})}),support(`lines.${index}.${k}`))));
   row.append(el('button',{type:'button',className:'text-button danger','aria-label':'Remove line',text:'Remove',onclick:()=>{row.remove();renderChecks();}}));
   lineHost.append(row);
  }
  data.lines.forEach(addLine);

  const confirmHost=el('div',{className:'confirmations','aria-live':'polite'});
  const dateReview=el('div',{className:'date-review','aria-live':'polite'});
  const arithmeticHost=el('div',{className:'arithmetic-review','aria-live':'polite'});
  const reviewed=el('input',{type:'checkbox',required:true});
  const error=el('p',{className:'ocr-error',role:'alert'});
  const form=el('form',{},confirmHost,fieldsHost,dateReview,
   el('h3',{text:'Taxes'}),el('p',{text:'List each printed tax separately (for example GST and PST, or VAT at two rates). Zero-rated and exempt taxes are 0. Leave an amount blank when it is not printed: unknown is not zero.'}),
   taxHost,el('button',{type:'button',className:'text-button',text:'+ Add tax',onclick:()=>{addTax();renderChecks();}}),
   el('h3',{text:'Charges, discounts, credits and payments'}),adjustmentHost,el('button',{type:'button',className:'text-button',text:'+ Add adjustment',onclick:()=>{addAdjustment();renderChecks();}}),
   el('h3',{text:'Line items'}),data.extraction?.ruledTable?el('p',{className:'check',text:'Sorikano found the table rows. Compare each cell with the original and fill in any required quantities that OCR missed.'}):null,
   el('p',{text:'Keep printed amounts separate from quantity × price. Blank optional amounts remain unknown. Match verified SKUs on both documents.'}),
   lineHost,el('button',{type:'button',className:'text-button',text:'+ Add line item',onclick:()=>{addLine();renderChecks();}}),
   arithmeticHost,el('label',{className:'review-confirm'},reviewed,' I checked these fields and line items against the original document. Any remaining contradictions must stay on hold.'),
   error,el('button',{className:'button primary',type:'submit',text:'Save extraction & continue'}));
  dialog.append(el('div',{className:'dialog-top'},
    el('div',{},el('span',{className:'eyebrow',text:'VERIFY EXTRACTED DETAILS'}),el('h2',{text:`Review ${kind==='invoice'?'invoice':'purchase order'}`}),
     el('p',{text:'Support labels are heuristic signals, not calibrated probabilities. Start with the values that need confirmation and the highlighted fields. Leave unreadable values blank; you can finish them in the inbox. Confirmation never authorizes payment.'})),
    el('button',{type:'button',className:'icon-button','aria-label':'Cancel extraction',text:'×',onclick:()=>close(null)})),
   el('div',{className:'ocr-grid'},left,form));
  document.body.append(dialog);

  const number=v=>v===''||v==null?null:Number(v);
  const cents=v=>v===''||v==null?null:Math.round(Number(v)*100);
  const formInput=path=>form.querySelector(`[name="${CSS.escape(path)}"]`);
  function read(){
   const values_=new FormData(form);let d={...data};
   for(const [k] of top)d[k]=String(values_.get(k)||'').trim();
   for(const [k] of amounts)if(k!=='exchangeRate')d[k]=number(values_.get(k));
   if(data.exchangeRate){const v=String(values_.get('exchangeRate')||'');d.exchangeRate={...data.exchangeRate,rate:number(v),decimals:v.split('.')[1]?.length??0};}
   const values=row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(i=>[i.dataset.key,i.value]));
   d.taxes=[...taxHost.children].map((row,i)=>{const v=values(row);return {...row._tax,label:v.label.trim()||'Tax',ratePercent:number(v.ratePercent),cents:cents(v.cents),path:`taxes.${i}`};});
   d.adjustments=[...adjustmentHost.children].map((row,i)=>{const v=values(row);return {...row._adjustment,kind:v.kind,description:v.description.trim(),cents:cents(v.cents),
    taxable:v.taxable==='unknown'?'unknown':v.taxable==='true',appliesTo:v.appliesTo,path:`adjustments.${i}`};});
   const known=d.taxes.length&&d.taxes.every(t=>Number.isSafeInteger(t.cents));
   d.tax=known?d.taxes.reduce((s,t)=>s+t.cents,0)/100:null;
   d.taxRate=d.taxes.length===1?d.taxes[0].ratePercent:null;
   const sum=list=>{const ok=list.filter(a=>Number.isSafeInteger(a.cents));return ok.length?ok.reduce((s,a)=>s+a.cents,0)/100:null;};
   d.shipping=sum(d.adjustments.filter(a=>FEE_KINDS.includes(a.kind)));
   const off=sum(d.adjustments.filter(a=>['discount','credit_applied'].includes(a.kind)&&a.appliesTo!=='balance'));d.discount=off==null?null:-off;
   d.lines=[...lineHost.children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.key,['quantity','unitPrice','ratePercent','amount'].includes(i.dataset.key)?number(i.value):i.value.trim()])));
   d=withReviewerConfirmations(d,data,confirmed);
   // Values entered in a confirmation box for a field that has no form input (for example a printed tax total).
   for(const [path,value] of Object.entries(choices))if(!formInput(path))d=correctField(d,path,value);
   return d;
  }
  function renderConfirmations(pending){
   confirmHost.replaceChildren();
   if(!pending.length)return;
   confirmHost.append(el('h3',{text:'Confirm before saving'}));
   for(const p of pending){
    const choose=value=>{const target=formInput(p.path);if(target&&value!=null)target.value=String(value);else if(value!=null)choices[p.path]=value;confirmed.add(p.path);reviewed.checked=false;renderChecks();};
    const f=fields[p.path]||{};
    const numeric=!['date','due','currency','pricingCurrency'].includes(p.path);
    const other=el('input',{type:numeric?'number':'text',step:numeric?'any':null,'aria-label':'Correct value'});
    confirmHost.append(el('fieldset',{className:'check'},
     el('legend',{text:f.label||p.path}),el('p',{text:p.reason}),
     f.sourceText?el('p',{},el('small',{text:'Source: '}),el('mark',{text:f.sourceText})):null,
     p.evidence.map(v=>el('p',{},el('small',{text:`Page ${v.page}, text row ${v.row} (${v.method}): `}),el('mark',{text:v.text}))),
     p.candidates.map(c=>el('button',{type:'button',className:'text-button',text:`${p.path==='currency'?'Confirm':'Use'} ${c.label??c.value}`,onclick:()=>choose(c.value)})),
     el('label',{},'Or enter the correct value: ',other,el('button',{type:'button',className:'text-button',text:'Use this value',onclick:()=>{if(other.value!=='')choose(numeric?Number(other.value):other.value.trim());}})),
     p.value!=null&&p.value!==''?el('button',{type:'button',className:'text-button',text:`Confirm the value as read (${p.value})`,onclick:()=>choose(null)})
      :el('button',{type:'button',className:'text-button',text:'Confirm it is unreadable (stays unknown, not zero)',onclick:()=>choose(null)})));
   }
  }
  function renderChecks(){
   const current=read();
   for (const badge of form.querySelectorAll('[data-support-path]')) {
    const field = current.extraction?.fields?.[badge.dataset.supportPath];
    if (!field) continue;
    const accepted = field.confirmed && field.reviewedValue != null && field.reviewedValue !== '';
    badge.className = `field-risk ${accepted || field.support === 'supported' ? 'supported' : 'uncertain'}`;
    badge.textContent = accepted ? 'Confirmed by reviewer' : `${field.support} · ${field.reason}`;
   }
   const dateIssue=kind==='invoice'?invoiceDateIssue(current.date,current.due):'';
   dateReview.classList.toggle('check',Boolean(dateIssue));dateReview.textContent=dateIssue;dateReview.hidden=!dateIssue;
   const status=reviewStatus(current);
   renderConfirmations(status.pending);
   const item=(c,cls)=>el('p',{className:cls},c.message||`${c.label}: agrees.`,
    c.evidence?.length?el('small',{text:' Source: '+c.evidence.map(e=>`page ${e.page}, row ${e.row}: “${e.text}”`).join('; ')}):null);
   const section=(title,list,cls)=>list.length?[el('h3',{text:title}),list.map(c=>item(c,cls))]:[];
   arithmeticHost.replaceChildren(
    ...section('Arithmetic contradictions — hold for resolution',status.contradictions,'check'),
    ...section('Uncertain — confirm these inputs before any error is raised',status.uncertain,'check'),
    ...section('Currency conversion (reported separately)',status.conversions,status.conversions.some(c=>c.status!=='pass')?'check':''),
    ...(status.contradictions.length||status.uncertain.length?[]:[el('p',{text:'Available arithmetic checks agree. Missing displayed values still need source review.'})]));
  }
  dialog.addEventListener('input',e=>{if(e.target===reviewed||e.target.closest('.confirmations'))return;reviewed.checked=false;renderChecks();});
  dialog.addEventListener('change',e=>{if(e.target.tagName==='SELECT')renderChecks();});
  dialog.addEventListener('click',e=>{
   const button=e.target.closest('[data-evidence]');if(!button)return;
   const f=fields[button.dataset.evidence];
   sourceEvidence.replaceChildren(el('h3',{text:`${button.dataset.evidence} · source evidence`}),...f.evidence.flatMap(v=>[el('p',{text:`Page ${v.page}, text row ${v.row} (${v.method})`}),el('mark',{text:v.text})]));
  });
  function close(value){dialog.close();dialog.remove();if(url)URL.revokeObjectURL(url);resolve(value);}
  dialog.oncancel=e=>{e.preventDefault();close(null);};
  form.onsubmit=e=>{
   e.preventDefault();
   try{
    const d=read();
    const pending=pendingConfirmations(d);
    if(pending.length)throw Error(`Confirm or correct before saving: ${pending.map(p=>fields[p.path]?.label||p.path).join(', ')}.`);
    validateExtractionReview(d);
    d.sourceText=text;d.sourceFilename=file?.name||'inbox-source.txt';d.extractionReviewed=true;
    d.arithmeticReview=arithmeticReview(d);d.arithmetic=arithmeticChecks(d);
    d.extractionReview={confirmedAt:new Date().toISOString(),originalValues:fields,confirmedFields:[...confirmed],reviewedValues:{vendor:d.vendor,customer:d.customer,number:d.number,poNumber:d.poNumber,currency:d.currency,
     pricingCurrency:d.pricingCurrency,date:d.date,due:d.due,subtotal:d.subtotal,shipping:d.shipping,discount:d.discount,adjustments:d.adjustments,taxRate:d.taxRate,tax:d.tax,taxes:d.taxes,
     total:d.total,pricingTotal:d.pricingTotal,amountDue:d.amountDue,exchangeRate:d.exchangeRate,lines:d.lines},remainingContradictions:d.arithmetic};
    close(d);
   }catch(err){error.textContent=err.message;}
  };
  renderChecks();dialog.showModal();
 });
}
