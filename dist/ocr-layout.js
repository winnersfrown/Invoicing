function bounds(words) {
  return {
    x0:Math.min(...words.map(w=>w.x0)),y0:Math.min(...words.map(w=>w.y0)),
    x1:Math.max(...words.map(w=>w.x1)),y1:Math.max(...words.map(w=>w.y1))
  };
}

export function ocrRows(data,page,map = box=>box,retry=false) {
  return (data.lines||[]).filter(line=>line.text.trim()).map(line=>({
    text:line.text.trim(),page,bbox:map(line.bbox),method:'ocr',ocrConfidence:retry?undefined:line.confidence,
    tokens:(line.words||[]).filter(word=>word.text.trim()).map(word=>{
      const box=map(word.bbox);
      return {text:word.text,x:box.x0,width:box.x1-box.x0,box,confidence:word.confidence};
    })
  }));
}

// Sparse OCR may return one line for each cell. Reassemble rows by baseline.
export function alignOcrRows(rows) {
  const tokens=rows.flatMap(r=>r.tokens).sort((a,b)=>a.box.y1-b.box.y1);
  const groups=[];
  for(const token of tokens){
    const {y0,y1}=token.box;
    const height=y1-y0;
    const last=groups.at(-1);
    if(last && Math.abs(y1-last.baseline)<=Math.max(4,Math.min(height,last.height)*.54)){
      last.tokens.push(token);
    }else groups.push({baseline:y1,height,tokens:[token]});
  }
  return groups.map(group=>{
    const words=group.tokens.sort((a,b)=>a.x-b.x);
    let text='';
    let right=null;
    for(const word of words){
      text+=(right!==null&&word.x-right>18?'  ':right===null?'':' ')+word.text;
      right=word.x+word.width;
    }
    // Geometry changes the grouping, not Tesseract's observations. Use the
    // weakest word; a missing measurement keeps the entire row uncertain.
    const ocrConfidence=words.every(w=>Number.isFinite(w.confidence))
      ? Math.min(...words.map(w=>w.confidence)) : undefined;
    return {text,ocrConfidence,page:rows[0].page,bbox:bounds(words.map(w=>w.box)),method:'ocr',tokens:words};
  });
}
