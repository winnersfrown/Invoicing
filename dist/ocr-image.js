// Recover a bright sheet on a darker background. Sample insets prevent text,
// shadows, and a clipped corner from defining the capture bounds.
function paperCorners(canvas) {
  const {width,height} = canvas;
  const {data} = canvas.getContext('2d').getImageData(0,0,width,height);
  const bright = (x,y) => {
    const i = (y*width+x)*4;
    return Math.min(data[i],data[i+1],data[i+2]) >= 185;
  };
  const fit = samples => {
    const mean = samples.reduce(([x,y],[a,b])=>[x+a/samples.length,y+b/samples.length],[0,0]);
    let covariance=0, variance=0;
    for (const [x,y] of samples) {
      covariance+=(x-mean[0])*(y-mean[1]);
      variance+=(x-mean[0])**2;
    }
    const slope=covariance/variance;
    return {slope,offset:mean[1]-slope*mean[0]};
  };
  function scan(length, depth, isBright) {
    const near=[],far=[];
    for(let i=2;i<=18;i++){
      const position=Math.round(i*length/20);
      let first=null,last=null;
      for(let d=0;d<depth-4;d+=3){
        if(!isBright(position,d)||!isBright(position,d+3))continue;
        first??=d;
        last=d+3;
      }
      if(first==null||last-first<depth*.57)continue;
      near.push([position,first]);far.push([position,last]);
    }
    if (near.length<12) return null;
    return [fit(near),fit(far)];
  }
  const horizontal=scan(width,height,bright);
  const vertical=scan(height,width,(y,x)=>bright(x,y));
  if(!horizontal||!vertical)return null;
  const [top,bottom]=horizontal,[left,right]=vertical;
  function intersect(h,v) {
    const y=(h.offset+h.slope*v.offset)/(1-h.slope*v.slope);
    return [v.offset+v.slope*y,y];
  }
  const corners=[intersect(top,left),intersect(top,right),intersect(bottom,right),intersect(bottom,left)];
  if(corners.some(([x,y])=>x<0||x>=width||y<0||y>=height))return null;
  const hasBorder=corners.every(([x,y])=>x>width*.014&&x<width*.986&&y>height*.014&&y<height*.986);
  const skew=Math.max(...[top,bottom,left,right].map(edge=>Math.abs(edge.slope)));
  return hasBorder&&skew>.025&&skew<.35 ? {corners,data} : null;
}

export function straightenPhoto(canvas) {
  const paper=paperCorners(canvas);
  if(!paper)return null;
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=paper.corners;
  const width=Math.round(Math.max(Math.hypot(x1-x0,y1-y0),Math.hypot(x2-x3,y2-y3)));
  const height=Math.round(Math.max(Math.hypot(x3-x0,y3-y0),Math.hypot(x2-x1,y2-y1)));
  if(width<1||height<1||width*height>8_000_000)return null;
  const result=document.createElement('canvas');
  result.width=width;result.height=height;
  const context=result.getContext('2d');
  const pixels=context.createImageData(width,height);
  // Project the rectangular output back onto the four corners of the photo.
  const dx1=x1-x2, dx2=x3-x2, sx=x0-x1+x2-x3;
  const dy1=y1-y2, dy2=y3-y2, sy=y0-y1+y2-y3;
  const determinant=dx1*dy2-dx2*dy1;
  if(Math.abs(determinant)<1)return null;
  const g=(sx*dy2-sy*dx2)/determinant, h=(dx1*sy-dy1*sx)/determinant;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const u=x/(width-1),v=y/(height-1),w=g*u+h*v+1;
    const px=Math.round((x0+(x1-x0+g*x1)*u+(x3-x0+h*x3)*v)/w);
    const py=Math.round((y0+(y1-y0+g*y1)*u+(y3-y0+h*y3)*v)/w);
    const to=(y*width+x)*4;
    const from=(Math.min(canvas.height-1,Math.max(0,py))*canvas.width+Math.min(canvas.width-1,Math.max(0,px)))*4;
    pixels.data[to]=paper.data[from];pixels.data[to+1]=paper.data[from+1];pixels.data[to+2]=paper.data[from+2];pixels.data[to+3]=255;
  }
  context.putImageData(pixels,0,0);
  return result;
}

export function enhanceScan(canvas, crop={x:0,y:0,width:canvas.width,height:canvas.height}) {
  const result=document.createElement('canvas');
  const scale=Math.min(1.7,2700/Math.max(crop.width,crop.height));
  result.width=Math.max(1,Math.round(crop.width*scale));
  result.height=Math.max(1,Math.round(crop.height*scale));
  const context=result.getContext('2d');
  context.drawImage(canvas,crop.x,crop.y,crop.width,crop.height,0,0,result.width,result.height);
  const image=context.getImageData(0,0,result.width,result.height);
  const {data,width,height}=image;
  const gray=new Uint8Array(width*height);
  for(let i=0;i<gray.length;i++){
    const red=data[4*i],green=data[4*i+1],blue=data[4*i+2];
    const luminance=(red*77+green*150+blue*29)>>8;
    // Increase the contrast of faint blue pen strokes along with gray scans.
    gray[i]=Math.max(0,luminance-2*Math.max(0,blue-Math.max(red,green)-8));
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    const surround=(gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width])/4;
    const level=Math.max(0,Math.min(255,gray[i]+(gray[i]-surround)*1.2));
    const contrast=Math.max(0,Math.min(255,(level-35)*1.23));
    data[4*i]=data[4*i+1]=data[4*i+2]=contrast;
  }
  context.putImageData(image,0,0);
  return result;
}
