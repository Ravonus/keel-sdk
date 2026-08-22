import {WEAPON_REGION_OVERRIDE_STORAGE_KEY,loadWeaponRegionOverrides,resolveWeaponRegion} from "./weapon-region-resolver.js";
import {KEEL_SOUND_BITS_CODEC,createAudioReader,parseSpriteSoundCatalog,resolveSpriteSound} from "./oca-readers.js";

const paletteSelect=document.querySelector("#weapon-palette");
const particleColorSelect=document.querySelector("#weapon-particle-color");
const seedInput=document.querySelector("#weapon-seed");
const rollButton=document.querySelector("#roll-weapons");
const soundButton=document.querySelector("#weapon-sound-toggle");
const soundStatus=document.querySelector("#weapon-sound-status");
const canvases=[...document.querySelectorAll("[data-weapon]")];
const attributeResponse=await fetch("./weapon-attributes-v1.json",{cache:"no-store"});
if(!attributeResponse.ok)throw new Error(`Weapon attribute catalogue failed: ${attributeResponse.status}`);
const weaponAttributeCatalog=await attributeResponse.json();
if(weaponAttributeCatalog.schema!=="vault-weapon-attributes@1")throw new Error("Weapon attribute catalogue schema is not supported");
const regionLayoutResponse=await fetch("./weapon-region-layouts-v2.json",{cache:"no-store"});
if(!regionLayoutResponse.ok)throw new Error(`Weapon region layouts failed: ${regionLayoutResponse.status}`);
const weaponRegionLayouts=await regionLayoutResponse.json();
if(weaponRegionLayouts.schema!=="vault-weapon-region-layouts@2")throw new Error("Weapon region layout schema is not supported");
const regionOverrideResponse=await fetch("./weapon-region-overrides-v1.json",{cache:"no-store"});
if(!regionOverrideResponse.ok)throw new Error(`Weapon region overrides failed: ${regionOverrideResponse.status}`);
const defaultWeaponRegionOverrides=await regionOverrideResponse.json();
if(defaultWeaponRegionOverrides.schema!=="vault-weapon-region-overrides@1")throw new Error("Weapon region override schema is not supported");
const soundCatalogResponse=await fetch("./weapon-sounds-v1.json",{cache:"no-store"});
if(!soundCatalogResponse.ok)throw new Error(`Weapon sound catalogue failed: ${soundCatalogResponse.status}`);
const weaponSoundCatalog=parseSpriteSoundCatalog(await soundCatalogResponse.json());
const soundResourceIds=[...new Set(weaponSoundCatalog.profiles.flatMap(profile=>profile.events.flatMap(event=>event.variations.map(sound=>sound.resourceId))))];
const soundBytes=new Map(await Promise.all(soundResourceIds.map(async resourceId=>{const response=await fetch(`./audio/${resourceId}`,{cache:"no-store"});if(!response.ok)throw new Error(`Weapon sound failed: ${resourceId} (${response.status})`);return [resourceId,new Uint8Array(await response.arrayBuffer())]})));
let weaponRegionOverrides=loadWeaponRegionOverrides(defaultWeaponRegionOverrides);
const weaponBuilds={};
const characterBuild={};
const weaponSources={
  gyro:"./assets/weapons/generated-v1/gyro-saw-96.png",
  rift:"./assets/weapons/generated-v1/rift-fork-96.png",
  bloom:"./assets/weapons/generated-v1/aegis-star-96.png",
  needle:"./assets/weapons/generated-v1/needle-array-96.png",
};
const weaponImages={};
const weaponSequences={};
const tintedWeapons=new Map();
const soundBuffers=new Map();
const soundOccurrences=new Map();
const soundLastPlayedAt=new Map();
const soundPlayCounts=Object.fromEntries(weaponSoundCatalog.profiles.map(profile=>[profile.assetId,0]));
let audioReader;
let soundBootPromise;
let soundEnabled=false;
const weaponSequenceSources={
  gyro:Array.from({length:9},(_,index)=>`./assets/weapons/generated-v1/gyro-saw-spin/frame-${index}.png`),
  rift:Array.from({length:9},(_,index)=>`./assets/weapons/generated-v1/rift-fork-fire-grayscale/frame-${index}.png`),
  needle:Array.from({length:9},(_,index)=>`./assets/weapons/generated-v1/needle-array-fire/frame-${index}.png`),
  bloom:Array.from({length:9},(_,index)=>`./assets/weapons/generated-v1/aegis-star-pulse/frame-${index}.png`),
};
const palettes={
  cyan:{body:"#dbe7e8",shadow:"#53676b",trim:"#42d8c8",core:"#caffff",glow:"#55fff0"},
  magenta:{body:"#dfd9e8",shadow:"#675271",trim:"#b843da",core:"#ffd1ff",glow:"#ff61e8"},
  amber:{body:"#e8e0cc",shadow:"#71624b",trim:"#d88f2d",core:"#fff0af",glow:"#ffc34d"},
  acid:{body:"#dce7d8",shadow:"#526550",trim:"#65b93f",core:"#e8ffc7",glow:"#8cff56"},
};
const particlePalettes={
  "character-core":null,
  cyan:{body:"#d7ffff",shadow:"#227f88",trim:"#36dbea",core:"#eaffff",glow:"#40f4ff"},
  magenta:{body:"#ffe0ff",shadow:"#7b2c74",trim:"#df4dcc",core:"#fff0ff",glow:"#ff58e8"},
  amber:{body:"#fff0bd",shadow:"#8a5620",trim:"#e39b32",core:"#fff7d5",glow:"#ffbd42"},
  acid:{body:"#e6ffc5",shadow:"#426b24",trim:"#76c64c",core:"#f4ffdf",glow:"#94ff55"},
  blood:{body:"#ffd0d0",shadow:"#70131c",trim:"#d52b38",core:"#fff1ef",glow:"#ff364b"},
  void:{body:"#e3d3ff",shadow:"#2a144d",trim:"#7044b4",core:"#f6efff",glow:"#a867ff"},
  prism:{body:"#ffffff",shadow:"#315277",trim:"#69e3de",core:"#fff8c8",glow:"#ff71df"},
};
const soundContent={protocol:"oca-content-gateway@1",manifestId:"vault-weapon-sounds-v1",bytes(resourceId){const bytes=soundBytes.get(resourceId);if(!bytes)throw new Error(`Unknown weapon sound resource ${resourceId}`);return bytes.slice()},text(){throw new Error("Weapon sound resources are binary")},json(){throw new Error("Weapon sound resources are binary")},integrity(){return undefined},url(resourceId){return `./audio/${resourceId}`}};
const attackTiming={gyro:{periodMs:1/.00042,triggerPhase:0},rift:{periodMs:1/.00065,triggerPhase:0},bloom:{periodMs:1/.00072,triggerPhase:.32},needle:{periodMs:(1/.0017)/3,triggerPhase:0}};

