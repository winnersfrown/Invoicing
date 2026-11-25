import {readMoney, readSummary} from './invoice-money.js';

const headers = {
  sku: /^(?:sku|code|item (?:no\.?|code|number))$/i,
  description: /^(?:description|item|product|details|service)$/i,
  quantity: /^(?:qty\.?|quantity|units)$/i,
  unitPrice: /^(?:rate|price|unit (?:price|cost))$/i,
  amount: /^(?:line total|total|amount|extended price)$/i
};

function runs(start, end, qualifies) {
  const result = [];
  for (let position = start; position < end; position++) {
    if (!qualifies(position)) continue;
    if (result.at(-1)?.end === position) result.at(-1).end++;
    else result.push({start:position, end:position+1});
  }
  return result;
}

const midpoint = run => Math.floor((run.start + run.end - 1) / 2);

function cell(left, right, top, bottom) {
  const inset = 4;
  return {x:left+inset, y:top+inset, width:right-left-2*inset, height:bottom-top-2*inset};
}

// Wide bands identify possible dark headings. Below a heading, thin
// horizontal and vertical rules must agree on five shared columns.
export function findDarkTable({data, width, height}) {
  const dark = (x,y) => data[(y*width+x)*4] < 155;
  const count = (start,end,hit) => {
    let hits = 0;
    for (let i=start; i<end; i+=2) if (hit(i)) hits++;
    return hits;
  };
  const wide = runs(0,height,y=>count(0,width,x=>dark(x,y))>=width*.28);
  for (const band of wide) {
    const bandHeight = band.end - band.start;
    if (bandHeight<16 || bandHeight>height*.08) continue;
    const body = wide.filter(rule=>rule.start>band.end && rule.start-band.end<height*.45
      && rule.end-rule.start<=8).slice(0,11);
    if (body.length<2) continue;
    const top = band.end + 4;
    const bottom = midpoint(body[1])-4;
    if (bottom-top<24) continue;
    const vertical = runs(0,width,x=>count(top,bottom,y=>dark(x,y))>=(bottom-top)*.43)
      .filter(line=>line.end-line.start<=10);
    if (vertical.length!==6) continue;
    const edges = vertical.map(midpoint);
    const [left,,,,,right] = edges;
    if (right-left<width*.54 || edges.some((x,i)=>i && x-edges[i-1]<width*.04)) continue;

    const rowCells = [];
    let y = band.end;
    for (const rule of body) {
      const end = midpoint(rule);
      if (end-y<17 || end-y>height*.09 ||
          edges.some(x=>count(y+4,end-4,row=>[-1,0,1].some(dx=>x+dx>=0&&x+dx<width&&dark(x+dx,row)))<(end-y-8)*.36)) break;
      rowCells.push(edges.slice(1).map((x,i)=>cell(edges[i],x,y,end)));
      y=end;
    }
    if (rowCells.length<2) continue;

    // Summary cells can start partway across the item table or in a separate box.
    // The right border and one amount divider must be visible in each row.
    const summaryRules = runs(y,height,end=>end-y<height*.23 &&
      count(Math.floor(width*.48),right+1,x=>dark(x,end))>=width*.125);
    const summaries=[];
    let lastBounds;
    for (const [i,rule] of summaryRules.entries()) {
      const upper=summaryRules[i-1]?.end;
      const lower=rule.start;
      if (lower-upper>=16 && lower-upper<=height*.08) {
        const bounds = runs(Math.floor(width*.35),width,x=>
          count(upper+4,lower-4,row=>dark(x,row))>=(lower-upper-8)*.44);
        const [label, amount, edge] = bounds.filter(line=>line.end-line.start<=10).slice(-3).map(midpoint);
        if (edge>=right-width*.025 && edge<=right+width*.025 && amount-label>=width*.09 && edge-amount>=width*.06) {
          lastBounds=[label,amount,edge];
          summaries.push([cell(label,amount,upper,lower),cell(amount,edge,upper,lower)]);
        }
      }
      // A filled total band contains no dark vertical rules. Reuse the
      // measured edges from the adjoining summary row and read the whole band.
      if (lastBounds && rule.end-rule.start>=16 && rule.end-rule.start<=height*.08 && summaries.length<5) {
        const [label,amount,edge]=lastBounds;
        const mid=Math.floor((rule.start+rule.end)/2);
        if (dark(label+6,mid) && dark(edge-6,mid))
          summaries.push([cell(label,amount,rule.start,rule.end),cell(amount,edge,rule.start,rule.end)]);
      }
      if (summaries.length>=5) break;
    }
    return {top:band.start, bottom:y, heading:edges.slice(1).map((x,i)=>cell(edges[i],x,band.start,band.end)), rowCells, summaries};
  }
  return null;
}

