import { ORB_LIGHT_STYLES, ORB_METAL_PALETTES, ORB_PORT_LIGHTS, ORB_SKIN_STYLES, ORB_VISOR_PALETTES, paintOrbMaterialAtlas } from "./orb-materials.mjs";

const response = await fetch("./orb-core-v1-turnaround.png", { cache: "no-store" });
if (!response.ok) throw new Error(`Orb turnaround failed: ${response.status}`);
const orb = await createImageBitmap(await response.blob());
const maskResponse = await fetch("./orb-core-v1-material-mask.png", { cache: "no-store" });
if (!maskResponse.ok) throw new Error(`Orb material mask failed: ${maskResponse.status}`);
const materialMask = await createImageBitmap(await maskResponse.blob());
const panelResponse = await fetch("./orb-core-v1-panel-mask.png", { cache: "no-store" });
if (!panelResponse.ok) throw new Error(`Orb panel mask failed: ${panelResponse.status}`);
const panelMask = await createImageBitmap(await panelResponse.blob());
const targetResponse = await fetch("./orb-core-v1-attribute-targets.json", { cache: "no-store" });
if (!targetResponse.ok) throw new Error(`Orb attribute targets failed: ${targetResponse.status}`);
const attributeTargets = await targetResponse.json();
if (attributeTargets.schema !== "vault-attribute-targets@1") throw new Error("Orb attribute target schema is not supported");
const authoredHotspotCount = Object.values(attributeTargets.hotspots).reduce((count, hotspots) => count + Object.keys(hotspots).length, 0);

