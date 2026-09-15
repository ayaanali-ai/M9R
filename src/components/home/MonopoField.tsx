"use client";
import {useEffect,useRef} from "react";
import styles from "./MonopoField.module.css";

// Original procedural ribbon field, reconstructed from the visual reference.
const fragment=`precision highp float;
uniform vec2 resolution; uniform float time; uniform vec2 pointer;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
 vec2 uv=gl_FragCoord.xy/resolution;vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.);
 vec2 focus=(pointer-.5)*vec2(resolution.x/resolution.y,1.);
 p-=focus*.32;
 p.y+=sin(p.x*2.+pointer.x*3.)*pointer.y*.15;
 float t=time*.065+pointer.x*.9;
 float a=sin(p.x*3.1+t)*.24+sin(p.x*1.8-t*.7)*.16;
 float b=sin(p.x*2.4-t*.8+2.)*.28;
 float d1=abs(p.y-a-.08);float d2=abs(p.y-b+.32);
 float ribbon=exp(-pow(d1/.12,2.))+exp(-pow(d2/.16,2.))*.78;
 float edge=exp(-pow((d1-.12)/.045,2.))*.55+exp(-pow((d2-.15)/.045,2.))*.3;
 float hue=.5+.5*sin(t*.6+p.x*1.3);
 vec3 pigment=mix(vec3(.7,.14,.018),vec3(.43,.025,.26),hue);
 float right=smoothstep(-.5,.7,p.x);
 float coverage=clamp(ribbon*.32+edge*.2,0.,.65)*(.25+.75*right);
 vec3 col=mix(vec3(.043,.07,.19),mix(vec3(.35,.38,.95),pigment,hue*.45),coverage);
 col+= (hash(gl_FragCoord.xy)-.5)*.018;
 gl_FragColor=vec4(max(col,0.),1.);
}`;
export default function MonopoField(){
 const canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const node=canvas.current;if(!node)return;
  const gl=node.getContext("webgl",{alpha:false,antialias:false});if(!gl)return;
  const compile=(type:number,source:string)=>{const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return null;}return shader;};
  const v=compile(gl.VERTEX_SHADER,"attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}");const f=compile(gl.FRAGMENT_SHADER,fragment);if(!v||!f)return;
  const program=gl.createProgram()!;gl.attachShader(program,v);gl.attachShader(program,f);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))return;gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const pos=gl.getAttribLocation(program,"position");gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  const res=gl.getUniformLocation(program,"resolution"),clock=gl.getUniformLocation(program,"time"),mouse=gl.getUniformLocation(program,"pointer");
  let targetX=.5,targetY=.5,x=.5,y=.5;
  const move=(event:PointerEvent)=>{if(event.pointerType!=="touch"){targetX=event.clientX/innerWidth;targetY=1-event.clientY/innerHeight;}};
  const leave=()=>{targetX=.5;targetY=.5;};
  window.addEventListener("pointermove",move,{passive:true});
  document.documentElement.addEventListener("pointerleave",leave);
  const reduce=matchMedia("(prefers-reduced-motion: reduce)");let frame=0;
  const draw=(ms:number)=>{const dpr=Math.min(devicePixelRatio,1.5),w=Math.round(innerWidth*dpr),h=Math.round(innerHeight*dpr);if(node.width!==w||node.height!==h){node.width=w;node.height=h;gl.viewport(0,0,w,h);}x+=(targetX-x)*.055;y+=(targetY-y)*.055;gl.uniform2f(mouse,reduce.matches?.5:x,reduce.matches?.5:y);gl.uniform2f(res,w,h);gl.uniform1f(clock,reduce.matches?12:ms/1000);gl.drawArrays(gl.TRIANGLES,0,6);if(!reduce.matches&&!document.hidden)frame=requestAnimationFrame(draw);};
  const restart=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);};reduce.addEventListener("change",restart);document.addEventListener("visibilitychange",restart);window.addEventListener("resize",restart);restart();
  return()=>{cancelAnimationFrame(frame);window.removeEventListener("pointermove",move);document.documentElement.removeEventListener("pointerleave",leave);reduce.removeEventListener("change",restart);document.removeEventListener("visibilitychange",restart);window.removeEventListener("resize",restart);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(v);gl.deleteShader(f);};
 },[]);
 return <div className={styles.canvasField} aria-hidden="true"><canvas ref={canvas}/></div>;
}
