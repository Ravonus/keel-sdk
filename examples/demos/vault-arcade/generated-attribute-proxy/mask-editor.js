const CELL=34, SCALE=18;
const directions=["south","south-west","west","north-west","north","north-east","east","south-east"];
const labels={ignore:0,shell:1,visor:2,light:3,port:4,skin:5,weapon:6};
const names=["ignore","shell","visor","light","port","skin","weapon"];
const colors=[[49,54,59,110],[255,72,98,120],[63,220,255,145],[189,101,255,165],[255,98,92,175],[114,255,139,155],[255,155,69,165]];
const storageKey="vault-orb-e1689862-attribute-editor@4";
const lightSockets={south:[17,20,4.5,4.8],"south-west":[7,21,3.4,4.2],west:[2,18,1.2,3.2],east:[31,18,1.2,3.2],"south-east":[27,21,3.4,4.2]};
const [sourceBitmap,panelBitmap]=await Promise.all([
  fetch("./orb-core-v1-turnaround.png",{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error(`source ${r.status}`);return r.blob()}).then(createImageBitmap),
  fetch("./orb-core-v1-panel-mask.png",{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error(`panel ${r.status}`);return r.blob()}).then(createImageBitmap),
]);
const sourceCanvas=document.createElement("canvas"); sourceCanvas.width=sourceBitmap.width; sourceCanvas.height=sourceBitmap.height;
const sourceContext=sourceCanvas.getContext("2d",{willReadFrequently:true}); sourceContext.drawImage(sourceBitmap,0,0); const source=sourceContext.getImageData(0,0,sourceCanvas.width,sourceCanvas.height);
const panelCanvas=document.createElement("canvas"); panelCanvas.width=panelBitmap.width; panelCanvas.height=panelBitmap.height;
const panelContext=panelCanvas.getContext("2d",{willReadFrequently:true}); panelContext.drawImage(panelBitmap,0,0); const panel=panelContext.getImageData(0,0,panelCanvas.width,panelCanvas.height);
let mask=new Uint8Array(CELL*CELL*8),skinMask=new Uint8Array(CELL*CELL*8),hotspots={},direction="south",tool="shell",painting=false,dirty=false,undoStack=[],redoStack=[];

function snapshot(){return {mask:[...mask],skin:[...skinMask],hotspots:structuredClone(hotspots)}}
function restoreSnapshot(state){mask=Uint8Array.from(state.mask);skinMask=Uint8Array.from(state.skin);hotspots=structuredClone(state.hotspots);dirty=true;render();save();updateHistoryButtons()}
function remember(){undoStack.push(snapshot());if(undoStack.length>100)undoStack.shift();redoStack=[];updateHistoryButtons()}
function updateHistoryButtons(){document.querySelector("#undo").disabled=undoStack.length===0;document.querySelector("#redo").disabled=redoStack.length===0}
function undo(){if(!undoStack.length)return;redoStack.push(snapshot());restoreSnapshot(undoStack.pop())}
function redo(){if(!redoStack.length)return;undoStack.push(snapshot());restoreSnapshot(redoStack.pop())}