function cellImage(canvas, bounds) {
  const crop=document.createElement('canvas');
  const scale=Math.max(1,Math.min(3,85/bounds.height));
  crop.width=Math.round(bounds.width*scale)+16;
  crop.height=Math.round(bounds.height*scale)+16;
  const context=crop.getContext('2d',{willReadFrequently:true});
  context.drawImage(canvas,bounds.x,bounds.y,bounds.width,bounds.height,8,8,crop.width-16,crop.height-16);
  const image=context.getImageData(0,0,crop.width,crop.height);
  let dark=0;
  const pixels=(crop.width-16)*(crop.height-16);
  for(let y=8;y<crop.height-8;y++)for(let x=8;x<crop.width-8;x++){
    const i=(y*crop.width+x)*4;
    if(image.data[i]<128 && image.data[i+3]!==0)dark++;
  }
  const reverse=dark>pixels*.55;
  for(let i=0;i<image.data.length;i+=4){
    const gray=(image.data[i]*77+image.data[i+1]*150+image.data[i+2]*29)>>8;
    const value=image.data[i+3]===0?255:reverse?255-gray:gray;
    image.data[i]=image.data[i+1]=image.data[i+2]=value;
    image.data[i+3]=255;
  }
  context.putImageData(image,0,0);
  return crop;
}

const bbox = c => ({x0:c.x,y0:c.y,x1:c.x+c.width,y1:c.y+c.height});

export async function readDarkTable(canvas,worker,page,onProgress) {
  const source=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
  const grid=findDarkTable(source);
  if(!grid)return null;
  onProgress('Reading dark table headings and ruled financial cells…');
  const read = async (bounds,mode) => {
    await worker.setParameters({tessedit_pageseg_mode:mode});
    const {data}=await worker.recognize(cellImage(canvas,bounds));
    return {text:data.text.trim().replace(/\s+/g,' '),ocrConfidence:data.confidence,bbox:bbox(bounds),method:'ocr',page};
  };
  const heading=[];
  for (const bounds of grid.heading) heading.push(await read(bounds,'7'));
  const order=heading.map(c=>Object.keys(headers).find(key=>headers[key].test(c.text)));
  if (order.includes(undefined)||new Set(order).size!==5) return null;

  const rows=[];
  for (const cells of grid.rowCells) {
    const evidence={};
    for (const [i,bounds] of cells.entries()) evidence[order[i]]=await read(bounds,order[i]==='description'?'6':'7');
    if (!evidence.description.text) return null;
    const gridCells=Object.fromEntries(Object.entries(evidence).map(([key,value])=>[key,value.text]));
    rows.push({text:Object.values(gridCells).join('  '),page,method:'ocr',gridCells,gridEvidence:evidence,gridHeading:heading,
      bbox:{x0:cells[0].x,y0:cells[0].y,x1:cells.at(-1).x+cells.at(-1).width,y1:cells[0].y+cells[0].height}});
  }

  const summaries=[];
  for (const [labelBounds,amountBounds] of grid.summaries) {
    const label=await read(labelBounds,'7');
    if (!/^(?:sub\s*total|(?:invoice |grand )?total|tax|vat|gst|balance|amount due)\b/i.test(label.text)) continue;
    const amount=await read(amountBounds,'7');
    const text=label.text+'  '+amount.text;
    if (!readMoney(amount.text) || !readSummary(text)) continue;
    summaries.push({...label,text,summaryCell:true,sourceRows:[label,amount],
      ocrConfidence:Math.min(label.ocrConfidence,amount.ocrConfidence),
      bbox:{...label.bbox,x1:amount.bbox.x1}});
  }
  return {...grid,rows,summaries};
}
