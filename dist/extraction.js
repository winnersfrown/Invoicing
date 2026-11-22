import {parseLayoutText,groupPdfRows} from './layout-extraction.js';
import {enhanceScan,straightenPhoto} from './ocr-image.js';
import {alignOcrRows,ocrRows} from './ocr-layout.js';
import {toCents,adjustmentCents} from './arithmetic.js';

export function parseExtractedText(text,kind,layout=[]) {
 const pages = new Map();
 for(const row of layout){
  if(!pages.has(row.page))pages.set(row.page,[]);
  pages.get(row.page).push(row);
 }
 if (kind!=='invoice'||pages.size<2) return parseLayoutText(text,kind,layout);
 // A new numbered page with its own invoice title starts another invoice.
 // Keep original page numbers and evidence in each segment.
 const sections=[];
 let current=[];
 let previousNumber='';
 for (const rows of pages.values()) {
  const header=rows.slice(0,12);
  const titled=header.some(row=>/\b(?:tax |cash )?invoice\b/i.test(row.text));
  const number=titled?parseLayoutText('',kind,header).number:'';
  if (number&&previousNumber&&number!==previousNumber) {
   sections.push(current);current=[];
  }
  current.push(...rows);
  if(number)previousNumber=number;
 }
 if(!sections.length)return parseLayoutText(text,kind,layout);
 sections.push(current);
 const documents=sections.map(rows=>({
  firstPage:rows[0].page,lastPage:rows.at(-1).page,
  document:parseLayoutText('',kind,rows)
 }));
 return {...documents[0].document,additionalInvoices:documents.slice(1),firstInvoicePages:{firstPage:documents[0].firstPage,lastPage:documents[0].lastPage}};
}
// Pinned browser dependencies; documents are processed locally, never sent to these CDNs.
const CDN='https://cdn.jsdelivr.net/npm/';
export function parseBaselineText(text,kind){
 const get=pattern=>text.match(pattern)?.[1]?.trim()||'';
 const amount=label=>{const s=get(new RegExp('^'+label+'[ \\t]*[:$]?[ \\t]*\\$?([\\d,]+\\.\\d{2})[ \\t]*$','mi'));return s?Number(s.replaceAll(',','')):null;};
 const po=get(/(?:PO(?: number| reference)?|Purchase order(?: number)?)[ \t]*[:#][ \t]*([^\n]+)/i);
 const lines=[];for(const row of text.split('\n')){const m=row.trim().match(/^([\w-]+)\s+(.+?)\s+(\d+)\s+\$?([\d,]+\.\d{2})(?:\s+\$?[\d,]+\.\d{2})?$/);if(m&&!/subtotal|total|tax/i.test(m[1]))lines.push({sku:m[1],description:m[2].trim(),quantity:Number(m[3]),unitPrice:Number(m[4].replaceAll(',',''))});}
 return {type:kind,vendor:get(/^Vendor[ \t]*:[ \t]*(.+)$/mi),number:kind==='invoice'?get(/^Invoice(?: number)?[ \t]*[:#][ \t]*(.+)$/mi):po,poNumber:po,currency:get(/^Currency[ \t]*:[ \t]*(\w+)/mi)||'USD',lines,tax:amount('Tax'),total:amount('Total'),note:'Extracted document. Fields require human verification.'};
}
let pdfPromise,ocrPromise;
async function pdfLib(){if(!pdfPromise)pdfPromise=import(CDN+'pdfjs-dist@4.10.38/build/pdf.min.mjs').then(m=>{m.GlobalWorkerOptions.workerSrc=CDN+'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return m;});return pdfPromise;}
async function ocrLib(){if(!ocrPromise)ocrPromise=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=CDN+'tesseract.js@5.1.1/dist/tesseract.min.js';s.onload=()=>resolve(window.Tesseract);s.onerror=()=>{ocrPromise=null;reject(Error('OCR library could not load. Check your internet connection and retry.'));};document.head.append(s);});return ocrPromise;}
function invoiceQuality(doc) {
 const lines=doc.lines.filter(line=>line.description&&line.amount!=null);
 const completeSummary=[doc.subtotal,doc.tax,doc.total].every(Number.isFinite);
 const reconciled=completeSummary && Math.abs(toCents(doc.subtotal)+toCents(doc.tax)+adjustmentCents(doc.shipping,doc.discount)-toCents(doc.total))<=1;
 const totalIssue=doc.arithmetic.some(issue=>issue.path==='total');
 const itemsAgree=lines.length && doc.subtotal!=null && !doc.arithmetic.some(issue=>issue.path==='subtotal');
 return {
  weak:!doc.vendor||doc.total==null||totalIssue||!itemsAgree,
  score: 2*Boolean(doc.vendor)+2*Boolean(doc.number)+Boolean(doc.currency)+2*(doc.total!=null)+4*reconciled+3*Boolean(itemsAgree)+2*lines.length
    - Math.min(12,2*doc.arithmetic.length)
 };
}

export async function extractFile(file,onProgress=()=>{},options={}) {
 if(file.size>15*1024*1024)throw Error('Choose a document under 15 MB.');
 const isPdf=/\.pdf$/i.test(file.name);
 if(!isPdf&&!/\.(png|jpe?g|webp)$/i.test(file.name))throw Error('Upload PDF, PNG, JPG or WebP.');
 const kind=options.kind||'invoice';
 let worker,pdf;
 const pages=[],layout=[];
 async function recognize(canvas,page) {
  if(!worker){
   onProgress('Loading English OCR…');
   const T=await ocrLib();
   worker=await T.createWorker('eng',1,{logger:m=>{
    if(m.status==='recognizing text')onProgress('Reading image text… '+Math.round(m.progress*100)+'%');
   }});
  }
  await worker.setParameters({tessedit_pageseg_mode:'3'});
  const initial=(await worker.recognize(canvas)).data;
  let best=ocrRows(initial,page);
  let bestDocument=parseLayoutText(initial.text,kind,best);
  let quality=invoiceQuality(bestDocument);
  function consider(rows){
   const document=parseLayoutText('',kind,rows);
   const next=invoiceQuality(document);
   if(next.score<=quality.score)return;
   const sameInvoice=!bestDocument.number||!document.number||bestDocument.number===document.number;
   if(!sameInvoice && bestDocument.extraction.fields.number?.support==='supported')return;
   best=rows;bestDocument=document;quality=next;
  }
  if(quality.weak)try{
   onProgress('Retrying difficult text and table rows…');
   // Keep the legacy segmentation as a candidate for stamps and table rules.
   await worker.setParameters({tessedit_pageseg_mode:'6'});
   consider(ocrRows((await worker.recognize(canvas)).data,page));
   const corrected=straightenPhoto(canvas);
   const retry=enhanceScan(corrected||canvas);
   const coordinateSource=corrected||canvas;
   const map=box=>({
    x0:box.x0*coordinateSource.width/retry.width,x1:box.x1*coordinateSource.width/retry.width,
    y0:box.y0*coordinateSource.height/retry.height,y1:box.y1*coordinateSource.height/retry.height
   });
   await worker.setParameters({tessedit_pageseg_mode:'11'});
   const sparse=ocrRows((await worker.recognize(retry)).data,page,map,true);
   consider(alignOcrRows(best));
   const sourceSpace = rows=>corrected?rows.map(row=>({...row,coordinateSpace:'straightened-page'})):rows;
   consider(sourceSpace(alignOcrRows(sparse)));
   if(corrected || !bestDocument.lines.length || bestDocument.total==null){
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    const block=ocrRows((await worker.recognize(retry)).data,page,map,true);
    consider(sourceSpace(alignOcrRows(block)));
   }

   // Re-read the populated part of a weak scan at higher resolution. Candidates
   // stay independent when their coordinates come from a straightened image.
   if(quality.weak&&!corrected&&best.length){
    const bottom=Math.max(...best.filter(r=>!/^page \d+/i.test(r.text)).map(r=>r.bbox.y1),canvas.height*.50);
    const crop={x:0,y:0,width:canvas.width,height:Math.min(canvas.height,Math.ceil(bottom+canvas.height*.04))};
    async function retryCrop(bounds,mode) {
     const focus=enhanceScan(canvas,bounds);
     await worker.setParameters({tessedit_pageseg_mode:mode});
     return alignOcrRows(ocrRows((await worker.recognize(focus)).data,page,box=>({
      x0:bounds.x+box.x0*bounds.width/focus.width,x1:bounds.x+box.x1*bounds.width/focus.width,
      y0:bounds.y+box.y0*bounds.height/focus.height,y1:bounds.y+box.y1*bounds.height/focus.height
     }),true));
    }
    if(crop.height<canvas.height*.90)consider(await retryCrop(crop,'6'));
    const summaryRow=best.findLast(row=>/^\s*(?:total|amount due|balance due)\b/i.test(row.text));
    if((bestDocument.total==null||bestDocument.arithmetic.some(check=>check.path==='total')) && summaryRow){
     const y=Math.max(0,Math.floor(summaryRow.bbox.y0-canvas.height*.065));
     const end=Math.min(canvas.height,Math.ceil(summaryRow.bbox.y1+canvas.height*.026));
     const retryRows=await retryCrop({x:0,y,width:canvas.width,height:end-y},'6');
     const better=parseLayoutText('',kind,retryRows);
     if(better.total!=null&&better.extraction.fields.total?.support==='uncertain'){
      const keep=row=>row.bbox.y0<y||row.bbox.y0>=end||!/^\s*(?:sub\s*total|total|vat|tax|amount due|balance due)\b/i.test(row.text);
      consider([...best.filter(keep),...retryRows.filter(r=>/^\s*(?:sub\s*total|total|vat|tax|amount due|balance due)\b/i.test(r.text))].sort((a,b)=>a.bbox.y0-b.bbox.y0));
     }
    }
    if(!bestDocument.vendor){
     const height=Math.round(canvas.height*.19);
     const header=await retryCrop({x:0,y:0,width:canvas.width,height},'11');
     const combined=[...header,...best.filter(row=>row.bbox.y0>=height)];
     consider(combined);
    }
   }
  }catch{
   // A failed optional OCR retry must not discard the usable first pass.
   onProgress('Continuing with the available OCR text…');
  }
  layout.push(...best);
  return best.length?best.map(row=>row.text).join('\n'):initial.text;
 }
 try {
  if (isPdf) {
   onProgress('Opening PDF…');
   const lib=await pdfLib();
   pdf=await lib.getDocument({data:await file.arrayBuffer(),isEvalSupported:false}).promise;
   if(pdf.numPages>5)throw Error('This demo accepts PDFs up to 5 pages.');
   for(let n=1;n<=pdf.numPages;n++){
    onProgress(`Reading PDF page ${n} of ${pdf.numPages}…`);
    const page=await pdf.getPage(n);
    const rows=groupPdfRows((await page.getTextContent()).items,n);
    let text=rows.map(r=>r.text).join('\n');
    if(text.trim().length<40){
     const viewport=page.getViewport({scale:Math.min(2,2000/Math.max(page.view[2],page.view[3]))});
     const canvas=document.createElement('canvas');
     canvas.width=viewport.width;canvas.height=viewport.height;
     await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
     text=await recognize(canvas,n);
    }else layout.push(...rows);
    pages.push(text);
   }
  } else {
   const bitmap=await createImageBitmap(file);
   try{
    if(bitmap.width*bitmap.height>30000000)throw Error('Image is too large. Use an image below 30 megapixels.');
    const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=bitmap.width*scale;canvas.height=bitmap.height*scale;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    pages.push(await recognize(canvas,1));
   }finally{bitmap.close();}
  }
  const text=pages.join('\n\n');
  if(!text.trim())throw Error('No readable text found. Try a clearer scan.');
  return options.detailed?{text,layout}:text;
 }finally{if(worker)await worker.terminate();if(pdf)await pdf.destroy();}
}
