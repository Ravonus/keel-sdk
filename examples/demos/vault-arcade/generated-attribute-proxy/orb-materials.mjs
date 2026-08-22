export const ORB_METAL_PALETTES = Object.freeze({
  gunmetal:["#111317","#343a42","#747e89","#b9c2ca","#f7fbff"],
  gold:["#241305","#6c3d0d","#b97916","#efbd45","#fff1a8"],
  copper:["#24100c","#6f2d1f","#ad5635","#df9168","#ffd6b6"],
  chrome:["#0b1118","#30404c","#758896","#d6e2e8","#ffffff"],
  obsidian:["#030207","#160d24","#38224e","#815f9c","#d6c3ef"],
  pearl:["#28222c","#655b6b","#a69caa","#ddd6df","#fffaff"],
});

export const ORB_VISOR_PALETTES = Object.freeze({
  glass:["#020609","#081820","#183847","#5594aa","#d9f8ff"],
  ruby:["#170308","#57101d","#a7243b","#ed6680","#ffd6df"],
  sapphire:["#02091b","#0d2f71","#1764c0","#69b7ff","#e2f5ff"],
  brass:["#1d1003","#633809","#a96d17","#dfb64b","#fff0a3"],
  ceramic:["#18171b","#52515a","#9898a3","#dedee4","#ffffff"],
  prism:["#140829","#432878","#7d6be8","#7aebff","#ffffff"],
});

export const ORB_PORT_LIGHTS = Object.freeze({
  utility:{edge:"#526864",core:"#e8fff8",glow:"#9fb8af",intensity:.28},
  dormant:{edge:null,core:null,glow:null,intensity:0},
  "linked-light":{linkedLight:true,intensity:.42},
  titanium:{edge:"#60757d",core:"#f4ffff",glow:"#d5e8ed",intensity:.3},
  reactor:{edge:"#68100d",core:"#ff9b8f",glow:"#ff493d",intensity:.4},
  ion:{edge:"#075766",core:"#caffff",glow:"#51dceb",intensity:.38},
  hazard:{edge:"#76500a",core:"#fff0a4",glow:"#ffc348",intensity:.34},
  void:{edge:"#462070",core:"#ead6ff",glow:"#a86dff",intensity:.36},
});

export const ORB_LIGHT_STYLES = Object.freeze({
  cyan:{edge:"#087a9d",core:"#c9ffff",glow:"#63fff2"},
  amber:{edge:"#a04b06",core:"#fff1a1",glow:"#ffd369"},
  magenta:{edge:"#781266",core:"#ffd2f7",glow:"#ff6be7"},
  white:{edge:"#7c8b9a",core:"#ffffff",glow:"#ffffff"},
  plasma:{edge:"#711fff",core:"#71fff5",glow:"#a171ff"},
  aurora:{edge:"#2365d8",core:"#8dffc6",glow:"#64f4cf"},
  eclipse:{edge:"#24000b",core:"#ff4c37",glow:"#ff3b65"},
  starfire:{edge:"#e1580b",core:"#fffbd0",glow:"#ffbd4a"},
});

export const ORB_SKIN_STYLES = Object.freeze({
  metal:{mode:"base",strength:0},
  brushed:{mode:"brushed",strength:.22},
  "battle-worn":{mode:"worn",strength:.34},
  polished:{mode:"sheen",strength:.3},
  oxidized:{mode:"oxidized",strength:.34},
  "prism-light":{mode:"prism-light",strength:.24},
});

function hexRgb(value){
  const number=Number.parseInt(value.slice(1),16);
  return [(number>>16)&255,(number>>8)&255,number&255];
}

function mix(a,b,t){ return Math.round(a+(b-a)*t); }

function smoothstep(edge0,edge1,value){ const t=Math.max(0,Math.min(1,(value-edge0)/(edge1-edge0))); return t*t*(3-2*t); }

