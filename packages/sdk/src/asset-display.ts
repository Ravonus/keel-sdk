/** Browser-safe declarations and bytes for KEEL's reusable normal-media module. */
export const KEEL_ASSET_DISPLAY_MODULE_ID = "keel.asset-display" as const;
export const KEEL_ASSET_DISPLAY_MODULE_VERSION = "1.0.0" as const;

export const KEEL_ASSET_DISPLAY_MEDIA_TYPES = Object.freeze([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "model/gltf-binary",
] as const);

export type KeelAssetDisplayMediaType = (typeof KEEL_ASSET_DISPLAY_MEDIA_TYPES)[number];
export type KeelAssetDisplayKind = "image" | "video" | "model";

/** Map a supported direct creator asset to the canonical display behavior. */
export function keelAssetDisplayKind(mediaType: string): KeelAssetDisplayKind {
  if ((KEEL_ASSET_DISPLAY_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    if (mediaType.startsWith("image/")) return "image";
    if (mediaType.startsWith("video/")) return "video";
    return "model";
  }
  throw new TypeError(`The canonical KEEL asset-display module does not support ${mediaType}.`);
}

/**
 * This browser-only, no-network module is published once per chain. The
 * protected shell injects a frozen descriptor for the verified direct media
 * entrypoint; this module is not creator-authored HTML and never has wallet
 * authority. Its GLB path accepts self-contained binary glTF only.
 */
const KEEL_ASSET_DISPLAY_MODULE_SOURCE = `"use strict";(()=>{
const fail=m=>{throw new Error("KEEL asset display: "+m)},entry=globalThis.__KEEL_ENTRY__,content=globalThis.__KEEL_CONTENT__,root=document.getElementById("keel-asset-display")||document.body;
if(!entry||typeof entry.id!=="string"||typeof entry.mediaType!=="string"||typeof entry.url!=="string"||!content||typeof content.bytes!=="function")fail("missing verified entry descriptor");
const style=e=>{Object.assign(e.style,{display:"block",width:"100%",height:"100%",maxWidth:"100%",maxHeight:"100%",objectFit:"contain",background:"#05060b"});return e},mount=e=>{root.replaceChildren(e);return e};
if(entry.mediaType.startsWith("image/")){const e=style(document.createElement("img"));e.src=entry.url;e.alt=entry.name||"Verified KEEL image";mount(e);return}
if(entry.mediaType.startsWith("video/")){const e=style(document.createElement("video"));e.src=entry.url;e.controls=true;e.autoplay=true;e.loop=true;e.muted=true;e.playsInline=true;mount(e);return}
if(entry.mediaType!=="model/gltf-binary")fail("unsupported media type "+entry.mediaType);
const b=content.bytes(entry.id),v=new DataView(b.buffer,b.byteOffset,b.byteLength);if(b.byteLength<20||v.getUint32(0,true)!==0x46546c67||v.getUint32(4,true)!==2||v.getUint32(8,true)!==b.byteLength)fail("invalid GLB header");
let o=12,j=null,bin=null;while(o+8<=b.byteLength){const n=v.getUint32(o,true),t=v.getUint32(o+4,true),e=o+8+n;if(e>b.byteLength)fail("truncated GLB chunk");if(t===0x4e4f534a)j=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(b.subarray(o+8,e)));if(t===0x004e4942)bin=b.subarray(o+8,e);o=e}if(!j||!bin)fail("GLB needs JSON and binary chunks");
const p=j.meshes&&j.meshes[0]&&j.meshes[0].primitives&&j.meshes[0].primitives[0],a=p&&j.accessors&&j.accessors[p.attributes&&p.attributes.POSITION],q=a&&j.bufferViews&&j.bufferViews[a.bufferView];if(!p||!a||!q||a.componentType!==5126||a.type!=="VEC3"||!Number.isSafeInteger(a.count)||a.count<3||q.byteStride&&q.byteStride!==12)fail("unsupported GLB position accessor");
const po=(q.byteOffset||0)+(a.byteOffset||0),pl=a.count*12;if(po<0||po+pl>bin.byteLength||po%4)fail("invalid GLB position range");const positions=new Float32Array(bin.buffer,bin.byteOffset+po,a.count*3);let mn=Array.isArray(a.min)&&a.min.length===3?a.min.slice():[Infinity,Infinity,Infinity],mx=Array.isArray(a.max)&&a.max.length===3?a.max.slice():[-Infinity,-Infinity,-Infinity];if(!mn.every(Number.isFinite)||!mx.every(Number.isFinite)){mn=[Infinity,Infinity,Infinity];mx=[-Infinity,-Infinity,-Infinity];for(let i=0;i<positions.length;i++)mn[i%3]=Math.min(mn[i%3],positions[i]),mx[i%3]=Math.max(mx[i%3],positions[i])}const center=mn.map((n,i)=>(n+mx[i])/2),scale=2/Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2],1e-6);
let indices=null,indexType=0,indexCount=0;if(p.indices!==undefined){const ia=j.accessors&&j.accessors[p.indices],iq=ia&&j.bufferViews&&j.bufferViews[ia.bufferView],size=ia&&({5121:1,5123:2,5125:4})[ia.componentType];if(!ia||!iq||ia.type!=="SCALAR"||!size||!Number.isSafeInteger(ia.count))fail("unsupported GLB index accessor");const io=(iq.byteOffset||0)+(ia.byteOffset||0),il=ia.count*size;if(io<0||io+il>bin.byteLength||io%size)fail("invalid GLB index range");indices=bin.subarray(io,io+il);indexType=ia.componentType===5121?5121:ia.componentType===5123?5123:5125;indexCount=ia.count}
const c=style(document.createElement("canvas")),gl=c.getContext("webgl",{antialias:true,alpha:false});if(!gl)fail("WebGL is unavailable");mount(c);const shader=(type,source)=>{const s=gl.createShader(type);if(!s)fail("shader allocation failed");gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))fail(gl.getShaderInfoLog(s)||"shader compile failed");return s},program=gl.createProgram();if(!program)fail("program allocation failed");gl.attachShader(program,shader(gl.VERTEX_SHADER,"attribute vec3 p;uniform float t,s;uniform vec3 c;varying float z;void main(){vec3 q=(p-c)*s;float x=cos(t)*q.x-sin(t)*q.z,y=q.y,zr=sin(t)*q.x+cos(t)*q.z;z=zr;gl_Position=vec4(x/(3.0+zr),y/(3.0+zr),zr*.01,1.0);}"));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,"precision mediump float;varying float z;void main(){gl_FragColor=vec4(.18+.12*z,.85-.08*z,.72,1.);}"));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))fail(gl.getProgramInfoLog(program)||"program link failed");const buffer=gl.createBuffer();if(!buffer)fail("buffer allocation failed");gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,positions,gl.STATIC_DRAW);let ib=null;if(indices){ib=gl.createBuffer();if(!ib)fail("index buffer allocation failed");gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW)}const position=gl.getAttribLocation(program,"p"),time=gl.getUniformLocation(program,"t"),origin=gl.getUniformLocation(program,"c"),size=gl.getUniformLocation(program,"s");if(position<0||!time||!origin||!size)fail("shader bindings missing");
const draw=ms=>{const d=Math.max(1,devicePixelRatio||1),w=Math.max(1,c.clientWidth*d),h=Math.max(1,c.clientHeight*d);if(c.width!==w||c.height!==h){c.width=w;c.height=h}gl.viewport(0,0,w,h);gl.clearColor(.02,.024,.043,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);gl.uniform1f(time,ms/1800);gl.uniform3fv(origin,center);gl.uniform1f(size,scale);if(ib)gl.drawElements(gl.TRIANGLES,indexCount,indexType,0);else gl.drawArrays(gl.TRIANGLES,0,a.count);requestAnimationFrame(draw)};draw(0);
})();`;

/** Exact decoded bytes Studio verifies before using or publishing this module. */
export function keelAssetDisplayModuleBytes(): Uint8Array {
  return new TextEncoder().encode(KEEL_ASSET_DISPLAY_MODULE_SOURCE);
}