const canvas = document.querySelector("#orb-stage");
const context = canvas.getContext("2d");
context.imageSmoothingEnabled = false;
const directionOrder = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
const directionVectors = {
  east:[1,0], "south-east":[1,1], south:[0,1], "south-west":[-1,1], west:[-1,0], "north-west":[-1,-1], north:[0,-1], "north-east":[1,-1],
};
const palettes = {
  prism:["#ff4fd8","#7c5cff","#45e8ff","#72ff8b","#ffe66d"],
  void:["#140021","#542071","#d86cff"],
  solar:["#ff5a2d","#ffb22e","#fff6a5"],
  frost:["#2c7cff","#6ce8ff","#eaffff"],
  glitch:["#ff2fb3","#00ffd5","#ffffff"],
  arc:["#4967ff","#a1b7ff","#ffffff"],
};
const maskCanvas = document.createElement("canvas");
maskCanvas.width = materialMask.width;
maskCanvas.height = materialMask.height;
const maskContext = maskCanvas.getContext("2d", { willReadFrequently:true });
maskContext.drawImage(materialMask,0,0);
const maskPixels = maskContext.getImageData(0,0,maskCanvas.width,maskCanvas.height);
const panelCanvas = document.createElement("canvas");
panelCanvas.width = panelMask.width;
panelCanvas.height = panelMask.height;
const panelContext = panelCanvas.getContext("2d", { willReadFrequently:true });
panelContext.drawImage(panelMask,0,0);
const generatedPanelPixels = panelContext.getImageData(0,0,panelCanvas.width,panelCanvas.height);
function decodeFrame(runs){const output=[];for(const [value,count] of runs){for(let index=0;index<count;index+=1)output.push(value)}if(output.length!==34*34)throw new Error(`Orb attribute frame has ${output.length} pixels instead of 1156`);return output}
function buildUserPanelPixels(){
  const output=new ImageData(34*directionOrder.length,34);
  const colors={shell:[96,96,96,255],visor:[0,255,255,255],light:[180,0,255,255],port:[255,200,0,255]};
  for(const [frame,direction] of directionOrder.entries()){
    const decoded=decodeFrame(attributeTargets.componentFrames[direction]);
    for(let pixel=0;pixel<decoded.length;pixel+=1){
      const label=attributeTargets.componentLabels[decoded[pixel]]; const color=colors[label]; if(!color)continue;
      const x=pixel%34,y=Math.floor(pixel/34),offset=(y*output.width+frame*34+x)*4;
      output.data.set(color,offset);
    }
  }
  return output;
}
const panelPixels = attributeTargets.componentFrames ? buildUserPanelPixels() : generatedPanelPixels;
function buildSkinPixels(){
  const output=new ImageData(34*directionOrder.length,34);
  for(const [frame,direction] of directionOrder.entries()){
    const boundaries=decodeFrame(attributeTargets.skinFrames[direction]);
    const components=decodeFrame(attributeTargets.componentFrames[direction]);
    for(let pixel=0;pixel<boundaries.length;pixel+=1){
      const component=attributeTargets.componentLabels[components[pixel]];
      if(component!=="shell"||boundaries[pixel])continue;
      const x=pixel%34,y=Math.floor(pixel/34),offset=(y*output.width+frame*34+x)*4;
      output.data[offset]=255;output.data[offset+1]=255;output.data[offset+2]=255;output.data[offset+3]=255;
    }
  }
  return output;
}
const skinPixels=buildSkinPixels();
function componentSocket(frame,predicate,useLongestAxis=false){let count=0,sumX=0,sumY=0,minX=34,maxX=0,minY=34,maxY=0;for(let y=0;y<34;y++)for(let x=0;x<34;x++){const offset=(y*panelPixels.width+frame*34+x)*4;if(!predicate(panelPixels.data,offset))continue;count++;sumX+=x;sumY+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}if(!count)return null;const width=maxX-minX+1,height=maxY-minY+1;return [sumX/count,sumY/count,Math.max(1,(useLongestAxis?Math.max(width,height):Math.min(width,height))/2),true]}
function authoredSocket(direction,label,fallback){const point=attributeTargets.hotspots?.[direction]?.[label];return point?[point.x,point.y,fallback?.[2]??1.5,true]:fallback}
const lightSockets=Object.fromEntries(directionOrder.map((name,frame)=>{
  const painted=componentSocket(frame,(data,offset)=>data[offset]>130&&data[offset]<230&&data[offset+1]<160&&data[offset+2]>180);
  const visor=authoredSocket(name,"visor",null);
  if((name==="west"||name==="east")&&painted)return [name,painted];
  return [name,authoredSocket(name,"light",painted??(visor?[visor[0],visor[1],1.5,true]:null))];
}));
const portSockets=Object.fromEntries(directionOrder.map((name,frame)=>[name,authoredSocket(name,"port",componentSocket(frame,(data,offset)=>data[offset]>180&&data[offset+1]>150&&data[offset+2]<120,true))]));
const portLightSockets=Object.fromEntries(directionOrder.map(name=>{
  const port=portSockets[name];
  if(!port)return [name,null];
  return [name,[port[0],port[1],port[2],true]];
}));
const sourceCanvas = document.createElement("canvas");
sourceCanvas.width = orb.width;
sourceCanvas.height = orb.height;
const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently:true });
sourceContext.drawImage(orb,0,0);
const sourcePixels = sourceContext.getImageData(0,0,sourceCanvas.width,sourceCanvas.height);
const tintedCanvas = document.createElement("canvas");
tintedCanvas.width = materialMask.width;
tintedCanvas.height = materialMask.height;
const tintedContext = tintedCanvas.getContext("2d");

function selectedMetalPalette(){
  const selected=document.querySelector("#metal-style").value;
  return selected==="custom" ? [...document.querySelectorAll("[data-metal-band]")].map(input=>input.value) : ORB_METAL_PALETTES[selected];
}
function rebuildMaterial(){
  const shellPalette=selectedMetalPalette(); const visorStyle=document.querySelector("#visor-style").value;
  paintOrbMaterialAtlas({ sourcePixels, maskPixels, panelPixels, skinPixels, skinStyle:ORB_SKIN_STYLES[document.querySelector("#skin-style").value], targetContext:tintedContext, shellPalette, visorPalette:visorStyle==="matched"?shellPalette:ORB_VISOR_PALETTES[visorStyle], lightStyle:ORB_LIGHT_STYLES[document.querySelector("#eye-style").value], portLightStyle:selectedPortLight() });
}
rebuildMaterial();
let direction = "east";
let action = "idle";
let aim = { x: 1, y: 0 };
let input = "pointer";
let deathStartedAt = 0;
const worldLightState={schema:"vault-orb-light@1",active:false,color:"#ffffff",origin:{x:0,y:0},direction:{x:1,y:0},intensity:0,range:0};
globalThis.__VAULT_ORB_CORE_LIGHT__=worldLightState;

