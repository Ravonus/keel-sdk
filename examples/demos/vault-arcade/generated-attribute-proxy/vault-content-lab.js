import { deterministicFingerprint, hash32, makeRng } from "./vault-game-core.mjs";

const SIZE=24,STORAGE_KEY="vault-content-targets@1";
const typeSpecs={
  tile:{label:"Tiles",description:"floor, wall, hazard, collision",templates:["floor","wall","hazard"]},
  object:{label:"Objects",description:"cover, cache, relay, prop",templates:["relay","cache","obelisk"]},
  enemy:{label:"Enemies",description:"body, weak point, ability",templates:["drifter","lancer","bulwark"]},
  boss:{label:"Bosses",description:"body plus targetable parts",templates:["warden","loom","devourer"]},
  effect:{label:"Effects",description:"particle, field, projectile",templates:["burst","beam","pool"]},
};
const regions=[
  {id:"empty",label:"Erase / transparent",color:"#00000000"},
  {id:"material",label:"Base material",color:"#75838a"},
  {id:"accent",label:"Secondary material",color:"#b8c2c6"},
  {id:"emissive",label:"Emissive / particle",color:"#67f6c5"},
  {id:"danger",label:"Danger / damage",color:"#ff5f8f"},
  {id:"collision",label:"Collision / solid",color:"#7460ff"},
  {id:"weakpoint",label:"Weak point / target",color:"#ffe76b"},
];
const palettes={
  "cyan-magenta":{material:"#263a3c",accent:"#74878b",emissive:"#64ffe0",danger:"#ff5f9f",collision:"#4f4d87",weakpoint:"#fff17a"},
  "amber-violet":{material:"#3b2a1c",accent:"#8c704a",emissive:"#ffc65c",danger:"#d86cff",collision:"#684d78",weakpoint:"#fff09e"},
  "acid-rose":{material:"#253b29",accent:"#69826d",emissive:"#b8ff62",danger:"#ff658d",collision:"#436c52",weakpoint:"#efffa7"},
  "ice-void":{material:"#222c45",accent:"#697899",emissive:"#78f5ff",danger:"#d38cff",collision:"#4c4d76",weakpoint:"#e7f5ff"},
};
let type="tile",activeRegion="material",pixels=new Uint8Array(SIZE*SIZE),history=[],future=[],painting=false;
const editor=document.querySelector("#editor"),ctx=editor.getContext("2d"),preview=document.querySelector("#preview"),previewContext=preview.getContext("2d");ctx.imageSmoothingEnabled=false;previewContext.imageSmoothingEnabled=false;