function resetAuto(){
  mask.fill(0);skinMask.fill(0);hotspots={};
  for(let frame=0;frame<8;frame+=1) for(let y=0;y<CELL;y+=1) for(let x=0;x<CELL;x+=1){
    const sourceOffset=(y*source.width+frame*CELL+x)*4, target=frame*CELL*CELL+y*CELL+x;
    if(source.data[sourceOffset+3]===0) continue;
    const r=panel.data[sourceOffset],g=panel.data[sourceOffset+1],b=panel.data[sourceOffset+2],a=panel.data[sourceOffset+3];
    if(a===0) mask[target]=labels.ignore;
    else if(r<120&&g>150&&b>180) mask[target]=labels.visor;
    else if(r>180&&g>150&&b<120) mask[target]=labels.port;
    else mask[target]=labels.shell;
  }
  directions.forEach((name,frame)=>{const socket=lightSockets[name];if(!socket)return;const [cx,cy,rx,ry]=socket;for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){const sourceOffset=(y*source.width+frame*CELL+x)*4;if(source.data[sourceOffset+3]===0)continue;const distance=((x-cx)/rx)**2+((y-cy)/ry)**2;if(distance<=1)mask[frame*CELL*CELL+y*CELL+x]=labels.light}});
  dirty=true; render();
}
function restore(){ const stored=localStorage.getItem(storageKey); if(!stored){resetAuto();seedHotspots();save();return} const parsed=JSON.parse(stored); mask=Uint8Array.from(parsed.labels);skinMask=Uint8Array.from(parsed.skin||new Array(mask.length).fill(0));hotspots=parsed.hotspots||{};render(); }
function seedHotspots(){directions.forEach((name,frame)=>{hotspots[name]??={};for(const label of ["shell","visor","light","port"]){let count=0,x=0,y=0;for(let py=0;py<CELL;py++)for(let px=0;px<CELL;px++){if(mask[frame*CELL*CELL+py*CELL+px]!==labels[label])continue;count++;x+=px;y+=py}if(count)hotspots[name][label]={x:Math.round(x/count),y:Math.round(y/count)}}})}
function compact(){
  const frames={};
  directions.forEach((name,frame)=>{const values=mask.slice(frame*CELL*CELL,(frame+1)*CELL*CELL);const runs=[];let value=values[0],length=1;for(let i=1;i<values.length;i++){if(values[i]===value)length++;else{runs.push([value,length]);value=values[i];length=1}}runs.push([value,length]);frames[name]=runs});
  const skinFrames={};directions.forEach((name,frame)=>{const values=skinMask.slice(frame*CELL*CELL,(frame+1)*CELL*CELL);const runs=[];let value=values[0],length=1;for(let i=1;i<values.length;i++){if(values[i]===value)length++;else{runs.push([value,length]);value=values[i];length=1}}runs.push([value,length]);skinFrames[name]=runs});
  return {schema:"vault-attribute-targets@1",objectId:"e1689862-b846-4ff1-af12-688d521043fc",cell:[CELL,CELL],componentLabels:names.slice(0,5),componentFrames:frames,skinFrames,hotspots};
}
function decodeRuns(runs){const output=[];for(const [value,count] of runs)for(let index=0;index<count;index++)output.push(value);if(output.length!==CELL*CELL)throw new Error(`target frame has ${output.length} pixels`);return output}
function loadCompact(data){
  if(data.schema!=="vault-attribute-targets@1"||data.objectId!=="e1689862-b846-4ff1-af12-688d521043fc")throw new Error("Pinned target file does not match this orb");
  const nextMask=new Uint8Array(CELL*CELL*directions.length),nextSkin=new Uint8Array(CELL*CELL*directions.length);
  directions.forEach((name,frame)=>{nextMask.set(decodeRuns(data.componentFrames[name]),frame*CELL*CELL);nextSkin.set(decodeRuns(data.skinFrames[name]),frame*CELL*CELL)});
  mask=nextMask;skinMask=nextSkin;hotspots=structuredClone(data.hotspots);dirty=true;render();save();updateHistoryButtons();
}
function publishCompact(){let output=document.querySelector("#attribute-target-export");if(!output){output=document.createElement("script");output.id="attribute-target-export";output.type="application/json";document.body.append(output)}output.textContent=JSON.stringify(compact())}
function save(){ localStorage.setItem(storageKey,JSON.stringify({schema:"vault-attribute-editor@1",labels:[...mask],skin:[...skinMask],hotspots}));dirty=false;document.querySelector("#status").textContent="saved";document.documentElement.dataset.maskSaved="true";publishCompact(); }
function render(){
  const canvas=document.querySelector("#mask-canvas"),ctx=canvas.getContext("2d");ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);
  const frame=directions.indexOf(direction);if(document.querySelector("#show-sprite").checked)ctx.drawImage(sourceBitmap,frame*CELL,0,CELL,CELL,0,0,CELL*SCALE,CELL*SCALE);
  const opacity=Number(document.querySelector("#mask-opacity").value)/100;
  for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){const value=mask[frame*CELL*CELL+y*CELL+x];if(value===0)continue;const color=colors[value];ctx.fillStyle=`rgba(${color[0]},${color[1]},${color[2]},${opacity})`;ctx.fillRect(x*SCALE,y*SCALE,SCALE,SCALE)}
  for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){if(!skinMask[frame*CELL*CELL+y*CELL+x])continue;ctx.fillStyle=`rgba(114,255,139,${opacity})`;ctx.fillRect(x*SCALE,y*SCALE,SCALE,SCALE)}
  if(document.querySelector("#show-hotspots").checked)for(const [name,point] of Object.entries(hotspots[direction]||{})){const value=labels[name]??6,color=colors[value];ctx.save();ctx.strokeStyle=`rgb(${color.slice(0,3).join(",")})`;ctx.lineWidth=name===tool?3:2;const cx=(point.x+.5)*SCALE,cy=(point.y+.5)*SCALE;ctx.beginPath();ctx.arc(cx,cy,name===tool?9:6,0,Math.PI*2);ctx.moveTo(cx-12,cy);ctx.lineTo(cx+12,cy);ctx.moveTo(cx,cy-12);ctx.lineTo(cx,cy+12);ctx.stroke();ctx.restore()}
  ctx.strokeStyle="rgba(255,255,255,.09)";ctx.lineWidth=1;for(let i=0;i<=CELL;i++){ctx.beginPath();ctx.moveTo(i*SCALE,0);ctx.lineTo(i*SCALE,CELL*SCALE);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i*SCALE);ctx.lineTo(CELL*SCALE,i*SCALE);ctx.stroke()}
  document.querySelector("#read-direction").textContent=direction;document.querySelector("#status").textContent=dirty?"unsaved":"saved";document.documentElement.dataset.maskDirection=direction;document.documentElement.dataset.maskTool=tool;document.documentElement.dataset.editMode=document.querySelector("#edit-mode").value;
}
function point(event){const rect=event.currentTarget.getBoundingClientRect();return {x:Math.floor((event.clientX-rect.left)/rect.width*CELL),y:Math.floor((event.clientY-rect.top)/rect.height*CELL)}}
function inspect(x,y){if(x<0||x>=CELL||y<0||y>=CELL)return;const frame=directions.indexOf(direction),offset=(y*source.width+frame*CELL+x)*4,value=mask[frame*CELL*CELL+y*CELL+x];const luma=Math.round(source.data[offset]*.2126+source.data[offset+1]*.7152+source.data[offset+2]*.0722);document.querySelector("#read-coordinate").textContent=`${x}, ${y}`;document.querySelector("#read-luma").textContent=String(luma);document.querySelector("#read-alpha").textContent=String(source.data[offset+3]);document.querySelector("#read-label").textContent=names[value]}
function paint(x,y){const frame=directions.indexOf(direction),radius=Number(document.querySelector("#brush-size").value)-1;for(let py=y-radius;py<=y+radius;py++)for(let px=x-radius;px<=x+radius;px++){if(px<0||px>=CELL||py<0||py>=CELL)continue;const index=frame*CELL*CELL+py*CELL+px;if(tool==="ignore"){mask[index]=0;skinMask[index]=0}else if(tool==="skin")skinMask[index]=1;else if(tool!=="weapon")mask[index]=labels[tool]}dirty=true;render();inspect(x,y)}
function placeHotspot(x,y){hotspots[direction]??={};hotspots[direction][tool]={x,y};dirty=true;render();inspect(x,y)}
const canvas=document.querySelector("#mask-canvas");canvas.addEventListener("pointerdown",event=>{const p=point(event);remember();if(document.querySelector("#edit-mode").value==="hotspot"){if(tool==="ignore"){const entries=Object.entries(hotspots[direction]||{});entries.sort((a,b)=>Math.hypot(a[1].x-p.x,a[1].y-p.y)-Math.hypot(b[1].x-p.x,b[1].y-p.y));if(entries[0]&&Math.hypot(entries[0][1].x-p.x,entries[0][1].y-p.y)<=4)delete hotspots[direction][entries[0][0]];dirty=true;render();save();return}placeHotspot(p.x,p.y);save();return}painting=true;canvas.setPointerCapture(event.pointerId);paint(p.x,p.y)});canvas.addEventListener("pointermove",event=>{const p=point(event);inspect(p.x,p.y);if(painting)paint(p.x,p.y)});canvas.addEventListener("pointerup",()=>{painting=false;save()});
for(const button of document.querySelectorAll("[data-direction]"))button.addEventListener("click",()=>{direction=button.dataset.direction;for(const peer of document.querySelectorAll("[data-direction]"))peer.setAttribute("aria-pressed",String(peer===button));render()});
for(const button of document.querySelectorAll("[data-tool]"))button.addEventListener("click",()=>{tool=button.dataset.tool;for(const peer of document.querySelectorAll("[data-tool]"))peer.setAttribute("aria-pressed",String(peer===button));render()});
document.querySelector("#edit-mode").addEventListener("change",render);document.querySelector("#show-sprite").addEventListener("change",render);document.querySelector("#show-hotspots").addEventListener("change",render);document.querySelector("#mask-opacity").addEventListener("input",render);document.querySelector("#sprite-only").addEventListener("click",()=>{document.querySelector("#show-sprite").checked=true;document.querySelector("#show-hotspots").checked=false;document.querySelector("#mask-opacity").value="0";render()});document.querySelector("#undo").addEventListener("click",undo);document.querySelector("#redo").addEventListener("click",redo);document.querySelector("#erase-hotspot").addEventListener("click",()=>{if(!hotspots[direction]?.[tool])return;remember();delete hotspots[direction][tool];dirty=true;render();save()});document.querySelector("#save").addEventListener("click",save);document.querySelector("#copy").addEventListener("click",async()=>navigator.clipboard.writeText(JSON.stringify(compact())));document.querySelector("#download").addEventListener("click",()=>{const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([JSON.stringify(compact(),null,2)],{type:"application/json"}));link.download="orb-core-v1-attribute-targets.json";link.click();URL.revokeObjectURL(link.href)});document.querySelector("#reset").addEventListener("click",()=>{remember();resetAuto();seedHotspots();save()});document.querySelector("#clear").addEventListener("click",()=>{remember();const frame=directions.indexOf(direction);mask.fill(0,frame*CELL*CELL,(frame+1)*CELL*CELL);skinMask.fill(0,frame*CELL*CELL,(frame+1)*CELL*CELL);hotspots[direction]={};dirty=true;render();save()});
document.querySelector("#load-pinned").addEventListener("click",async()=>{document.querySelector("#status").textContent="loading";const response=await fetch("./orb-core-v1-attribute-targets.json",{cache:"no-store"});if(!response.ok)throw new Error(`pinned targets ${response.status}`);remember();loadCompact(await response.json())});
restore();
publishCompact();
updateHistoryButtons();