function normalized(x,y) { const length=Math.hypot(x,y)||1; return {x:x/length,y:y/length}; }
function nearestDirection(vector) {
  let best="east", score=-Infinity;
  for (const [name,[x,y]] of Object.entries(directionVectors)) { const n=normalized(x,y); const dot=n.x*vector.x+n.y*vector.y; if(dot>score){score=dot;best=name;} }
  return best;
}
function setDirection(name) {
  direction=name; const [x,y]=directionVectors[name]; aim=normalized(x,y);
  for(const button of document.querySelectorAll("[data-direction]")) button.setAttribute("aria-pressed",String(button.dataset.direction===name));
}
function roundedRect(x,y,w,h,r){ context.beginPath(); context.roundRect(x,y,w,h,r); }

function drawWeapon(x,y,angle,scale) {
  context.save(); context.translate(x,y); context.rotate(angle); context.scale(scale,scale);
  context.fillStyle="#f4f4f4"; context.strokeStyle="#17191d"; context.lineWidth=3;
  roundedRect(-3,-8,46,16,5); context.fill(); context.stroke();
  context.fillStyle="#8c8f96"; context.fillRect(5,-4,23,8);
  context.fillStyle="#ffffff"; context.fillRect(32,-3,14,6);
  context.restore();
}
function drawBeam(from,to,time,style) {
  const colors=palettes[style]; const dx=to.x-from.x,dy=to.y-from.y; const angle=Math.atan2(dy,dx); const length=Math.hypot(dx,dy);
  context.save(); context.translate(from.x,from.y); context.rotate(angle); context.globalCompositeOperation="lighter";
  for(let i=0;i<colors.length;i+=1){ context.strokeStyle=colors[i]; context.globalAlpha=.18+.1*Math.sin(time*.006+i); context.lineWidth=2+i*.8; context.beginPath(); context.moveTo(20,i-colors.length/2); context.quadraticCurveTo(length*.5,Math.sin(time*.004+i)*8,length-24,0); context.stroke(); }
  context.globalAlpha=.9; context.strokeStyle=colors[Math.floor(time/180)%colors.length]; context.lineWidth=2; context.beginPath(); context.arc(length-24,0,22+Math.sin(time*.005)*3,0,Math.PI*2); context.stroke();
  context.restore(); context.globalCompositeOperation="source-over"; context.globalAlpha=1;
}
function drawGlow(point,radius,time,color,intensity=1){
  const pulse=1+Math.sin(time*.006)*.12;
  context.save(); context.globalCompositeOperation="lighter";
  const glow=context.createRadialGradient(point.x,point.y,0,point.x,point.y,radius*4*pulse);
  glow.addColorStop(0,`rgba(255,255,255,${Math.min(1,intensity)})`); glow.addColorStop(.22,color); glow.addColorStop(1,"transparent");
  context.globalAlpha=intensity;
  context.fillStyle=glow; context.beginPath(); context.arc(point.x,point.y,radius*4*pulse,0,Math.PI*2); context.fill();
  context.restore();
}
function drawEyeLight(point,radius,time,outward){
  const style=ORB_LIGHT_STYLES[document.querySelector("#eye-style").value],normal=normalized(outward.x,outward.y),angle=Math.atan2(normal.y,normal.x);
  const glowRadius=Math.max(3.2,Math.min(5.2,radius*.42));
  drawGlow(point,glowRadius,time,style.glow,.82);
  context.save();context.translate(point.x,point.y);context.rotate(angle);context.globalCompositeOperation="lighter";
  const emission=context.createLinearGradient(0,0,18,0);emission.addColorStop(0,style.core);emission.addColorStop(.28,style.glow);emission.addColorStop(1,"transparent");
  context.globalAlpha=.38;context.fillStyle=emission;context.beginPath();context.moveTo(0,-2.4);context.quadraticCurveTo(9,-1.5,18,0);context.quadraticCurveTo(9,1.5,0,2.4);context.closePath();context.fill();
  context.fillStyle=style.glow;
  for(let index=0;index<4;index+=1){const phase=(time*.00062+index/4)%1,distance=4+phase*15,spread=Math.sin(time*.0045+index*2.1)*(1+phase*2);context.globalAlpha=.58*(1-phase);context.fillRect(Math.round(distance),Math.round(spread),phase<.3?2:1,phase<.3?2:1)}
  context.restore();
  worldLightState.active=true;worldLightState.color=style.glow;worldLightState.origin.x=point.x;worldLightState.origin.y=point.y;worldLightState.direction.x=normal.x;worldLightState.direction.y=normal.y;worldLightState.intensity=.82;worldLightState.range=48;
}
function selectedPortLight(){
  const selected=ORB_PORT_LIGHTS[document.querySelector("#port-light-style").value];
  return selected?.linkedLight?{...ORB_LIGHT_STYLES[document.querySelector("#eye-style").value],intensity:selected.intensity}:selected;
}
function drawPortLight(point,radius,time,style,outward,sideProfile=false){
  if(!style?.core||style.intensity<=0)return;
  const glowRadius=3.4;
  const normal=normalized(outward.x,outward.y),angle=Math.atan2(normal.y,normal.x),extent=15;
  context.save();context.translate(point.x,point.y);context.rotate(angle);context.beginPath();context.rect(0,-extent,extent,extent*2);context.clip();context.rotate(-angle);context.translate(-point.x,-point.y);
  drawGlow(point,glowRadius,time,style.glow,style.intensity);
  context.save();context.translate(point.x,point.y);context.rotate(angle);context.globalCompositeOperation="lighter";context.globalAlpha=style.intensity*.55;
  const plume=context.createLinearGradient(0,0,12,0);plume.addColorStop(0,style.glow);plume.addColorStop(.45,style.edge);plume.addColorStop(1,"transparent");context.fillStyle=plume;context.beginPath();context.moveTo(0,-2.2);context.quadraticCurveTo(7,-1.4,13,0);context.quadraticCurveTo(7,1.4,0,2.2);context.closePath();context.fill();context.restore();
  const tangent={x:-normal.y,y:normal.x};context.globalCompositeOperation="lighter";context.fillStyle=style.glow;
  for(let index=0;index<5;index+=1){const phase=(time*.00048+index/5)%1,distance=3+phase*12,spread=Math.sin(time*.004+index*2.3)*(1+phase*2);context.globalAlpha=style.intensity*(1-phase)*.8;const size=phase<.24?2:1;context.fillRect(Math.round(point.x+normal.x*distance+tangent.x*spread),Math.round(point.y+normal.y*distance+tangent.y*spread),size,size)}
  context.restore();
}
function draw(time) {
  const center={x:canvas.width/2,y:canvas.height/2}; const wave=Math.sin(time*.004); const moving=action==="move"; const dying=action==="death";
  const bob=dying?0:wave*8; const lean=moving?8:0; const scale=dying?Math.max(0,1-(time-deathStartedAt)/1200):1;
  const weaponDistance=120+(moving?12:0)+Math.sin(time*.005)*5; const weapon={x:center.x+aim.x*weaponDistance,y:center.y+aim.y*weaponDistance+bob*.35};
  const orbPoint={x:center.x+aim.x*lean,y:center.y+bob}; const socket=lightSockets[direction]; const renderedSize=170*scale;
  const fallback={x:orbPoint.x+aim.x*renderedSize*.43,y:orbPoint.y+aim.y*renderedSize*.32};
  const eyePoint=socket?{x:orbPoint.x+(socket[0]-17)*renderedSize/34,y:orbPoint.y+(socket[1]-17)*renderedSize/34}:fallback;
  const portSocket=portLightSockets[direction]; const portPoint=portSocket?{x:orbPoint.x+(portSocket[0]-17)*renderedSize/34,y:orbPoint.y+(portSocket[1]-17)*renderedSize/34}:null;
  context.clearRect(0,0,canvas.width,canvas.height);
  worldLightState.active=false;worldLightState.intensity=0;worldLightState.range=0;
  context.fillStyle=`rgba(1,8,7,${.17-wave*.018})`; context.beginPath(); context.ellipse(center.x,center.y+70,58-wave*3,20-wave*2,0,0,Math.PI*2); context.fill();
  if(!dying||scale>0){
    drawBeam(eyePoint,weapon,time,document.querySelector("#fx-style").value);
    const row=directionOrder.indexOf(direction); const size=renderedSize;
    context.save(); context.translate(center.x+aim.x*lean,center.y+bob); context.rotate(moving?aim.y*.05:wave*.01); context.drawImage(tintedCanvas,row*34,0,34,34,-size/2,-size/2,size,size); context.restore();
    if(socket)drawEyeLight(eyePoint,socket[2]*size/34,time,aim);
    if(portPoint)drawPortLight(portPoint,portSocket[2]*size/34,time,selectedPortLight(),{x:portPoint.x-orbPoint.x,y:portPoint.y-orbPoint.y},direction==="west"||direction==="east");
    drawWeapon(weapon.x,weapon.y,Math.atan2(aim.y,aim.x),scale);
  } else if(time-deathStartedAt>1500){ action="idle"; document.querySelector('[data-action="idle"]').click(); }
  document.querySelector("#active-direction").textContent=direction; document.querySelector("#active-input").textContent=input;
  document.documentElement.dataset.orbReady="true"; document.documentElement.dataset.orbDirection=direction; document.documentElement.dataset.orbAction=action; document.documentElement.dataset.orbFx=document.querySelector("#fx-style").value;
  document.documentElement.dataset.orbMetal=document.querySelector("#metal-style").value;
  document.documentElement.dataset.orbShell=document.querySelector("#shell-style").value; document.documentElement.dataset.orbVisor=document.querySelector("#visor-style").value; document.documentElement.dataset.orbEye=document.querySelector("#eye-style").value; document.documentElement.dataset.orbSkin=document.querySelector("#skin-style").value;
  document.documentElement.dataset.orbPortLight=document.querySelector("#port-light-style").value;
  document.documentElement.dataset.orbCoreEmitter=worldLightState.active?"active":"hidden";document.documentElement.dataset.orbCoreEmitterColor=worldLightState.color;document.documentElement.dataset.orbCoreEmitterIntensity=String(worldLightState.intensity);document.documentElement.dataset.orbCoreEmitterRange=String(worldLightState.range);
  document.documentElement.dataset.orbTargets="user-authored"; document.documentElement.dataset.orbHotspots=String(authoredHotspotCount);
  requestAnimationFrame(draw);
}