function buildTypeButtons(){const root=document.querySelector("#types");for(const [id,spec] of Object.entries(typeSpecs)){const button=document.createElement("button");button.dataset.type=id;button.innerHTML=`<strong>${spec.label}</strong><small>${spec.description}</small>`;button.addEventListener("click",()=>setType(id));root.append(button)}}
function buildLayers(){const root=document.querySelector("#layers");for(const region of regions){const button=document.createElement("div");button.className="layer";button.dataset.region=region.id;button.innerHTML=`<span class="swatch" style="background:${region.id==="empty"?"repeating-linear-gradient(45deg,#222 0 4px,#555 4px 8px)":region.color}"></span><span>${region.label}</span>`;button.addEventListener("click",()=>{activeRegion=region.id;updateSelected()});root.append(button)}}
function updateSelected(){for(const button of document.querySelectorAll("[data-type]"))button.setAttribute("aria-pressed",String(button.dataset.type===type));for(const layer of document.querySelectorAll("[data-region]"))layer.classList.toggle("active",layer.dataset.region===activeRegion)}
function setType(next){type=next;const select=document.querySelector("#template");select.replaceChildren(...typeSpecs[type].templates.map(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;return option}));document.querySelector("#asset-name").value=`${typeSpecs[type].templates[0]} ${type}`;loadSavedOrTemplate();updateSelected()}
function snapshot(){history.push(pixels.slice());if(history.length>60)history.shift();future=[]}
function indexOf(x,y){return y*SIZE+x}
function regionIndex(id){return regions.findIndex(region=>region.id===id)}
function templatePixels(name){const output=new Uint8Array(SIZE*SIZE);const rng=makeRng(`${type}:${name}`);const paint=(x,y,id)=>{if(x>=0&&x<SIZE&&y>=0&&y<SIZE)output[indexOf(x,y)]=regionIndex(id)};if(type==="tile"){for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){paint(x,y,"material");if(x%8===0||y%8===0)paint(x,y,"accent");if(name==="hazard"&&(x+y)%9<2)paint(x,y,"danger")}for(let x=0;x<SIZE;x++){paint(x,0,"collision");paint(x,SIZE-1,"collision")}}else if(type==="effect"){for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const d=Math.hypot(x-11.5,y-11.5);if(Math.abs(d-7)<2)paint(x,y,"emissive");if(name==="pool"&&d<5)paint(x,y,"danger")}}else{const radius=type==="boss"?10:type==="enemy"?7:8;for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const d=Math.hypot(x-11.5,y-11.5);if(d<radius)paint(x,y,"material");if(d<radius*.62)paint(x,y,"accent");if(d<radius*.25)paint(x,y,type==="object"?"emissive":"weakpoint")}if(type==="boss"){for(const [x,y] of [[4,4],[19,4],[4,19],[19,19]])for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++)if(Math.hypot(ox,oy)<2.5)paint(x+ox,y+oy,"weakpoint")}for(let i=0;i<16;i++)if(rng()>.7)paint(5+Math.floor(rng()*14),5+Math.floor(rng()*14),"emissive")}return output}
function savedKey(){return `${type}:${document.querySelector("#template").value}`}
function loadAll(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")}catch{return {}}}
function loadSavedOrTemplate(){const saved=loadAll()[savedKey()];pixels=saved?.pixels?Uint8Array.from(saved.pixels):templatePixels(document.querySelector("#template").value);history=[];future=[];render()}
function render(){ctx.clearRect(0,0,editor.width,editor.height);previewContext.clearRect(0,0,preview.width,preview.height);const scale=editor.width/SIZE;const palette=palettes[document.querySelector("#palette").value];for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const region=regions[pixels[indexOf(x,y)]];ctx.fillStyle=region.id==="empty"?((x+y)%2?"#09100f":"#111c19"):region.color;ctx.fillRect(x*scale,y*scale,scale,scale);ctx.strokeStyle="rgba(255,255,255,.045)";ctx.strokeRect(x*scale+.5,y*scale+.5,scale-1,scale-1);previewContext.fillStyle=region.id==="empty"?"transparent":palette[region.id]??region.color;previewContext.fillRect(x*6,y*6,6,6)}const record=buildRecord();document.querySelector("#ledger").textContent=JSON.stringify({schema:record.schema,kind:record.kind,name:record.name,template:record.template,seed:record.seed,size:record.size,regionOrder:record.regionOrder,counts:record.counts,runs:encodeRuns(pixels).length,digest:record.digest},null,2);document.documentElement.dataset.vaultContentEditorReady="true"}
function encodeRuns(values){const runs=[];for(const value of values){const last=runs.at(-1);if(last&&last[0]===value)last[1]+=1;else runs.push([value,1])}return runs}
function buildRecord(){const counts=Object.fromEntries(regions.map((region,index)=>[region.id,[...pixels].filter(value=>value===index).length]));const core={schema:"vault-content-targets@1",kind:type,name:document.querySelector("#asset-name").value,template:document.querySelector("#template").value,seed:document.querySelector("#asset-seed").value,size:[SIZE,SIZE],regionOrder:regions.map(region=>region.id),pixels:[...pixels],counts};return {...core,digest:deterministicFingerprint(core)}}
function point(event){const bounds=editor.getBoundingClientRect();return{x:Math.floor((event.clientX-bounds.left)/bounds.width*SIZE),y:Math.floor((event.clientY-bounds.top)/bounds.height*SIZE)}}
function paint(event){const {x,y}=point(event);if(x<0||x>=SIZE||y<0||y>=SIZE)return;pixels[indexOf(x,y)]=regionIndex(activeRegion);render()}
function fillAt(){const start=lastPoint,target=pixels[indexOf(start.x,start.y)],replacement=regionIndex(activeRegion);if(target===replacement)return;const queue=[start],seen=new Set();while(queue.length){const current=queue.pop(),key=`${current.x}:${current.y}`;if(seen.has(key)||current.x<0||current.y<0||current.x>=SIZE||current.y>=SIZE||pixels[indexOf(current.x,current.y)]!==target)continue;seen.add(key);pixels[indexOf(current.x,current.y)]=replacement;queue.push({x:current.x+1,y:current.y},{x:current.x-1,y:current.y},{x:current.x,y:current.y+1},{x:current.x,y:current.y-1})}render()}
let lastPoint={x:12,y:12};editor.addEventListener("pointerdown",event=>{event.preventDefault();snapshot();painting=true;lastPoint=point(event);paint(event);editor.setPointerCapture(event.pointerId)});editor.addEventListener("pointermove",event=>{lastPoint=point(event);if(painting)paint(event)});editor.addEventListener("pointerup",()=>painting=false);
document.querySelector("#undo").addEventListener("click",()=>{if(!history.length)return;future.push(pixels.slice());pixels=history.pop();render()});document.querySelector("#redo").addEventListener("click",()=>{if(!future.length)return;history.push(pixels.slice());pixels=future.pop();render()});document.querySelector("#fill").addEventListener("click",()=>{snapshot();fillAt()});document.querySelector("#clear").addEventListener("click",()=>{snapshot();const target=regionIndex(activeRegion);for(let index=0;index<pixels.length;index++)if(pixels[index]===target)pixels[index]=0;render()});
document.querySelector("#save").addEventListener("click",()=>{const all=loadAll();all[savedKey()]=buildRecord();localStorage.setItem(STORAGE_KEY,JSON.stringify(all));document.querySelector("#status").textContent="DRAFT SAVED"});document.querySelector("#export").addEventListener("click",()=>{const blob=new Blob([JSON.stringify(buildRecord(),null,2)],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${savedKey().replace(":","-")}-targets.json`;link.click();URL.revokeObjectURL(link.href)});
document.querySelector("#template").addEventListener("change",loadSavedOrTemplate);document.querySelector("#palette").addEventListener("change",render);document.querySelector("#asset-name").addEventListener("input",render);document.querySelector("#asset-seed").addEventListener("input",render);document.querySelector("#roll").addEventListener("click",()=>{const input=document.querySelector("#asset-seed");input.value=`content-${hash32(`${input.value}:${Date.now()}`).toString(16).slice(0,6)}`;render()});
buildTypeButtons();buildLayers();setType("tile");