for(const profile of weaponSoundCatalog.profiles){const label=document.querySelector(`[data-weapon-sound="${profile.assetId}"]`);if(label)label.textContent=`sound · ${profile.id}`}
document.documentElement.dataset.weaponSoundAssignments=weaponSoundCatalog.profiles.map(profile=>`${profile.assetId}:${profile.soundProfileId}:${profile.id}`).join("|");
document.documentElement.dataset.weaponSoundLibrary=`${KEEL_SOUND_BITS_CODEC}:createAudioReader`;
document.documentElement.dataset.weaponSoundReady="false";

async function bootWeaponSounds(){
  if(soundBootPromise)return soundBootPromise;
  soundBootPromise=(async()=>{
    soundButton.disabled=true;soundButton.textContent="Rendering sounds…";soundStatus.textContent="Unlocking the shared sound system…";
    audioReader=createAudioReader({content:soundContent,noiseSeed:`${seedInput.value}:weapon-sounds`,maxSeconds:5});
    await audioReader.unlock();
    for(const resourceId of soundResourceIds){soundBuffers.set(resourceId,audioReader.render({codec:KEEL_SOUND_BITS_CODEC,resourceId}))}
    soundEnabled=true;soundButton.disabled=false;soundButton.textContent="Attack sounds on";soundStatus.textContent="Four Keel-pinned synthesis profiles armed.";
    document.documentElement.dataset.weaponSoundReady="true";document.documentElement.dataset.weaponSoundEnabled="true";document.documentElement.dataset.weaponAudioContext=audioReader.context.state;
  })().catch(error=>{soundBootPromise=undefined;soundEnabled=false;soundButton.disabled=false;soundButton.textContent="Retry attack sounds";soundStatus.textContent=`Sound failed: ${error instanceof Error?error.message:String(error)}`;document.documentElement.dataset.weaponSoundReady="false";throw error});
  return soundBootPromise;
}