canvas.addEventListener("pointermove",event=>{ const rect=canvas.getBoundingClientRect(); const x=(event.clientX-rect.left)/rect.width*canvas.width-canvas.width/2; const y=(event.clientY-rect.top)/rect.height*canvas.height-canvas.height/2; aim=normalized(x,y); direction=nearestDirection(aim); input=event.pointerType==="touch"?"touch":"pointer"; });
for(const button of document.querySelectorAll("[data-direction]")) button.addEventListener("click",()=>{setDirection(button.dataset.direction);input="buttons";});
for(const button of document.querySelectorAll("[data-action]")) button.addEventListener("click",()=>{ action=button.dataset.action; if(action==="death") deathStartedAt=performance.now(); for(const peer of document.querySelectorAll("[data-action]")) peer.setAttribute("aria-pressed",String(peer===button)); });
document.querySelector("#metal-style").addEventListener("change",rebuildMaterial);
for(const input of document.querySelectorAll("[data-metal-band]")) input.addEventListener("input",()=>{ document.querySelector("#metal-style").value="custom"; rebuildMaterial(); });
document.querySelector("#skin-style").addEventListener("change",rebuildMaterial);
document.querySelector("#shell-style").addEventListener("change",rebuildMaterial);
document.querySelector("#visor-style").addEventListener("change",rebuildMaterial);
document.querySelector("#eye-style").addEventListener("change",rebuildMaterial);
document.querySelector("#port-light-style").addEventListener("change",rebuildMaterial);

function pollGamepad(){ const pad=navigator.getGamepads?.().find(Boolean); if(pad){ const x=pad.axes[2]??0,y=pad.axes[3]??0; if(Math.hypot(x,y)>.25){aim=normalized(x,y);direction=nearestDirection(aim);input="controller";} } requestAnimationFrame(pollGamepad); }
pollGamepad(); requestAnimationFrame(draw);
