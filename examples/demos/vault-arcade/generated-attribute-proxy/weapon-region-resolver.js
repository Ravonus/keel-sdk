export function weaponRegionMatches(match,x,y,luminance){
  if(match.shape==="ellipse")return ((x-match.cx)/match.rx)**2+((y-match.cy)/match.ry)**2<=1;
  if(match.shape==="rect")return x>=match.x0&&x<match.x1&&y>=match.y0&&y<match.y1;
  if(match.shape==="x-before")return x<match.x;
  if(match.shape==="luma-below")return luminance<match.value;
  return match.shape==="fallback";
}

export const WEAPON_REGION_OVERRIDE_SCHEMA="vault-weapon-region-overrides@1";
export const WEAPON_REGION_OVERRIDE_STORAGE_KEY="vault-weapon-region-overrides@1:authored-defaults-v1";
const compactOverrideFrames=new WeakMap();

export function emptyWeaponRegionOverrides(){return {schema:WEAPON_REGION_OVERRIDE_SCHEMA,size:[96,96],overrides:{}}}

export function cloneWeaponRegionOverrides(value){
  if(value?.schema!==WEAPON_REGION_OVERRIDE_SCHEMA)return emptyWeaponRegionOverrides();
  return JSON.parse(JSON.stringify(value));
}

export function loadWeaponRegionOverrides(defaults=emptyWeaponRegionOverrides(),storage=globalThis.localStorage){
  try{const parsed=JSON.parse(storage?.getItem(WEAPON_REGION_OVERRIDE_STORAGE_KEY)??"null");return parsed?.schema===WEAPON_REGION_OVERRIDE_SCHEMA?parsed:cloneWeaponRegionOverrides(defaults)}catch{return cloneWeaponRegionOverrides(defaults)}
}

export function saveWeaponRegionOverrides(value,storage=globalThis.localStorage){
  if(value?.schema!==WEAPON_REGION_OVERRIDE_SCHEMA)throw new Error("weapon region override schema is not supported");
  storage?.setItem(WEAPON_REGION_OVERRIDE_STORAGE_KEY,JSON.stringify(value));
}

function compactOverrideRegion(document,type,frame,pixel){
  if(document?.schema!=="vault-weapon-region-overrides@2")return undefined;
  let documentCache=compactOverrideFrames.get(document);
  if(!documentCache){documentCache=new Map();compactOverrideFrames.set(document,documentCache)}
  const key=`${type}:${frame}`;
  let decoded=documentCache.get(key);
  if(!decoded){
    decoded=new Uint8Array(document.size[0]*document.size[1]);
    const encoded=document.overrides?.[type]?.[String(frame)];
    if(typeof encoded==="string"){
      const raw=atob(encoded);let cursor=0,index=0;
      while(cursor<raw.length){let delta=0,shift=0,value;do{value=raw.charCodeAt(cursor++);delta|=(value&127)<<shift;shift+=7}while(value&128);index+=delta;decoded[index]=raw.charCodeAt(cursor++)}
    }
    documentCache.set(key,decoded);
  }
  const regionIndex=decoded[pixel];
  return regionIndex===0?undefined:document.regions[regionIndex-1];
}

export function resolveWeaponRegion(layouts,type,x,y,luminance,frame="base",overrideDocument=null){
  const pixel=y*96+x;
  const override=overrideDocument?.schema==="vault-weapon-region-overrides@2"
    ?compactOverrideRegion(overrideDocument,type,frame,pixel)
    :overrideDocument?.overrides?.[type]?.[String(frame)]?.[String(pixel)];
  if(typeof override==="string")return override;
  return layouts.weapons[type]?.regions.find(region=>weaponRegionMatches(region.match,x,y,luminance))?.id??"unassigned";
}