function playWeaponAttack(type,occurrence,time){
  if(!soundEnabled||!audioReader)return;
  const selection=resolveSpriteSound(weaponSoundCatalog,type,"attack",seedInput.value.trim()||"vault-loadout-001",occurrence);
  const lastPlayed=soundLastPlayedAt.get(type)??-Infinity;if(time-lastPlayed<selection.event.retriggerMs)return;
  const buffer=soundBuffers.get(selection.sound.resourceId);if(!buffer)return;
  audioReader.playBuffer(buffer,{gain:selection.sound.gain,rate:selection.sound.rate});soundLastPlayedAt.set(type,time);soundPlayCounts[type]+=1;
  document.documentElement.dataset.weaponSoundLast=`${type}:${selection.sound.soundId}`;document.documentElement.dataset.weaponSoundEvents=Object.entries(soundPlayCounts).map(([weapon,count])=>`${weapon}:${count}`).join("|");
}

function scheduleWeaponSounds(time){
  if(!soundEnabled)return;
  for(const [type,timing] of Object.entries(attackTiming)){const occurrence=Math.floor((time-timing.periodMs*timing.triggerPhase)/timing.periodMs),previous=soundOccurrences.get(type);if(previous===undefined){soundOccurrences.set(type,occurrence);continue}if(occurrence>previous){soundOccurrences.set(type,occurrence);playWeaponAttack(type,occurrence,time)}}
}

for(const [type,source] of Object.entries(weaponSources)){
  const image=new Image();
  image.src=source;
  image.addEventListener("load",()=>{weaponImages[type]=image;tintedWeapons.clear()});
}
for(const [type,sources] of Object.entries(weaponSequenceSources)){
  weaponSequences[type]=Array(sources.length);
  sources.forEach((source,index)=>{const image=new Image();image.src=source;image.addEventListener("load",()=>{weaponSequences[type][index]=image;tintedWeapons.clear()})});
}

