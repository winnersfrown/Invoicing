const columns = [
  ['description', /\b(?:description|item|details|particulars)\b/i],
  ['quantity', /\b(?:qty|quantity|units)\b/i],
  ['unitPrice', /\b(?:unit\s*(?:price|cost)|price|rate)\b/i],
  ['amount', /\b(?:amount|total|extended)\b/i]
];

function distinctLines(lines) {
  const merged=[];
  for(const line of lines){
    if(merged.length&&line.position-merged.at(-1).position<=3)continue;
    merged.push(line);
  }
  return merged;
}

// Find runs of dark ruling in both directions. A narrow header band and
// shared vertical borders distinguish an item grid from underlined totals.
export function findItemGrid({data,width,height}) {
  const dark=(x,y)=>{
    const i=(y*width+x)*4;
    return Math.max(data[i],data[i+1],data[i+2])<170;
  };
  const horizontal=[];
  for(let y=0;y<height;y++){
    let start=0, lastDark=-9;
    for(let x=0;x<width;x+=2){
      if(!dark(x,y))continue;
      if(x-lastDark>6){
        if(lastDark-start>=width*.40)horizontal.push({position:y,start,end:lastDark});
        start=x;
      }
      lastDark=x;
    }
    if(lastDark-start>=width*.40)horizontal.push({position:y,start,end:lastDark});
  }
  const bands=[];
  for(const line of distinctLines(horizontal)){
    const band=bands.find(rows=>Math.abs(line.start-rows[0].start)<=8&&Math.abs(line.end-rows[0].end)<=8);
    if(band)band.push(line);
    else bands.push([line]);
  }
  for(const rows of bands.sort((a,b)=>b.length-a.length)){
    if(rows.length<3||rows.length>14)continue;
    const {start:left,end:right,position:top}=rows[0];
    const bottom=rows.at(-1).position;
    const headerHeight=rows[1].position-top;
    if(headerHeight<10||headerHeight>height*.075||bottom-top>height*.55)continue;

    const vertical=[];
    for(let x=Math.max(0,left-4);x<=Math.min(right+4,width-1);x++){
      let hits=0;
      for(let y=top;y<=bottom;y+=2)if(dark(x,y))hits++;
      if(hits>=Math.ceil((bottom-top)/2)*.84)vertical.push({position:x});
    }
    const edges=distinctLines(vertical).map(line=>line.position);
    if(edges.length!==5||Math.abs(edges[0]-left)>6||Math.abs(right-edges.at(-1))>6||
       edges.some((edge,index)=>index&&edge-edges[index-1]<(right-left)*.045))continue;

    const rowCells=rows.slice(1).map((line,index)=>edges.slice(1).map((edge,column)=>({
      x:edges[column]+3,y:rows[index].position+3,
      width:edge-edges[column]-6,height:line.position-rows[index].position-6
    })));
    if(rowCells.some(row=>row.some(cell=>cell.height<7||cell.width<7)))continue;
    return {top,bottom,left,right,rows:rowCells};
  }
  return null;
}

function inkBounds({data,width},cell) {
  let xMin=Infinity,yMin=Infinity,xMax=0,yMax=0,count=0;
  for(let y=cell.y;y<cell.y+cell.height;y++)for(let x=cell.x;x<cell.x+cell.width;x++){
    const i=(y*width+x)*4;
    const gray=(data[i]*77+data[i+1]*150+data[i+2]*29)>>8;
    if(gray>195)continue;
    count++;
    xMin=Math.min(xMin,x);xMax=Math.max(xMax,x);
    yMin=Math.min(yMin,y);yMax=Math.max(yMax,y);
  }
  if(count<16||xMax-xMin<3||yMax-yMin<4)return null;
  return {x:xMin,y:yMin,width:xMax-xMin+1,height:yMax-yMin+1};
}

function prepareCell(canvas,ink) {
  const cropped=document.createElement('canvas');
  const scale=Math.min(4,72/ink.height,1500/ink.width);
  cropped.width=Math.round(ink.width*scale)+24;
  cropped.height=Math.round(ink.height*scale)+24;
  const ctx=cropped.getContext('2d');
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,cropped.width,cropped.height);
  ctx.drawImage(canvas,ink.x,ink.y,ink.width,ink.height,12,12,cropped.width-24,cropped.height-24);
  const image=ctx.getImageData(0,0,cropped.width,cropped.height);
  for(let i=0;i<image.data.length;i+=4){
    const [r,g,b]=[image.data[i],image.data[i+1],image.data[i+2]];
    const gray=(r*77+g*150+b*29)>>8;
    const value=Math.max(0,gray-2*Math.max(0,b-Math.max(r,g)-7));
    image.data[i]=image.data[i+1]=image.data[i+2]=Math.min(255,Math.max(0,(value-40)*1.35));
  }
  ctx.putImageData(image,0,0);
  return cropped;
}

export async function readRuledItems(canvas,worker,page,onProgress) {
  const source=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
  const grid=findItemGrid(source);
  if(!grid)return null;

  async function readCell(ink){
    if(!ink)return '';
    const {data}=await worker.recognize(prepareCell(canvas,ink));
    return data.confidence>=35?data.text.replace(/\s+/g,' ').trim():'';
  }

  onProgress('Checking the ruled table cell by cell…');
  try {
    await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:''});
    const headings=[];
    for(const cell of grid.rows[0])headings.push(await readCell(inkBounds(source,cell)));
    if(!columns.every(([,pattern],index)=>pattern.test(headings[index])))return null;

    const rows=[];
    for(const row of grid.rows.slice(1)){
      const ink=row.map(cell=>inkBounds(source,cell));
      // Blank template rows and description-only continuations are excluded.
      if(!ink[0]||!ink.slice(1).some(Boolean))continue;
      if(rows.length>=10)return null;
      const cells={};
      await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:''});
      cells.description=await readCell(ink[0]);
      await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789., \'’'});
      for(let i=1;i<columns.length;i++){
        const value=await readCell(ink[i]);
        // For faint handwritten prices a lost decimal point can inflate the
        // value by orders of magnitude. Keep ambiguous long integers blank.
        cells[columns[i][0]]=i>1&&/^\d[\d ]{3,}$/.test(value)?'':value;
      }
      const bbox={x0:grid.left,y0:row[0].y,x1:grid.right,y1:row[0].y+row[0].height};
      rows.push({text:Object.values(cells).join('  ').trim(),gridCells:cells,bbox,page,method:'ocr'});
    }
    return rows.length?{...grid,rows}:null;
  }finally{
    await worker.setParameters({tessedit_pageseg_mode:'3',tessedit_char_whitelist:''});
  }
}

export function keepExistingItemReads(gridRows,document) {
  for(const [index,line] of document.lines.entries()){
    const evidence=document.extraction.fields[`lines.${index}.description`]?.evidence?.[0];
    if(!evidence?.bbox||evidence.coordinateSpace)continue;
    const middle=(evidence.bbox.y0+evidence.bbox.y1)/2;
    const row=gridRows.find(candidate=>candidate.page===evidence.page&&
      middle>=candidate.bbox.y0-3&&middle<=candidate.bbox.y1+3);
    if(!row||row.sourceRows||line.ratePercent!=null)continue;
    row.sourceRows=[{text:row.text},{text:evidence.text}];
    for(const key of ['description','quantity','unitPrice','amount']){
      if(line[key]!=null&&line[key]!=='')row.gridCells[key]=String(line[key]);
    }
    row.text=Object.values(row.gridCells).join('  ').trim();
  }
  return gridRows;
}
