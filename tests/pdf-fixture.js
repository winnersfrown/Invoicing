// Tiny deterministic PDF fixture for parser regressions; no document-generation dependency.
export function invoicePdf(lines){
 const stream='BT /F1 12 Tf '+lines.map((s,i)=>`1 0 0 1 50 ${760-i*24} Tm (${s.replace(/[\\()]/g,'\\$&')}) Tj`).join(' ')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n',offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const start=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return new TextEncoder().encode(pdf);
}