function rgba(hex,alpha){const value=Number.parseInt(hex.slice(1),16);return `rgba(${(value>>16)&255},${(value>>8)&255},${value&255},${alpha})`}
function hexRgb(hex){const value=Number.parseInt(hex.slice(1),16);return [(value>>16)&255,(value>>8)&255,value&255]}
function mix(a,b,t){return Math.round(a+(b-a)*t)}
function clamp(value,minimum=0,maximum=1){return Math.max(minimum,Math.min(maximum,value))}
function hslRgb(hue,saturation,lightness){const chroma=(1-Math.abs(2*lightness-1))*saturation,sector=((hue%360)+360)%360/60,x=chroma*(1-Math.abs(sector%2-1));let rgb;if(sector<1)rgb=[chroma,x,0];else if(sector<2)rgb=[x,chroma,0];else if(sector<3)rgb=[0,chroma,x];else if(sector<4)rgb=[0,x,chroma];else if(sector<5)rgb=[x,0,chroma];else rgb=[chroma,0,x];const m=lightness-chroma/2;return rgb.map(channel=>Math.round((channel+m)*255))}
function hash32(value){let hash=2166136261;for(const character of value){hash^=character.codePointAt(0);hash=Math.imul(hash,16777619)}return hash>>>0}
function pickOption(options,key){return options[hash32(key)%options.length]}
function rollWeaponBuilds(seed){
  const particleOptions=weaponAttributeCatalog.characterAttributes["particle-color"].options;
  characterBuild["particle-color"]=pickOption(particleOptions,`${seed}:character:particle-color`);
  particleColorSelect.value=characterBuild["particle-color"];
  for(const [type,spec] of Object.entries(weaponAttributeCatalog.weapons)){weaponBuilds[type]=Object.fromEntries(spec.attributes.map(attribute=>[attribute.id,pickOption(attribute.options,`${seed}:${type}:${attribute.id}`)]))}
  tintedWeapons.clear();renderAttributeControls();document.documentElement.dataset.weaponSeed=seed;
}
function optionLabel(attribute,option){
  if(attribute.id==="core-particles")return `${weaponAttributeCatalog.particleStyles[option].label} · matches character`;
  if(attribute.finish){return ({clean:"Clean shell","battle-worn":"Battle-worn","blood-splatter":"Blood splatter","prism-wash":"Prism light wash","void-speckle":"Void speckle"})[option]??option}
  return weaponAttributeCatalog.materials[option]?.label??option;
}
function renderAttributeControls(){
  for(const [type,spec] of Object.entries(weaponAttributeCatalog.weapons)){
    const root=document.querySelector(`[data-weapon-attributes="${type}"]`);if(!root)continue;root.replaceChildren();
    for(const attribute of spec.attributes){const label=document.createElement("label");label.className="attribute";const head=document.createElement("span");head.className="attribute-head";const name=document.createElement("span");name.textContent=attribute.label;const badge=document.createElement("span");badge.className=`attribute-badge ${attribute.mode}`;badge.textContent=attribute.mode==="forced"?"FORCED LINK":attribute.mode.toUpperCase();head.append(name,badge);const select=document.createElement("select");select.dataset.weaponAttribute=`${type}:${attribute.id}`;for(const option of attribute.options){const element=document.createElement("option");element.value=option;element.textContent=optionLabel(attribute,option);element.selected=weaponBuilds[type]?.[attribute.id]===option;select.append(element)}select.addEventListener("change",()=>{weaponBuilds[type][attribute.id]=select.value;tintedWeapons.clear();document.documentElement.dataset.weaponBuilds=buildLedger()});label.append(head,select);root.append(label)}
  }
  document.documentElement.dataset.weaponBuilds=buildLedger();
}
function buildLedger(){return Object.entries(weaponBuilds).map(([type,build])=>`${type}:${Object.values(build).join(",")}`).join("|")}
function buildSignature(type){return Object.values(weaponBuilds[type]??{}).join(".")}
function selectedParticle(type){return weaponBuilds[type]?.["core-particles"]??"orbit-motes"}
function selectedParticlePalette(characterPalette){return particlePalettes[particleColorSelect.value]??characterPalette}
function rounded(context,x,y,width,height,radius){context.beginPath();context.roundRect(x,y,width,height,radius)}
function glow(context,x,y,radius,color,alpha=1){const gradient=context.createRadialGradient(x,y,0,x,y,radius);gradient.addColorStop(0,"rgba(255,255,255,.95)");gradient.addColorStop(.2,rgba(color,.8));gradient.addColorStop(1,rgba(color,0));context.save();context.globalCompositeOperation="lighter";context.globalAlpha=alpha;context.fillStyle=gradient;context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fill();context.restore()}
function orbTetherPoint(x,y,time){return {x:x+27,y:y+Math.sin(time*.004)*2}}
function novaOrbitPoint(time){return {x:120+Math.cos(time*.00055)*72,y:115+Math.sin(time*.00055)*34}}
function drawOrb(context,x,y,time,palette){
  const bob=Math.sin(time*.004)*2;context.save();context.translate(x,y+bob);context.fillStyle="#020605";context.beginPath();context.ellipse(0,22,27,8,0,0,Math.PI*2);context.fill();
  const shell=context.createRadialGradient(-10,-12,2,0,0,34);shell.addColorStop(0,"#ffffff");shell.addColorStop(.35,palette.body);shell.addColorStop(.75,palette.shadow);shell.addColorStop(1,"#121819");context.fillStyle=shell;context.strokeStyle="#020504";context.lineWidth=5;context.beginPath();context.arc(0,0,29,0,Math.PI*2);context.fill();context.stroke();
  context.fillStyle="#020606";rounded(context,19,-8,10,16,3);context.fill();context.fillStyle=palette.core;context.fillRect(22,-5,5,10);glow(context,26,0,14,palette.glow,.55);context.restore();return orbTetherPoint(x,y,time);
}
function drawTether(context,from,to,time,palette,mode){
  if(mode==="none")return;context.save();context.globalCompositeOperation="lighter";
  if(mode==="filaments"){
    for(let index=0;index<2;index+=1){context.strokeStyle=index?palette.glow:palette.trim;context.globalAlpha=.38;context.lineWidth=1.5;context.beginPath();context.moveTo(from.x,from.y+index*3-1.5);context.quadraticCurveTo((from.x+to.x)/2,from.y+Math.sin(time*.005+index)*8,to.x,to.y);context.stroke();}
  }else{
    for(let index=0;index<7;index+=1){const phase=(time*.00035+index/7)%1,x=from.x+(to.x-from.x)*phase,y=from.y+(to.y-from.y)*phase+Math.sin(time*.005+index)*3;context.fillStyle=index%2?palette.glow:palette.core;context.globalAlpha=.25+.65*(1-Math.abs(.5-phase)*2);context.fillRect(Math.round(x),Math.round(y),index%3?2:3,index%3?2:3);}
  }
  context.restore();
}
function weaponBase(context,palette){context.fillStyle=palette.shadow;context.strokeStyle="#020504";context.lineWidth=4;rounded(context,-18,-8,38,16,6);context.fill();context.stroke();context.fillStyle=palette.body;rounded(context,-12,-5,25,10,4);context.fill();context.fillStyle=palette.trim;context.fillRect(-8,-3,11,6)}
function drawGyro(context,x,y,time,palette,scale=1){context.save();context.translate(x,y);context.scale(scale,scale);context.rotate(time*.012);context.strokeStyle="#020504";context.lineWidth=5;context.fillStyle=palette.shadow;context.beginPath();for(let i=0;i<16;i++){const angle=i/16*Math.PI*2,radius=i%2?18:26;context.lineTo(Math.cos(angle)*radius,Math.sin(angle)*radius)}context.closePath();context.fill();context.stroke();context.fillStyle=palette.body;context.beginPath();context.arc(0,0,15,0,Math.PI*2);context.fill();context.fillStyle=palette.trim;context.beginPath();context.arc(0,0,9,0,Math.PI*2);context.fill();context.fillStyle=palette.core;context.beginPath();context.arc(0,0,4,0,Math.PI*2);context.fill();glow(context,0,0,14,palette.glow,.42);context.restore()}
function drawRift(context,x,y,time,palette){context.save();context.translate(x,y);weaponBase(context,palette);context.fillStyle=palette.body;context.strokeStyle="#020504";context.lineWidth=4;for(const offset of [-10,10]){context.beginPath();context.moveTo(8,offset);context.lineTo(36,offset*1.25);context.lineTo(43,offset*.72);context.lineTo(15,offset*.42);context.closePath();context.fill();context.stroke()}context.fillStyle=palette.core;context.fillRect(18,-3,21,6);glow(context,41,0,13,palette.glow,.45+.25*Math.sin(time*.008));context.restore()}
function drawBloom(context,x,y,time,palette){context.save();context.translate(x,y);weaponBase(context,palette);context.translate(22,0);context.rotate(time*.0012);for(let index=0;index<6;index+=1){context.rotate(Math.PI/3);context.fillStyle=index%2?palette.body:palette.trim;context.strokeStyle="#020504";context.lineWidth=3;context.beginPath();context.ellipse(10,0,12,5,0,0,Math.PI*2);context.fill();context.stroke()}context.fillStyle=palette.core;context.beginPath();context.arc(0,0,6,0,Math.PI*2);context.fill();glow(context,0,0,15,palette.glow,.42);context.restore()}
function drawNeedle(context,x,y,time,palette){context.save();context.translate(x,y);weaponBase(context,palette);for(const offset of [-9,0,9]){context.fillStyle=palette.body;context.strokeStyle="#020504";context.lineWidth=3;rounded(context,7,offset-4,37,8,3);context.fill();context.stroke();context.fillStyle=palette.trim;context.fillRect(19,offset-2,18,4);context.fillStyle=palette.core;context.fillRect(39,offset-2,5,4)}glow(context,46,0,12,palette.glow,.35+.16*Math.sin(time*.009));context.restore()}
function weaponRegion(type,x,y,luminance,frame="base"){return resolveWeaponRegion(weaponRegionLayouts,type,x,y,luminance,frame,weaponRegionOverrides)}
function attributeForRegion(type,region){return weaponAttributeCatalog.weapons[type].attributes.find(candidate=>candidate.region===region&&!candidate.finish)}
function materialForRegion(type,region){const attribute=attributeForRegion(type,region),option=weaponBuilds[type]?.[attribute?.id];return weaponAttributeCatalog.materials[option]??weaponAttributeCatalog.materials.gunmetal}
function linkedLightPixel(palette,luminance){const amount=clamp((luminance-48)/207),shadow=hexRgb(palette.trim),light=hexRgb(palette.core);return [0,1,2].map(channel=>mix(shadow[channel],light[channel],amount))}
function materialPixel(material,luminance,x,y){
  const bands=material.bands.map(hexRgb),amount=clamp((luminance-48)/207),position=amount*2,lower=Math.floor(position),upper=Math.min(2,lower+1),mixAmount=position-lower;let color=[0,1,2].map(channel=>mix(bands[lower][channel],bands[upper][channel],mixAmount));
  if(material.effect==="rainbow")color=hslRgb((x*11+y*7)%360,.88,.2+amount*.62);
  else if(material.effect==="aurora")color=hslRgb(165+65*Math.sin(x*.22+y*.11),.78,.18+amount*.64);
  else if(material.effect==="void"&&((x*17+y*29)%31<3))color=[190,128,255];
  else if(material.effect==="acid"&&((x*13+y*19)%23<4))color=[190,255,91];
  else if(material.effect==="blood"&&((x*7+y*23)%29<7))color=[mix(color[0],255,.32),mix(color[1],16,.5),mix(color[2],24,.45)];
  return color;
}
function applyShellFinish(color,finish,x,y,luminance){const grain=((x*73856093)^(y*19349663))>>>0;if(finish==="battle-worn"&&grain%17<3)return color.map(value=>Math.round(value*.54));if(finish==="blood-splatter"&&grain%31<5)return [mix(color[0],166,.66),mix(color[1],8,.76),mix(color[2],18,.72)];if(finish==="prism-wash")return [0,1,2].map(channel=>mix(color[channel],hslRgb((x*13+y*9)%360,.82,.62)[channel],.3));if(finish==="void-speckle"&&grain%23<4)return luminance>150?[132,78,190]:[10,4,20];return color}
function targetGeneratedWeapon(type,paletteName,image=weaponImages[type],frameIndex="base"){
  const key=`${type}:${paletteName}:${frameIndex}:${buildSignature(type)}`;
  if(tintedWeapons.has(key))return tintedWeapons.get(key);
  if(!image)return null;
  const surface=document.createElement("canvas");surface.width=96;surface.height=96;
  const context=surface.getContext("2d",{willReadFrequently:true});context.imageSmoothingEnabled=false;context.drawImage(image,0,0,96,96);const palette=palettes[paletteName];
  const pixels=context.getImageData(0,0,96,96),data=pixels.data;
  for(let index=0;index<data.length;index+=4){
    if(data[index+3]===0)continue;
    const luminance=(data[index]*.2126)+(data[index+1]*.7152)+(data[index+2]*.0722);
    if(luminance<48)continue;
    const pixel=index/4,x=pixel%96,y=Math.floor(pixel/96),region=weaponRegion(type,x,y,luminance,frameIndex);if(region==="fixed"){data[index]=0;data[index+1]=0;data[index+2]=0;continue}const attribute=attributeForRegion(type,region);let target=attribute?.link==="character.core-light"?linkedLightPixel(palette,luminance):materialPixel(materialForRegion(type,region),luminance,x,y);
    if(type==="bloom"&&region==="shell")target=applyShellFinish(target,weaponBuilds.bloom?.["shell-finish"],x,y,luminance);
    data[index]=mix(data[index],target[0],.9);data[index+1]=mix(data[index+1],target[1],.9);data[index+2]=mix(data[index+2],target[2],.9);
  }
  context.putImageData(pixels,0,0);tintedWeapons.set(key,surface);return surface;
}
function generatedCore(type,x,y){
  if(type==="gyro"||type==="bloom")return {x,y};
  if(type==="rift")return {x:x-22,y};
  return {x:x-23,y};
}
function drawWeaponParticles(context,x,y,time,palette,style){
  context.save();context.globalCompositeOperation="lighter";
  if(style==="energy-filaments"){for(let index=0;index<3;index+=1){context.strokeStyle=index%2?rgba(palette.core,.45):rgba(palette.glow,.38);context.lineWidth=1.2;context.beginPath();context.arc(x,y,8+index*3,time*.002+index,time*.002+index+1.6);context.stroke()}}
  else if(style==="ember-shards"){for(let index=0;index<5;index+=1){const angle=time*.0025+index*Math.PI*.4,radius=8+((time*.018+index*5)%11),px=x+Math.cos(angle)*radius,py=y+Math.sin(angle)*radius;context.fillStyle=index%2?palette.core:palette.glow;context.globalAlpha=.35+index*.1;context.save();context.translate(px,py);context.rotate(angle);context.fillRect(-2,-1,4,2);context.restore()}}
  else if(style==="pulse-rings"){for(let index=0;index<2;index+=1){const phase=(time*.0012+index*.5)%1;context.strokeStyle=rgba(palette.glow,(1-phase)*.45);context.lineWidth=1.5;context.beginPath();context.arc(x,y,5+phase*17,0,Math.PI*2);context.stroke()}}
  else{for(let index=0;index<4;index+=1){const angle=time*.002+index*Math.PI*.5,px=x+Math.cos(angle)*11,py=y+Math.sin(angle)*7;context.fillStyle=index%2?palette.core:palette.glow;context.globalAlpha=.55;context.fillRect(Math.round(px)-1,Math.round(py)-1,3,3)}}
  context.restore();
}
function drawNovaCharge(context,x,y,time,palette){
  const cycle=(time*.00072)%1,charge=cycle<.32?cycle/.32:Math.max(0,1-(cycle-.32)/.18);
  const rotation=time*.0015,radius=35;
  context.save();context.globalCompositeOperation="lighter";context.strokeStyle=rgba(palette.glow,.12+.2*charge);context.lineWidth=1.5;context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.stroke();
  for(let index=0;index<6;index+=1){
    const angle=index*Math.PI/3+rotation,nodeX=x+Math.cos(angle)*radius,nodeY=y+Math.sin(angle)*radius;
    context.fillStyle=palette.core;context.globalAlpha=.68+.32*charge;context.beginPath();context.arc(nodeX,nodeY,3+charge*1.4,0,Math.PI*2);context.fill();
    glow(context,nodeX,nodeY,7+charge*6,palette.glow,.24+.58*charge);
  }
  glow(context,x,y,10+charge*13,palette.glow,.32+.66*charge);context.restore();
}
function drawGeneratedWeapon(context,type,x,y,time,palette,paletteName){
  const sequence=weaponSequences[type];let frameIndex=0;
  frameIndex=Math.floor(time/(type==="needle"?82:96))%9;
  const frame=sequence?.[frameIndex],sprite=targetGeneratedWeapon(type,paletteName,frame||weaponImages[type],frame?frameIndex:"base");if(!sprite)return false;
  context.save();context.translate(x,y);
  if(type==="gyro"&&!frame)context.rotate(time*.012);
  else if(type==="rift"&&!frame)context.translate(-Math.max(0,Math.sin(time*.004))*1.5,0);
  else if(type==="needle"&&!frame)context.translate(-Math.max(0,Math.sin(time*.010))*2,0);
  context.drawImage(sprite,-48,-48,96,96);context.restore();
  const core=generatedCore(type,x,y);glow(context,core.x,core.y,type==="gyro"?10:8,palette.glow,.28+.12*Math.sin(time*.006));
  if(type==="bloom")drawNovaCharge(context,x,y,time,palette);
  return true;
}
function drawShots(context,type,time,palette,weaponPoint){
  context.save();context.globalCompositeOperation="lighter";
  if(type==="gyro"){
    const phase=(time*.00042)%1,outbound=phase<.58?phase/.58:1-(phase-.58)/.42,x=222+outbound*205,y=115+Math.sin(phase*Math.PI*2)*14;drawGyro(context,x,y,time,palette,.58);context.strokeStyle=rgba(palette.glow,.35);context.lineWidth=2;context.beginPath();context.moveTo(205,115);context.quadraticCurveTo(320,82,x,y);context.stroke();
  }else if(type==="rift"){
    const phase=(time*.00065)%1,x=225+phase*255;context.strokeStyle=rgba(palette.glow,.22*(1-phase));context.lineWidth=8;context.beginPath();context.moveTo(218,115);context.lineTo(x,115);context.stroke();context.fillStyle=palette.core;context.fillRect(x-16,112,24,6);glow(context,x,115,15,palette.glow,.55*(1-phase));
  }else if(type==="bloom"){
    const rate=.00072,period=1/rate,phase=(time*rate)%1,flight=Math.max(0,(phase-.32)/.68),distance=flight*112,launchTime=time-phase*period+.32*period,launchPoint=novaOrbitPoint(launchTime),centerX=launchPoint.x,centerY=launchPoint.y,launchRotation=launchTime*.0015;
    for(let index=0;index<6;index+=1){const angle=index*Math.PI/3+launchRotation,originX=centerX+Math.cos(angle)*35,originY=centerY+Math.sin(angle)*35,x=originX+Math.cos(angle)*distance,y=originY+Math.sin(angle)*distance;context.globalAlpha=flight===0?0:1-flight*.72;context.fillStyle=index%2?palette.core:palette.glow;context.beginPath();context.arc(x,y,4,0,Math.PI*2);context.fill();glow(context,x,y,10,palette.glow,.35*(1-flight));context.strokeStyle=rgba(palette.glow,.28*(1-flight));context.lineWidth=2;context.beginPath();context.moveTo(originX,originY);context.lineTo(x-Math.cos(angle)*7,y-Math.sin(angle)*7);context.stroke()}
  }else{
    for(let index=0;index<3;index+=1){const phase=(time*.0017+index/3)%1,x=225+phase*260,y=106+index*9;context.globalAlpha=1-phase*.72;context.fillStyle=palette.core;context.beginPath();context.moveTo(x+11,y);context.lineTo(x-7,y-3);context.lineTo(x-7,y+3);context.closePath();context.fill();context.strokeStyle=rgba(palette.glow,.45);context.beginPath();context.moveTo(x-22,y);context.lineTo(x-4,y);context.stroke()}
  }
  context.restore();
}
function drawWeapon(context,type,x,y,time,palette,paletteName){if(drawGeneratedWeapon(context,type,x,y,time,palette,paletteName))return;if(type==="gyro")drawGyro(context,x+18,y,time,palette,.75);else if(type==="rift")drawRift(context,x,y,time,palette);else if(type==="bloom")drawBloom(context,x,y,time,palette);else drawNeedle(context,x,y,time,palette)}
function frame(time){
  const paletteName=paletteSelect.value,palette=palettes[paletteName],particlePalette=selectedParticlePalette(palette);
  for(const canvas of canvases){const context=canvas.getContext("2d");context.imageSmoothingEnabled=false;context.clearRect(0,0,canvas.width,canvas.height);const type=canvas.dataset.weapon,particle=selectedParticle(type),tether=weaponAttributeCatalog.particleStyles[particle].tether,orbX=type==="bloom"?120:68,orbY=115,weaponPoint=type==="bloom"?novaOrbitPoint(time):{x:164,y:115},orbPoint=orbTetherPoint(orbX,orbY,time);drawTether(context,orbPoint,weaponPoint,time,particlePalette,tether);if(type==="bloom"&&weaponPoint.y<orbY){drawWeapon(context,type,weaponPoint.x,weaponPoint.y,time,palette,paletteName);drawOrb(context,orbX,orbY,time,palette)}else{drawOrb(context,orbX,orbY,time,palette);drawWeapon(context,type,weaponPoint.x,weaponPoint.y,time,palette,paletteName)}const core=generatedCore(type,weaponPoint.x,weaponPoint.y);drawWeaponParticles(context,core.x,core.y,time,particlePalette,particle);drawShots(context,type,time,palette,weaponPoint);context.fillStyle="#9db5af";context.font="12px ui-monospace,monospace";context.fillText(type==="gyro"?"SPIN / LAUNCH / RECALL":type==="rift"?"CHARGE / PIERCE":type==="bloom"?"ORBIT / CHARGE / SIX-NODE BURST":"STAGGERED RAPID DARTS",18,28)}
  document.documentElement.dataset.weaponRangeReady="true";document.documentElement.dataset.weaponPalette=paletteSelect.value;document.documentElement.dataset.weaponTether="per-weapon-attribute";
  document.documentElement.dataset.generatedWeapons=String(Object.keys(weaponImages).length);
  document.documentElement.dataset.weaponSequences=String(Object.values(weaponSequences).reduce((total,sequence)=>total+sequence.filter(Boolean).length,0));
  document.documentElement.dataset.weaponAttributeCount=String(Object.values(weaponAttributeCatalog.weapons).reduce((total,weapon)=>total+weapon.attributes.length,0));
  document.documentElement.dataset.particleColor=characterBuild["particle-color"];
  scheduleWeaponSounds(time);
  requestAnimationFrame(frame);
}
rollButton.addEventListener("click",()=>rollWeaponBuilds(seedInput.value.trim()||"vault-loadout-001"));
seedInput.addEventListener("keydown",event=>{if(event.key==="Enter")rollButton.click()});
paletteSelect.addEventListener("change",()=>{document.documentElement.dataset.weaponLightLink=paletteSelect.value});
particleColorSelect.addEventListener("change",()=>{characterBuild["particle-color"]=particleColorSelect.value;document.documentElement.dataset.particleColor=particleColorSelect.value});
soundButton.addEventListener("click",()=>{if(!audioReader){void bootWeaponSounds().catch(()=>undefined);return}soundEnabled=!soundEnabled;if(!soundEnabled)audioReader.stopAll();soundButton.textContent=soundEnabled?"Attack sounds on":"Attack sounds off";soundStatus.textContent=soundEnabled?"Weapon attacks are driving their assigned sound profiles.":"Attack sounds paused.";document.documentElement.dataset.weaponSoundEnabled=String(soundEnabled);document.documentElement.dataset.weaponAudioContext=audioReader.context.state});
window.addEventListener("storage",event=>{if(event.key!==WEAPON_REGION_OVERRIDE_STORAGE_KEY)return;weaponRegionOverrides=loadWeaponRegionOverrides(defaultWeaponRegionOverrides);tintedWeapons.clear();document.documentElement.dataset.weaponRegionOverrides="reloaded"});
rollWeaponBuilds(seedInput.value);
requestAnimationFrame(frame);
