import{r as P,j as e,c as Xe,S as We,A as d,b as Ee,d as O,T as ze,e as _,f as Ke,C as qe,G as Ve,g as Ye}from"./anim-A8515Lkn.js";import{R as $e}from"./RepoBrowser-D5rME8p4.js";const Ze=`#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`,Je=`#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uColor;
uniform vec2 uMouse;
uniform float uAmplitude;
uniform float uScale;
uniform float uRotation;
uniform int uDetail;
uniform float uWarp;
uniform float uHue;
uniform float uSaturation;
uniform float uBrightness;
uniform float uContrast;
uniform float uGrain;
uniform float uSeed;
uniform float uFade;
uniform float uOpacity;
uniform sampler2D uField;
uniform float uStir;
uniform vec3 uPointer;
uniform float uSheen;
uniform vec4 uSwirls[6];
in vec2 vUv;
out vec4 outColor;

vec3 hueRotate(vec3 c, float angle) {
  const vec3 k = vec3(0.57735027);
  float ca = cos(angle);
  return c * ca + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - ca);
}

float smootherstep(float edge, float x) {
  float t = clamp(x / edge, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  float mr = min(uResolution.x, uResolution.y);
  vec2 aspect = uResolution / mr;
  vec2 st = vUv - texture(uField, vUv).rg * uStir;

  for (int k = 0; k < 6; k++) {
    vec4 swirl = uSwirls[k];
    if (swirl.w == 0.0) continue;
    vec2 delta = (st - swirl.xy) * aspect;
    float angle = swirl.w * exp(-dot(delta, delta) / (swirl.z * swirl.z));
    float ca = cos(angle);
    float sa = sin(angle);
    st = swirl.xy + vec2(ca * delta.x - sa * delta.y, sa * delta.x + ca * delta.y) / aspect;
  }

  vec2 uv = (st * 2.0 - 1.0) * aspect;
  float c = cos(uRotation);
  float s = sin(uRotation);
  uv = mat2(c, -s, s, c) * uv / uScale;
  uv += (uMouse - vec2(0.5)) * uAmplitude;

  float d = -uTime * 0.5;
  float a = 0.0;
  for (int i = 0; i < 24; i++) {
    if (i >= uDetail) break;
    float fi = float(i);
    a += cos(fi - d - a * uv.x * uWarp);
    d += sin(uv.y * fi + a);
  }
  d += uTime * 0.5;
  vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
  col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5) * uColor;

  vec2 toPointer = (vUv - uPointer.xy) * aspect;
  col += col * uPointer.z * uSheen * 0.8 * exp(-dot(toPointer, toPointer) / 0.09);

  col = hueRotate(col, uHue);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uBrightness;
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain * 0.12;
  col = clamp(col, 0.0, 1.0);

  float alpha = uOpacity;
  if (uFade > 0.0) {
    vec2 px = vUv * uResolution;
    float edge = uFade * mr * 0.5;
    alpha *= smootherstep(edge, px.x) * smootherstep(edge, uResolution.x - px.x);
    alpha *= smootherstep(edge, px.y) * smootherstep(edge, uResolution.y - px.y);
  }
  outColor = vec4(col * alpha, alpha);
}`,Qe=48,ge=6,Q=3.2,T=(l,n,h)=>Math.min(h,Math.max(n,l)),ye=(l,n,h)=>{const N=l.createShader(n);return N?(l.shaderSource(N,h),l.compileShader(N),l.getShaderParameter(N,l.COMPILE_STATUS)?N:(l.deleteShader(N),null)):null},et=({color:l=[1,1,1],speed:n=1,amplitude:h=.1,mouseReact:N=!0,scale:we=1,detail:Ne=8,rotation:Re=0,warp:Te=1,hueShift:Me=0,saturation:Se=1,brightness:be=1.5,contrast:Ae=1,stir:Pe=.5,sheen:Ce=.3,clickSwirl:Fe=!0,grain:Ie=0,fade:De=0,opacity:Oe=1,resolution:Ue=1,paused:ke=!1,className:ee="",style:Be})=>{const te=P.useRef(null),se=P.useRef(null),C=P.useRef(null),ae={colorKey:Array.isArray(l)?l.join(","):String(l),color:l,speed:n,amplitude:h,mouseReact:N,scale:Math.max(.05,we),detail:T(Math.round(Ne),1,24),rotation:Re,warp:Te,hueShift:Me,saturation:Math.max(0,Se),brightness:Math.max(0,be),contrast:Math.max(0,Ae),stir:Math.max(0,Pe),sheen:Math.max(0,Ce),clickSwirl:Fe,grain:T(Ie,0,1),fade:T(De,0,1),opacity:T(Oe,0,1),resolution:T(Ue,.1,2),paused:ke},R=P.useRef(ae);return R.current=ae,P.useEffect(()=>{var me;const g=te.current,y=se.current,t=y==null?void 0:y.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,preserveDrawingBuffer:!0});if(!g||!y||!t)return;const G=ye(t,t.VERTEX_SHADER,Ze),H=ye(t,t.FRAGMENT_SHADER,Je),E=t.createProgram();if(!G||!H||!E||(t.attachShader(E,G),t.attachShader(E,H),t.linkProgram(E),!t.getProgramParameter(E,t.LINK_STATUS)))return;t.useProgram(E);const ie=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,ie),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),t.STATIC_DRAW);const re=t.getAttribLocation(E,"aPosition");t.enableVertexAttribArray(re),t.vertexAttribPointer(re,2,t.FLOAT,!1,0,0);const c={};for(const a of["uResolution","uTime","uColor","uMouse","uAmplitude","uScale","uRotation","uDetail","uWarp","uHue","uSaturation","uBrightness","uContrast","uGrain","uSeed","uFade","uOpacity","uField","uStir","uPointer","uSheen","uSwirls"])c[a]=t.getUniformLocation(E,a);const U=t.createTexture();t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,U),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.uniform1i(c.uField,0);const X=document.createElement("canvas");X.width=1,X.height=1;const M=X.getContext("2d",{willReadFrequently:!0}),W=((me=window.matchMedia)==null?void 0:me.call(window,"(prefers-reduced-motion: reduce)").matches)??!1,f={x:.5,y:.5,inside:!1,tracked:!1},s={width:1,height:1,phase:0,mouse:[.5,.5],presence:0,color:[1,1,1],colorKey:"",cols:0,rows:0,field:new Float32Array(0),scratch:new Float32Array(0),fieldActive:!1,swirls:[],seed:0},z=new Float32Array(ge*4);let S=0,F=0,k=!0,K=!0;const Le=a=>{if(a.colorKey===s.colorKey)return;if(s.colorKey=a.colorKey,Array.isArray(a.color)){s.color=[0,1,2].map(u=>T(Number(a.color[u]??1),0,1));return}if(!M)return;M.clearRect(0,0,1,1),M.fillStyle="#ffffff",M.fillStyle=String(a.color),M.fillRect(0,0,1,1);const[i,o,r]=M.getImageData(0,0,1,1).data;s.color=[i/255,o/255,r/255]},_e=()=>{const a=Qe,i=T(Math.round(a*s.height/s.width),6,96);a===s.cols&&i===s.rows||(s.cols=a,s.rows=i,s.field=new Float32Array(a*i*2),s.scratch=new Float32Array(a*i*2),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,U),t.texImage2D(t.TEXTURE_2D,0,t.RG16F,a,i,0,t.RG,t.FLOAT,s.field))},Ge=(a,i,o,r)=>{const{cols:u,rows:p,field:j}=s,m=.22,v=s.width/s.height,I=Math.max(0,Math.floor((a-m/v)*u)),Y=Math.min(u-1,Math.ceil((a+m/v)*u)),$=Math.max(0,Math.floor((i-m)*p)),Z=Math.min(p-1,Math.ceil((i+m)*p));for(let A=$;A<=Z;A++)for(let x=I;x<=Y;x++){const B=((x+.5)/u-a)*v,fe=(A+.5)/p-i,D=1-(B*B+fe*fe)/(m*m);if(D<=0)continue;const L=(A*u+x)*2,xe=j[L]+o*D*D*3.2,pe=j[L+1]+r*D*D*3.2,J=Math.hypot(xe,pe),ve=.4,je=J>0?ve*Math.tanh(J/ve)/J:0;j[L]=xe*je,j[L+1]=pe*je}s.fieldActive=!0},He=a=>{const{cols:i,rows:o,field:r,scratch:u}=s,p=Math.exp(-a*1.4);let j=0;for(let m=0;m<o;m++)for(let v=0;v<i;v++){const I=(m*i+v)*2,Y=(m*i+Math.max(0,v-1))*2,$=(m*i+Math.min(i-1,v+1))*2,Z=(Math.max(0,m-1)*i+v)*2,A=(Math.min(o-1,m+1)*i+v)*2;for(let x=0;x<2;x++){const B=(r[I+x]*12+r[Y+x]+r[$+x]+r[Z+x]+r[A+x])/16;u[I+x]=B*p,j=Math.max(j,Math.abs(u[I+x]))}}r.set(u),j<4e-4&&(r.fill(0),s.fieldActive=!1)},q=()=>{const a=R.current;Le(a),_e(),t.viewport(0,0,y.width,y.height),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,U),t.texSubImage2D(t.TEXTURE_2D,0,0,0,s.cols,s.rows,t.RG,t.FLOAT,s.field),z.fill(0),s.swirls.forEach((i,o)=>{const r=.21*(1+.4*i.age),u=Math.exp(-i.age*1.35)-Math.exp(-i.age*10),p=Math.min(1,(Q-i.age)/.8);z.set([i.x,i.y,r,3*u*p*(.21/r)**2],o*4)}),t.uniform2f(c.uResolution,s.width,s.height),t.uniform1f(c.uTime,s.phase),t.uniform3f(c.uColor,s.color[0],s.color[1],s.color[2]),t.uniform2f(c.uMouse,s.mouse[0],s.mouse[1]),t.uniform1f(c.uAmplitude,a.amplitude),t.uniform1f(c.uScale,a.scale),t.uniform1f(c.uRotation,a.rotation*Math.PI/180),t.uniform1i(c.uDetail,a.detail),t.uniform1f(c.uWarp,a.warp),t.uniform1f(c.uHue,a.hueShift*Math.PI/180),t.uniform1f(c.uSaturation,a.saturation),t.uniform1f(c.uBrightness,a.brightness),t.uniform1f(c.uContrast,a.contrast),t.uniform1f(c.uGrain,a.grain),t.uniform1f(c.uSeed,s.seed),t.uniform1f(c.uFade,a.fade),t.uniform1f(c.uOpacity,a.opacity),t.uniform1f(c.uStir,a.mouseReact?a.stir:0),t.uniform3f(c.uPointer,f.x,f.y,a.mouseReact?s.presence:0),t.uniform1f(c.uSheen,a.sheen),t.uniform4fv(c.uSwirls,z),t.clearColor(0,0,0,0),t.clear(t.COLOR_BUFFER_BIT),t.drawArrays(t.TRIANGLES,0,3)},ne=a=>{if(S=0,!K||!k)return;const i=R.current,o=F?Math.min(.05,(a-F)/1e3):1/60;F=a;const r=!i.paused&&!W;r&&(s.phase+=o*i.speed);const u=i.mouseReact&&f.tracked?[f.x,f.y]:[.5,.5],p=1-Math.exp(-o*5);s.mouse[0]+=(u[0]-s.mouse[0])*p,s.mouse[1]+=(u[1]-s.mouse[1])*p,s.presence+=((f.inside?1:0)-s.presence)*(1-Math.exp(-o*4)),s.fieldActive&&He(o),s.swirls=s.swirls.filter(m=>(m.age+=o)<Q),i.grain>0&&r&&(s.seed=Math.floor(a/42)%997),q();const j=Math.abs(u[0]-s.mouse[0])>5e-4||Math.abs(u[1]-s.mouse[1])>5e-4||Math.abs((f.inside?1:0)-s.presence)>.002;r||j||s.fieldActive||s.swirls.length?S=requestAnimationFrame(ne):F=0},b=()=>{S||!K||!k||(S=requestAnimationFrame(ne))},oe=a=>{const i=g.getBoundingClientRect();return{x:(a.clientX-i.left)/Math.max(1,i.width),y:1-(a.clientY-i.top)/Math.max(1,i.height)}},le=a=>{const i=R.current,{x:o,y:r}=oe(a),u=o>=0&&o<=1&&r>=0&&r<=1;u&&i.mouseReact&&!W&&f.inside&&i.stir>0&&Ge(o,r,o-f.x,r-f.y),f.x=o,f.y=r,f.inside=u,u&&(f.tracked=!0),b()},ce=()=>{f.inside=!1,b()},de=a=>{if(!R.current.clickSwirl||W)return;const{x:o,y:r}=oe(a);if(!(o<0||o>1||r<0||r>1)){if(s.swirls.length>=ge){if(s.swirls[0].age<Q-.4)return;s.swirls.shift()}s.swirls.push({x:o,y:r,age:0}),b()}},V=()=>{const a=R.current,i=Math.min(window.devicePixelRatio||1,2)*a.resolution;s.width=Math.max(1,g.clientWidth),s.height=Math.max(1,g.clientHeight),y.width=Math.max(1,Math.round(s.width*i)),y.height=Math.max(1,Math.round(s.height*i)),q(),b()};C.current=()=>{const a=Math.min(window.devicePixelRatio||1,2)*R.current.resolution;y.width!==Math.max(1,Math.round(s.width*a))?V():S||q(),b()};const ue=new ResizeObserver(V);ue.observe(g);const he=new IntersectionObserver(a=>{k=a.some(i=>i.isIntersecting),k&&(F=0,b())});return he.observe(g),window.addEventListener("pointermove",le,{passive:!0}),window.addEventListener("pointerdown",de,{passive:!0}),document.documentElement.addEventListener("pointerleave",ce),V(),()=>{K=!1,cancelAnimationFrame(S),C.current=null,ue.disconnect(),he.disconnect(),window.removeEventListener("pointermove",le),window.removeEventListener("pointerdown",de),document.documentElement.removeEventListener("pointerleave",ce),t.deleteTexture(U),t.deleteBuffer(ie),t.deleteProgram(E),t.deleteShader(G),t.deleteShader(H)}},[]),P.useEffect(()=>{var g;(g=C.current)==null||g.call(C)}),e.jsx("div",{ref:te,className:`iridescence-container${ee?` ${ee}`:""}`,style:Be,children:e.jsx("canvas",{ref:se,className:"iridescence-canvas","aria-hidden":"true"})})};function w({children:l}){return e.jsx("p",{className:"eyebrow",children:l})}function tt(){return e.jsxs("section",{className:"hero",style:{padding:"0"},children:[e.jsx(We,{}),e.jsxs("div",{className:"wrap hero-inner",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"OPEN SOURCE · MIT · ZERO DEPENDENCIES"})}),e.jsx(Ee,{text:"MOCHI",as:"h1",className:"display-xl",delay:70,from:"bottom"}),e.jsx(O,{text:"The terminal coding agent that gets out of your way.",className:"giant-sub",delay:60,direction:"top"}),e.jsx(d,{direction:"vertical",distance:20,duration:.5,delay:.8,children:e.jsx("p",{className:"lede",children:e.jsx(ze,{phrases:["Goals decompose into task DAGs.","Sixteen roles execute in parallel.","A persistent daemon keeps them running.","Every run replays trace-for-trace.","All on 18 MB of RAM."],speed:40,pause:1600})})}),e.jsx(d,{direction:"vertical",distance:20,duration:.5,delay:1,children:e.jsxs("div",{className:"cta-pair",children:[e.jsx(_,{strength:.25,children:e.jsx("a",{className:"btn-loud",href:"https://github.com/xanstomper/mochi",children:"INSTALL VIA TERMINAL"})}),e.jsx(_,{strength:.2,children:e.jsx("a",{className:"btn-quiet",href:"benchmarks.html",children:"READ THE BENCHMARKS"})})]})})]}),e.jsx("div",{className:"hero-ticker",children:e.jsx(Ke,{speed:28,reverse:!0,items:["18.2 MB RESIDENT","38.2 MS TO FIRST INPUT","16 AGENT ROLES","31 RELEASES","1200 TESTS PASSING","ZERO RUNTIME DEPS","RUST COMPUTE CORE"]})})]})}function st(){const l=[{num:18.2,suffix:" MB",label:"Resident memory",decimals:1},{num:38.2,suffix:" ms",label:"To first input",decimals:1},{num:16,suffix:"",label:"Agent roles",decimals:0},{num:31,suffix:"",label:"Releases shipped",decimals:0}];return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"RECEIPTS, NOT VIBES"})}),e.jsx("div",{style:{height:"32px"}}),e.jsx("div",{className:"stats-grid",children:l.map((n,h)=>e.jsx(d,{direction:"vertical",distance:40,duration:.7,delay:h*.1,children:e.jsxs("div",{className:"stat-card",children:[e.jsxs("span",{className:"stat-num",children:[e.jsx(qe,{to:n.num,duration:1.6,delay:h*.15}),n.suffix&&e.jsx("span",{className:"unit",children:n.suffix})]}),e.jsx("span",{className:"stat-label",children:n.label})]})},h))})]})})}function at(){return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap manifesto-grid",children:[e.jsxs("div",{className:"manifesto-text",children:[e.jsx(d,{direction:"horizontal",distance:60,duration:.7,children:e.jsx(w,{children:"THE MANIFESTO"})}),e.jsx(O,{text:"Powerful agents should belong to everyone.",className:"display-lg",delay:50,direction:"top"}),e.jsx(d,{direction:"vertical",distance:30,duration:.6,delay:.3,children:e.jsx("p",{children:"Mochi is a working argument that an autonomous coding agent doesn't need a datacenter, a subscription, or 140 MB of RSS. It needs a small kernel, honest verification, and a memory that survives the session."})}),e.jsx(d,{direction:"vertical",distance:30,duration:.6,delay:.5,children:e.jsx("p",{children:"Every release is dogfooded by the agent itself — regressions found by running real tasks, not by wishing. What ships is what survived."})}),e.jsx(d,{direction:"vertical",distance:30,duration:.6,delay:.7,children:e.jsx("div",{className:"pull-quote",children:'"Small is not a limitation. Small is the feature."'})})]}),e.jsx(d,{direction:"scale",duration:.8,delay:.2,children:e.jsxs("div",{className:"orbit-wrap",children:[e.jsx("div",{className:"orbit-ring r1"}),e.jsx("div",{className:"orbit-ring r2"}),e.jsx("div",{className:"orbit-ring r3"}),e.jsx("div",{className:"orbit-core",children:"🍡"})]})})]})})}function it(){const l=[{num:"01",name:"Parse",desc:"Goal → task DAG with explicit dependencies"},{num:"02",name:"Plan",desc:"Topological order, parallel batching"},{num:"03",name:"Execute",desc:"Sixteen roles work the DAG concurrently"},{num:"04",name:"Verify",desc:"Build + test gates on every merge"},{num:"05",name:"Ship",desc:"Changelog, version bump, push — hands-free"}];return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"HOW A GOAL BECOMES A MERGE"})}),e.jsx("div",{style:{height:"32px"}}),e.jsx("div",{className:"flow-list",children:l.map((n,h)=>e.jsx(d,{direction:"horizontal",distance:h%2===0?-60:60,duration:.7,delay:h*.05,children:e.jsxs("div",{className:"flow-row",children:[e.jsx("span",{className:"flow-num",children:n.num}),e.jsx("span",{className:"flow-name",children:n.name}),e.jsx("span",{className:"flow-desc",children:n.desc})]})},h))})]})})}function rt(){return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"SEE IT WORK"})}),e.jsx("div",{style:{height:"16px"}}),e.jsx(O,{text:"Terminal velocity.",className:"display-lg",delay:40,direction:"top"}),e.jsx("div",{style:{height:"32px"}}),e.jsx(d,{direction:"scale",duration:.8,delay:.2,children:e.jsx(Ve,{children:e.jsxs("div",{className:"term-card",children:[e.jsxs("div",{className:"term-header",children:[e.jsx("span",{className:"term-dot r"}),e.jsx("span",{className:"term-dot y"}),e.jsx("span",{className:"term-dot g"}),e.jsx("span",{className:"term-title",children:"mochi — zsh"})]}),e.jsxs("div",{className:"term-body",children:[e.jsx("span",{className:"prompt",children:"$"})," ",e.jsx("span",{className:"cmd",children:'mochi run "fix auth regression"'}),`
`,e.jsx("span",{className:"out",children:"◆ Parsing goal…"}),`
`,e.jsx("span",{className:"out",children:"◆ DAG: 5 tasks, 2 parallel batches"}),`
`,e.jsx("span",{className:"out",children:"◆ Spawning roles: reviewer, tester, implementer"}),`
`,e.jsx("span",{className:"ok",children:"✓ Build passed"}),`
`,e.jsx("span",{className:"ok",children:"✓ 1,247 tests passed"}),`
`,e.jsx("span",{className:"warn",children:"⚠ 1 flaky test auto-quarantined"}),`
`,e.jsx("span",{className:"ok",children:"✓ Merged: fix/auth-token-refresh"}),`
`,e.jsx("span",{className:"out",children:"  Changelog updated · v0.20.1 tagged"}),`
`,e.jsx("span",{className:"prompt",children:"$"})," ",e.jsx("span",{className:"cmd",children:"mochi status"}),`
`,e.jsx("span",{className:"path",children:"Daemon: running (18.2 MB)"}),`
`,e.jsx("span",{className:"path",children:"Queue: 0 pending · 0 active · 32 completed"})]})]})})})]})})}function nt(){const l=[{icon:"⚡",title:"Blazing fast",body:"38.2 ms to first input. 18.2 MB resident. Cold start in 12 ms. No JVM, no Electron, no waiting."},{icon:"🧠",title:"Sixteen roles",body:"Reviewer, tester, implementer, documenter — each with its own context window, working in parallel."},{icon:"🔄",title:"Persistent daemon",body:"Goals survive reboots. The daemon picks up where it left off, even after a kernel panic."}];return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"WHY MOCHI"})}),e.jsx("div",{style:{height:"32px"}}),e.jsx("div",{className:"feat-grid",children:l.map((n,h)=>e.jsx(d,{direction:"vertical",distance:50,duration:.7,delay:h*.12,children:e.jsx(Ye,{children:e.jsxs("div",{className:"feat-card",children:[e.jsx("span",{className:"feat-icon",children:n.icon}),e.jsx("span",{className:"feat-title",children:n.title}),e.jsx("span",{className:"feat-body",children:n.body})]})})},h))})]})})}function ot(){const l=[{label:"Mochi",value:18.2,display:"18.2 MB",color:"pink",max:140},{label:"Claude Code",value:140,display:"140 MB",color:"gray",max:140},{label:"Aider",value:85,display:"~85 MB",color:"gray",max:140},{label:"Cursor",value:120,display:"~120 MB",color:"gray",max:140}];return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"MEMORY FOOTPRINT"})}),e.jsx("div",{style:{height:"16px"}}),e.jsx(O,{text:"21× lighter than the nearest competitor.",className:"display-lg",delay:40,direction:"top"}),e.jsx("div",{style:{height:"40px"}}),e.jsx("div",{className:"bench-chart",children:l.map((n,h)=>e.jsx(d,{direction:"horizontal",distance:h%2===0?-40:40,duration:.6,delay:h*.1,children:e.jsxs("div",{className:"bench-row",children:[e.jsx("span",{className:"bench-label",children:n.label}),e.jsx("div",{className:"bench-bar-wrap",children:e.jsx("div",{className:"bench-bar "+n.color,style:{width:n.value/n.max*100+"%"},children:n.display})}),e.jsx("span",{className:"bench-val",children:n.display})]})},h))})]})})}function lt(){return e.jsx("section",{className:"hairline-t",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"NOTHING HIDDEN"})}),e.jsx("div",{style:{height:"16px"}}),e.jsx(O,{text:"The whole repo, right here.",className:"display-lg",delay:40,direction:"top"}),e.jsx("div",{style:{height:"32px"}}),e.jsx(d,{direction:"scale",duration:.8,delay:.2,children:e.jsx($e,{})})]})})}function ct(){return e.jsx("section",{className:"coda",children:e.jsxs("div",{className:"wrap",children:[e.jsx(d,{direction:"vertical",distance:30,duration:.6,children:e.jsx(w,{children:"THE POINT"})}),e.jsx("div",{style:{height:"24px"}}),e.jsx(Ee,{text:"SMALL IS THE FEATURE",as:"h2",className:"display-xl",delay:40,from:"bottom"}),e.jsx(d,{direction:"vertical",distance:30,duration:.6,delay:.8,children:e.jsx("p",{className:"lede",style:{margin:"0 auto"},children:"Every megabyte is a millisecond. Every millisecond is a thought interrupted. Mochi is small so you can stay in flow."})}),e.jsx("div",{style:{height:"40px"}}),e.jsx(d,{direction:"vertical",distance:20,duration:.5,delay:1,children:e.jsxs("div",{className:"cta-pair",style:{justifyContent:"center"},children:[e.jsx(_,{strength:.25,children:e.jsx("a",{className:"btn-loud",href:"https://github.com/xanstomper/mochi",children:"GET STARTED"})}),e.jsx(_,{strength:.2,children:e.jsx("a",{className:"btn-quiet",href:"docs.html",children:"READ THE DOCS"})})]})})]})})}function dt(){return e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"iridescence-bg",children:e.jsx(et,{color:"#F2A7B8",speed:.8,scale:1.4,detail:6,warp:1.2,hueShift:8,saturation:.4,brightness:.5,contrast:.6,mouseReact:!0,amplitude:.1,stir:.3,sheen:.2,grain:.03,opacity:.35,resolution:1})}),e.jsxs("div",{className:"page-content",children:[e.jsx(tt,{}),e.jsx(st,{}),e.jsx(at,{}),e.jsx(it,{}),e.jsx(rt,{}),e.jsx(nt,{}),e.jsx(ot,{}),e.jsx(lt,{}),e.jsx(ct,{})]})]})}Xe(document.getElementById("root")).render(e.jsx(dt,{}));