export function paintOrbMaterialAtlas({ sourcePixels, maskPixels, panelPixels, skinPixels, skinStyle=ORB_SKIN_STYLES.metal, targetContext, shellPalette, visorPalette, lightStyle, portLightStyle, paintStrength=.82 }){
  if(!Array.isArray(shellPalette)||shellPalette.length!==5||!Array.isArray(visorPalette)||visorPalette.length!==5) throw new Error("Orb material palettes require exactly five colors");
  if(sourcePixels.width!==maskPixels.width||sourcePixels.height!==maskPixels.height) throw new Error("Orb source and mask dimensions differ");
  const shellColors=shellPalette.map(hexRgb); const visorColors=visorPalette.map(hexRgb); const lightEdge=hexRgb(lightStyle.edge); const lightCore=hexRgb(lightStyle.core); const portEdge=portLightStyle?.edge?hexRgb(portLightStyle.edge):null; const portCore=portLightStyle?.core?hexRgb(portLightStyle.core):null; const output=new ImageData(maskPixels.width,maskPixels.height);
  const isLight=(x,y)=>{if(x<0||x>=panelPixels.width||y<0||y>=panelPixels.height)return false;const index=(y*panelPixels.width+x)*4;return panelPixels.data[index]>130&&panelPixels.data[index]<230&&panelPixels.data[index+1]<160&&panelPixels.data[index+2]>180};
  const isPort=(x,y)=>{if(x<0||x>=panelPixels.width||y<0||y>=panelPixels.height)return false;const index=(y*panelPixels.width+x)*4;return panelPixels.data[index]>180&&panelPixels.data[index+1]>150&&panelPixels.data[index+2]<120};
  const lightFields=Array.from({length:8},(_,frame)=>{
    const points=[];
    for(let y=0;y<34;y++)for(let localX=0;localX<34;localX++){const x=frame*34+localX;if(isLight(x,y))points.push([x,y]);}
    if(!points.length)return null;
    const centerY=points.reduce((sum,[,y])=>sum+y,0)/points.length,distances=points.map(([,y])=>Math.abs(y-centerY));
    return {centerY,minimum:Math.min(...distances),maximum:Math.max(...distances)};
  });
  const isPortEdge=(frame,x,y)=>{
    if(frame===2)return !isPort(x+1,y);
    if(frame===6)return !isPort(x-1,y);
    return false;
  };
  const portFields=Array.from({length:8},(_,frame)=>{
    const points=[];
    for(let y=0;y<34;y++)for(let localX=0;localX<34;localX++){const x=frame*34+localX;if(isPort(x,y)&&!isPortEdge(frame,x,y))points.push([x,y]);}
    if(!points.length)return null;
    const centerX=points.reduce((sum,[x])=>sum+x,0)/points.length,centerY=points.reduce((sum,[,y])=>sum+y,0)/points.length;
    const distances=points.map(([x,y])=>Math.hypot(x-centerX,y-centerY)),minimum=Math.min(...distances),maximum=Math.max(...distances);
    return {centerX,centerY,minimum,maximum};
  });
  for(let offset=0;offset<maskPixels.data.length;offset+=4){
    const pixel=offset/4,x=pixel%maskPixels.width,y=Math.floor(pixel/maskPixels.width); const port=isPort(x,y); const alpha=maskPixels.data[offset+3]; if(alpha===0) continue;
    for(let channel=0;channel<3;channel+=1) output.data[offset+channel]=sourcePixels.data[offset+channel];
    output.data[offset+3]=alpha;
    if(panelPixels&&panelPixels.data[offset+3]===0) continue;
    const light=isLight(x,y);
    if(port){
      if(!portCore){output.data[offset]=2;output.data[offset+1]=5;output.data[offset+2]=6;continue}
      const frame=Math.floor(x/34);
      if(isPortEdge(frame,x,y)){output.data[offset]=2;output.data[offset+1]=5;output.data[offset+2]=6;continue}
      const field=portFields[frame],distance=Math.hypot(x-field.centerX,y-field.centerY);
      const centerWeight=field.maximum===field.minimum?1:1-(distance-field.minimum)/(field.maximum-field.minimum);
      const minimumAmount=.08+(portLightStyle.intensity??.3)*.2,maximumAmount=.18+(portLightStyle.intensity??.3)*.6;
      const amount=minimumAmount+(maximumAmount-minimumAmount)*centerWeight,edge=portEdge??portCore;
      for(let channel=0;channel<3;channel+=1)output.data[offset+channel]=mix(edge[channel],portCore[channel],amount);
      continue;
    }
    if(light){
      const frame=Math.floor(x/34);
      if(frame===2||frame===6){
        const field=lightFields[frame],distance=Math.abs(y-field.centerY),centerWeight=field.maximum===field.minimum?1:1-(distance-field.minimum)/(field.maximum-field.minimum);
        const amount=.18+.82*centerWeight;
        for(let channel=0;channel<3;channel+=1)output.data[offset+channel]=mix(lightEdge[channel],lightCore[channel],amount);
        continue;
      }
      let distance=1;
      const contains=isLight;
      for(;distance<=6;distance+=1){let edge=false;for(let oy=-distance;oy<=distance&&!edge;oy+=1)for(let ox=-distance;ox<=distance;ox+=1)if(Math.abs(ox)===distance||Math.abs(oy)===distance){if(!contains(x+ox,y+oy)){edge=true;break}}if(edge)break}
      const amount=Math.max(0,Math.min(1,(distance-1)/4));
      for(let channel=0;channel<3;channel+=1)output.data[offset+channel]=mix(lightEdge[channel],lightCore[channel],amount);
      continue;
    }
    const visor=panelPixels&&panelPixels.data[offset]<120&&panelPixels.data[offset+1]>150&&panelPixels.data[offset+2]>180;
    const colors=visor?visorColors:shellColors;
    const luminance=maskPixels.data[offset+3]?maskPixels.data[offset]/255:.55; const position=luminance*4; const lower=Math.floor(position); const upper=Math.min(4,lower+1); const t=position-lower;
    const paint=[mix(colors[lower][0],colors[upper][0],t),mix(colors[lower][1],colors[upper][1],t),mix(colors[lower][2],colors[upper][2],t)];
    const shade=(port?.5:.2)+(port?.5:.8)*luminance; const specular=smoothstep(.72,1,luminance);
    for(let channel=0;channel<3;channel+=1){
      const painted=mix(paint[channel]*shade,255,specular*.78);
      output.data[offset+channel]=mix(sourcePixels.data[offset+channel],painted,paintStrength);
    }
  }
  if(skinPixels&&skinStyle.strength>0){
    for(let offset=0;offset<skinPixels.data.length;offset+=4){
      if(skinPixels.data[offset+3]===0||output.data[offset+3]===0)continue;
      const pixel=offset/4,x=pixel%output.width,y=Math.floor(pixel/output.width); const luminance=maskPixels.data[offset]/255;
      const grain=(((x*73856093)^(y*19349663))>>>0)%997/996; let target=[output.data[offset],output.data[offset+1],output.data[offset+2]],amount=skinStyle.strength;
      if(skinStyle.mode==="brushed"){
        const band=.5+.5*Math.sin(y*2.4+x*.24); target=band>.56?[235,242,244]:[34,40,44]; amount*=.28+.44*band;
      }else if(skinStyle.mode==="worn"){
        const scratch=((x*3+y*7)%19<2)||grain>.91; target=scratch?[225,228,220]:[21,24,25]; amount*=scratch?.95:.18;
      }else if(skinStyle.mode==="sheen"){
        const sheen=Math.max(0,Math.sin((x+y)*.46))*smoothstep(.18,.9,luminance); target=[255,255,255]; amount*=.2+.8*sheen;
      }else if(skinStyle.mode==="oxidized"){
        const oxide=smoothstep(.48,.93,grain); target=grain>.78?[173,73,24]:[62,48,37]; amount*=.16+.84*oxide;
      }else if(skinStyle.mode==="prism-light"){
        const prism=[[255,73,205],[122,92,255],[62,226,255],[100,255,171],[255,231,103]];const position=((x*.13+y*.19)%prism.length+prism.length)%prism.length;const lower=Math.floor(position),upper=(lower+1)%prism.length,t=position-lower;target=[0,1,2].map(channel=>mix(prism[lower][channel],prism[upper][channel],t));amount*=.42+.34*smoothstep(.2,1,luminance);
      }
      for(let channel=0;channel<3;channel+=1)output.data[offset+channel]=mix(output.data[offset+channel],target[channel],amount);
    }
  }
  targetContext.putImageData(output,0,0);
}
