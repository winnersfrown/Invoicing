// Optional browser evaluation. Supply CHROMIUM, TESSERACT_GZIP and playwright-core.
// PLAYWRIGHT_MODULE can point to a separately installed playwright-core ESM entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const keys=JSON.parse(await fs.readFile(path.join(here,'answers.json'),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM});
const context=await browser.newContext();
const origin='http://localhost:8080';
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 const headers={'access-control-allow-origin':'*'};
 if(url.origin===origin&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<input type="file">'});
 const lib=url.pathname.match(/^\/npm\/(pdfjs-dist|tesseract\.js(?:-core)?)@v?[\d.]+\/(.+)$/);
 let file;
 if(url.origin===origin)file=path.join(root,'dist',url.pathname);
 else if(lib)file=path.join(root,'node_modules',lib[1],lib[2]);
 else if(url.pathname.endsWith('/eng.traineddata.gz'))file=process.env.TESSERACT_GZIP;
 if(!file)return route.abort();
 return route.fulfill({path:file,headers,contentType:file.endsWith('.gz')||file.endsWith('.wasm')?'application/octet-stream':'text/javascript'});
});
const report=[];
try{
 const page=await context.newPage();
 await page.goto(origin);
 for(const key of keys){
  const started=performance.now();
  await page.locator('input').setInputFiles(path.join(here,'documents',key.file));
  const result=await page.evaluate(async kind=>{
   const {extractFile,parseExtractedText}=await import('/extraction.js');
   const {pendingConfirmations}=await import('/arithmetic.js');
   try{
    const {text,layout}=await extractFile(document.querySelector('input').files[0],()=>{},{kind,detailed:true});
    const d=parseExtractedText(text,kind,layout);
    return {kind:d.type,lines:d.lines,total:d.total,tax:d.tax,proposedTax:d.taxProposal?.cents??null,
     pending:pendingConfirmations(d).map(f=>f.path),flagged:!!d.arithmetic.length};
   }catch(e){return {error:String(e?.message||e)};}
  },key.kind==='purchase_order'?'purchase_order':'invoice');
  report.push({file:key.file,ms:Math.round(performance.now()-started),...result});
  console.log(key.file,result.error||result.lines.length);
 }
 await fs.writeFile(path.join(here,'browser-results.json'),JSON.stringify(report,null,2)+'\n');
}finally{await browser.close();}
