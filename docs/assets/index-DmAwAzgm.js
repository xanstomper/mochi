import{r as b,j as e,c as Ye,S as Ke,b as Re,T as ze,d as G,e as Ve,R as Te,D as Se,f as qe,C as B,u as $e,G as Ze,g as S,M as Je,h as Qe}from"./anim-3RObVTFs.js";import{R as es}from"./RepoBrowser-BE_IxFTS.js";const ss=`#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`,ts=`#version 300 es
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
}`,as=48,Ee=6,ee=3.2,T=(l,E,N)=>Math.min(N,Math.max(E,l)),Ne=(l,E,N)=>{const x=l.createShader(E);return x?(l.shaderSource(x,N),l.compileShader(x),l.getShaderParameter(x,l.COMPILE_STATUS)?x:(l.deleteShader(x),null)):null},rs=({color:l=[1,1,1],speed:E=1,amplitude:N=.1,mouseReact:x=!0,scale:P=1,detail:we=8,rotation:Me=0,warp:ye=1,hueShift:Ae=0,saturation:be=1,brightness:Ie=1.5,contrast:Pe=1,stir:Fe=.5,sheen:Ce=.3,clickSwirl:ke=!0,grain:Oe=0,fade:De=0,opacity:Le=1,resolution:Ue=1,paused:_e=!1,className:se="",style:Be})=>{const te=b.useRef(null),ae=b.useRef(null),F=b.useRef(null),re={colorKey:Array.isArray(l)?l.join(","):String(l),color:l,speed:E,amplitude:N,mouseReact:x,scale:Math.max(.05,P),detail:T(Math.round(we),1,24),rotation:Me,warp:ye,hueShift:Ae,saturation:Math.max(0,be),brightness:Math.max(0,Ie),contrast:Math.max(0,Pe),stir:Math.max(0,Fe),sheen:Math.max(0,Ce),clickSwirl:ke,grain:T(Oe,0,1),fade:T(De,0,1),opacity:T(Le,0,1),resolution:T(Ue,.1,2),paused:_e},R=b.useRef(re);return R.current=re,b.useEffect(()=>{var fe;const g=te.current,v=ae.current,s=v==null?void 0:v.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1});if(!g||!v||!s)return;const H=Ne(s,s.VERTEX_SHADER,ss),X=Ne(s,s.FRAGMENT_SHADER,ts),j=s.createProgram();if(!H||!X||!j||(s.attachShader(j,H),s.attachShader(j,X),s.linkProgram(j),!s.getProgramParameter(j,s.LINK_STATUS)))return;s.useProgram(j);const ie=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,ie),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),s.STATIC_DRAW);const ne=s.getAttribLocation(j,"aPosition");s.enableVertexAttribArray(ne),s.vertexAttribPointer(ne,2,s.FLOAT,!1,0,0);const o={};for(const a of["uResolution","uTime","uColor","uMouse","uAmplitude","uScale","uRotation","uDetail","uWarp","uHue","uSaturation","uBrightness","uContrast","uGrain","uSeed","uFade","uOpacity","uField","uStir","uPointer","uSheen","uSwirls"])o[a]=s.getUniformLocation(j,a);const D=s.createTexture();s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,D),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),s.uniform1i(o.uField,0);const W=document.createElement("canvas");W.width=1,W.height=1;const w=W.getContext("2d",{willReadFrequently:!0}),Y=((fe=window.matchMedia)==null?void 0:fe.call(window,"(prefers-reduced-motion: reduce)").matches)??!1,u={x:.5,y:.5,inside:!1,tracked:!1},t={width:1,height:1,phase:0,mouse:[.5,.5],presence:0,color:[1,1,1],colorKey:"",cols:0,rows:0,field:new Float32Array(0),scratch:new Float32Array(0),fieldActive:!1,swirls:[],seed:0},K=new Float32Array(Ee*4);let M=0,C=0,L=!0,z=!0;const Ge=a=>{if(a.colorKey===t.colorKey)return;if(t.colorKey=a.colorKey,Array.isArray(a.color)){t.color=[0,1,2].map(c=>T(Number(a.color[c]??1),0,1));return}if(!w)return;w.clearRect(0,0,1,1),w.fillStyle="#ffffff",w.fillStyle=String(a.color),w.fillRect(0,0,1,1);const[r,n,i]=w.getImageData(0,0,1,1).data;t.color=[r/255,n/255,i/255]},He=()=>{const a=as,r=T(Math.round(a*t.height/t.width),6,96);a===t.cols&&r===t.rows||(t.cols=a,t.rows=r,t.field=new Float32Array(a*r*2),t.scratch=new Float32Array(a*r*2),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,D),s.texImage2D(s.TEXTURE_2D,0,s.RG16F,a,r,0,s.RG,s.FLOAT,t.field))},Xe=(a,r,n,i)=>{const{cols:c,rows:h,field:p}=t,d=.22,f=t.width/t.height,k=Math.max(0,Math.floor((a-d/f)*c)),$=Math.min(c-1,Math.ceil((a+d/f)*c)),Z=Math.max(0,Math.floor((r-d)*h)),J=Math.min(h-1,Math.ceil((r+d)*h));for(let A=Z;A<=J;A++)for(let m=k;m<=$;m++){const U=((m+.5)/c-a)*f,xe=(A+.5)/h-r,O=1-(U*U+xe*xe)/(d*d);if(O<=0)continue;const _=(A*c+m)*2,pe=p[_]+n*O*O*3.2,ge=p[_+1]+i*O*O*3.2,Q=Math.hypot(pe,ge),ve=.4,je=Q>0?ve*Math.tanh(Q/ve)/Q:0;p[_]=pe*je,p[_+1]=ge*je}t.fieldActive=!0},We=a=>{const{cols:r,rows:n,field:i,scratch:c}=t,h=Math.exp(-a*1.4);let p=0;for(let d=0;d<n;d++)for(let f=0;f<r;f++){const k=(d*r+f)*2,$=(d*r+Math.max(0,f-1))*2,Z=(d*r+Math.min(r-1,f+1))*2,J=(Math.max(0,d-1)*r+f)*2,A=(Math.min(n-1,d+1)*r+f)*2;for(let m=0;m<2;m++){const U=(i[k+m]*12+i[$+m]+i[Z+m]+i[J+m]+i[A+m])/16;c[k+m]=U*h,p=Math.max(p,Math.abs(c[k+m]))}}i.set(c),p<4e-4&&(i.fill(0),t.fieldActive=!1)},V=()=>{const a=R.current;Ge(a),He(),s.viewport(0,0,v.width,v.height),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,D),s.texSubImage2D(s.TEXTURE_2D,0,0,0,t.cols,t.rows,s.RG,s.FLOAT,t.field),K.fill(0),t.swirls.forEach((r,n)=>{const i=.21*(1+.4*r.age),c=Math.exp(-r.age*1.35)-Math.exp(-r.age*10),h=Math.min(1,(ee-r.age)/.8);K.set([r.x,r.y,i,3*c*h*(.21/i)**2],n*4)}),s.uniform2f(o.uResolution,t.width,t.height),s.uniform1f(o.uTime,t.phase),s.uniform3f(o.uColor,t.color[0],t.color[1],t.color[2]),s.uniform2f(o.uMouse,t.mouse[0],t.mouse[1]),s.uniform1f(o.uAmplitude,a.amplitude),s.uniform1f(o.uScale,a.scale),s.uniform1f(o.uRotation,a.rotation*Math.PI/180),s.uniform1i(o.uDetail,a.detail),s.uniform1f(o.uWarp,a.warp),s.uniform1f(o.uHue,a.hueShift*Math.PI/180),s.uniform1f(o.uSaturation,a.saturation),s.uniform1f(o.uBrightness,a.brightness),s.uniform1f(o.uContrast,a.contrast),s.uniform1f(o.uGrain,a.grain),s.uniform1f(o.uSeed,t.seed),s.uniform1f(o.uFade,a.fade),s.uniform1f(o.uOpacity,a.opacity),s.uniform1f(o.uStir,a.mouseReact?a.stir:0),s.uniform3f(o.uPointer,u.x,u.y,a.mouseReact?t.presence:0),s.uniform1f(o.uSheen,a.sheen),s.uniform4fv(o.uSwirls,K),s.clearColor(0,0,0,0),s.clear(s.COLOR_BUFFER_BIT),s.drawArrays(s.TRIANGLES,0,3)},oe=a=>{if(M=0,!z||!L)return;const r=R.current,n=C?Math.min(.05,(a-C)/1e3):1/60;C=a;const i=!r.paused&&!Y;i&&(t.phase+=n*r.speed);const c=r.mouseReact&&u.tracked?[u.x,u.y]:[.5,.5],h=1-Math.exp(-n*5);t.mouse[0]+=(c[0]-t.mouse[0])*h,t.mouse[1]+=(c[1]-t.mouse[1])*h,t.presence+=((u.inside?1:0)-t.presence)*(1-Math.exp(-n*4)),t.fieldActive&&We(n),t.swirls=t.swirls.filter(d=>(d.age+=n)<ee),r.grain>0&&i&&(t.seed=Math.floor(a/42)%997),V();const p=Math.abs(c[0]-t.mouse[0])>5e-4||Math.abs(c[1]-t.mouse[1])>5e-4||Math.abs((u.inside?1:0)-t.presence)>.002;i||p||t.fieldActive||t.swirls.length?M=requestAnimationFrame(oe):C=0},y=()=>{M||!z||!L||(M=requestAnimationFrame(oe))},ce=a=>{const r=g.getBoundingClientRect();return{x:(a.clientX-r.left)/Math.max(1,r.width),y:1-(a.clientY-r.top)/Math.max(1,r.height)}},le=a=>{const r=R.current,{x:n,y:i}=ce(a),c=n>=0&&n<=1&&i>=0&&i<=1;c&&r.mouseReact&&!Y&&u.inside&&r.stir>0&&Xe(n,i,n-u.x,i-u.y),u.x=n,u.y=i,u.inside=c,c&&(u.tracked=!0),y()},de=()=>{u.inside=!1,y()},ue=a=>{if(!R.current.clickSwirl||Y)return;const{x:n,y:i}=ce(a);if(!(n<0||n>1||i<0||i>1)){if(t.swirls.length>=Ee){if(t.swirls[0].age<ee-.4)return;t.swirls.shift()}t.swirls.push({x:n,y:i,age:0}),y()}},q=()=>{const a=R.current,r=Math.min(window.devicePixelRatio||1,2)*a.resolution;t.width=Math.max(1,g.clientWidth),t.height=Math.max(1,g.clientHeight),v.width=Math.max(1,Math.round(t.width*r)),v.height=Math.max(1,Math.round(t.height*r)),V(),y()};F.current=()=>{const a=Math.min(window.devicePixelRatio||1,2)*R.current.resolution;v.width!==Math.max(1,Math.round(t.width*a))?q():M||V(),y()};const me=new ResizeObserver(q);me.observe(g);const he=new IntersectionObserver(a=>{L=a.some(r=>r.isIntersecting),L&&(C=0,y())});return he.observe(g),window.addEventListener("pointermove",le,{passive:!0}),window.addEventListener("pointerdown",ue,{passive:!0}),document.documentElement.addEventListener("pointerleave",de),q(),()=>{z=!1,cancelAnimationFrame(M),F.current=null,me.disconnect(),he.disconnect(),window.removeEventListener("pointermove",le),window.removeEventListener("pointerdown",ue),document.documentElement.removeEventListener("pointerleave",de),s.deleteTexture(D),s.deleteBuffer(ie),s.deleteProgram(j),s.deleteShader(H),s.deleteShader(X)}},[]),b.useEffect(()=>{var g;(g=F.current)==null||g.call(F)}),e.jsx("div",{ref:te,className:`iridescence-container${se?` ${se}`:""}`,style:Be,children:e.jsx("canvas",{ref:ae,className:"iridescence-canvas","aria-hidden":"true"})})},I=({children:l})=>e.jsx("div",{className:"eyebrow",children:l});function is(){return e.jsxs("section",{className:"hero2",children:[e.jsx(Ke,{}),e.jsx("div",{className:"bg-blob b1"}),e.jsx("div",{className:"bg-blob b2"}),e.jsxs("div",{className:"wrap",children:[e.jsx(I,{children:"OPEN SOURCE • MIT • 0 DEPENDENCIES"}),e.jsx("h1",{className:"giant",children:e.jsx(Re,{text:"MOCHI"})}),e.jsxs("p",{className:"giant-sub",style:{marginBottom:16},children:[e.jsx("span",{className:"gi",children:"The terminal coding agent"}),e.jsx("br",{}),e.jsx("span",{className:"gi pink",children:"that gets out of your way."})]}),e.jsx("p",{className:"lede",style:{marginBottom:24},children:e.jsx(ze,{phrases:["Goals decompose into task DAGs.","Sixteen roles execute in parallel.","A persistent daemon keeps them running.","Every run replays trace-for-trace.","All on 18 MB of RAM."],speed:40,pause:1600})}),e.jsxs("div",{className:"cta-pair",children:[e.jsx(G,{strength:.25,children:e.jsx("a",{className:"btn-loud",href:"https://github.com/xanstomper/mochi",children:"INSTALL VIA TERMINAL"})}),e.jsx(G,{strength:.2,children:e.jsx("a",{className:"btn-quiet",href:"benchmarks.html",children:"READ THE BENCHMARKS"})})]})]}),e.jsx(Ve,{speed:24,items:["18.2 MB RESIDENT","38.2 MS TO FIRST INPUT","16 AGENT ROLES","31 RELEASES","1200 TESTS PASSING","ZERO RUNTIME DEPS","RUST COMPUTE CORE"]}),e.jsx("div",{className:"hero-visual",children:e.jsx(Te,{className:"dither-reveal",children:e.jsx(Se,{height:380})})})]})}function ns(){return e.jsx("section",{className:"gnums",children:e.jsxs("div",{className:"wrap",children:[e.jsx(I,{children:"RECEIPTS, NOT VIBES"}),e.jsx(qe,{className:"gstat-grid",itemClass:"gstat",items:[e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"gstat-n",children:e.jsx(B,{target:18.2,decimals:1,suffix:" MB"})}),e.jsx("div",{className:"gstat-label",children:"RESIDENT MEMORY"}),e.jsx("div",{className:"gstat-note",children:"single session"}),e.jsx("div",{className:"gstat-d",children:"21× lighter than Claude Code — measured, not claimed"})]}),e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"gstat-n",children:e.jsx(B,{target:38.2,decimals:1,suffix:" ms"})}),e.jsx("div",{className:"gstat-label",children:"TIME TO FIRST INPUT"}),e.jsx("div",{className:"gstat-note",children:"cold start"}),e.jsx("div",{className:"gstat-d",children:"fastest of nine agents tested, same task set"})]}),e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"gstat-n",children:e.jsx(B,{target:16})}),e.jsx("div",{className:"gstat-label",children:"AGENT ROLES"}),e.jsx("div",{className:"gstat-note",children:"orchestrated per goal"}),e.jsx("div",{className:"gstat-d",children:"planner, builder, verifier, critic, memory, and more"})]}),e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"gstat-n",children:e.jsx(B,{target:1200,suffix:"+"})}),e.jsx("div",{className:"gstat-label",children:"TESTS PASSING"}),e.jsx("div",{className:"gstat-note",children:"0 failing"}),e.jsx("div",{className:"gstat-d",children:"real integration tests against live providers"})]})]})]})})}function os(){const l=$e(40);return e.jsx("section",{className:"manifest",children:e.jsxs("div",{className:"wrap manifest-grid",children:[e.jsx(Te,{as:"div",className:"manifest-copy",children:e.jsx(Ze,{className:"manifest-gooey",speed:6,thickness:2,children:e.jsxs("div",{className:"manifest-inner",children:[e.jsx(I,{children:"THE POINT"}),e.jsx(S,{from:"left",children:e.jsx("h2",{className:"big2",children:"Powerful agents should belong to everyone."})}),e.jsx("p",{children:"Mochi is a working argument that an autonomous coding agent doesn't need a datacenter, a subscription, or 140 MB of RSS. It needs a small kernel, honest verification, and a memory that survives the session."}),e.jsx("p",{children:"Every release is dogfooded by the agent itself — regressions found by running real tasks, not by wishing. What ships is what survived."}),e.jsx("a",{className:"btn-quiet",href:"docs.html",children:"READ THE DOCS →"})]})})}),e.jsxs("div",{className:"manifest-visual",children:[e.jsx("div",{className:"mochi-orbit",ref:l,children:e.jsx(Je,{size:300,className:"bob"})}),e.jsx("div",{className:"orbit-ring r1"}),e.jsx("div",{className:"orbit-ring r2"})]})]})})}function cs(){const l=[["01","GOAL","You describe the outcome. Plain language, no ceremony."],["02","DAG","Mochi decomposes it into a dependency graph of concrete tasks."],["03","TEAM","Sixteen specialized roles pick up tasks in parallel — planner, builder, verifier, critic."],["04","VERIFY","Every artifact is re-checked against the filesystem, independent of the builder's claims."],["05","REPLAY","The whole run persists trace-for-trace. Rewind, inspect, resume."]];return e.jsx("section",{className:"flow2",children:e.jsxs("div",{className:"wrap",children:[e.jsx(I,{children:"HOW A GOAL BECOMES A MERGE"}),l.map(([E,N,x],P)=>e.jsxs(S,{from:P%2===0?"left":"right",delay:P*60,className:"flow-row"+(P<l.length-1?" ruled":""),children:[e.jsx("span",{className:"flow-n",children:E}),e.jsx("span",{className:"flow-t",children:N}),e.jsx("span",{className:"flow-d",children:x})]},E))]})})}function ls(){return e.jsx("section",{className:"screens",children:e.jsxs("div",{className:"wrap",children:[e.jsx(I,{children:"THE SURFACE"}),e.jsx(S,{from:"left",children:e.jsx("h2",{className:"big2",children:"Terminal velocity."})}),e.jsx(S,{from:"right",delay:80,children:e.jsx("p",{className:"lede",style:{marginBottom:24},children:"A 60 fps TUI with streaming diffs, live task trees, and zero flicker. Runs over SSH. Runs in tmux. Runs on your phone's SSH client at 2 a.m."})}),e.jsx(Qe,{max:3,children:e.jsxs("div",{className:"term2",children:[e.jsxs("div",{className:"term2-bar",children:[e.jsx("i",{}),e.jsx("i",{}),e.jsx("i",{}),e.jsx("span",{children:"mochi — zsh — 80×24"})]}),e.jsxs("pre",{className:"term2-body",children:[e.jsx("span",{className:"t-dim",children:"$"}),' mochi "migrate auth to passkeys, keep tests green"',e.jsx("span",{className:"t-pink",children:"◆ planning"})," 3 tasks · 2 parallel tracks",e.jsx("span",{className:"t-dim",children:"│"})," ",e.jsx("span",{className:"t-dim",children:"t1"})," inventory credential flows … ",e.jsx("span",{className:"t-green",children:"✓ 412 ms"}),e.jsx("span",{className:"t-dim",children:"│"})," ",e.jsx("span",{className:"t-dim",children:"t2"})," add passkey registration route … ",e.jsx("span",{className:"t-green",children:"✓ 1.9 s"}),e.jsx("span",{className:"t-dim",children:"│"})," ",e.jsx("span",{className:"t-dim",children:"t3"})," migrate session store … ",e.jsx("span",{className:"t-amber",children:"◐ verifying"}),e.jsx("span",{className:"t-pink",children:"◆ verification"})," 1200 passed · 0 failed",e.jsx("span",{className:"t-green",children:"✓ done"})," — replay: ",e.jsx("span",{className:"t-dim",children:".mochi/runs/2026-10-10T14:32Z"})]})]})}),e.jsxs("div",{className:"tri",children:[e.jsxs(S,{from:"left",className:"tri-card",children:[e.jsx("div",{className:"tri-k",children:"TUI"}),e.jsx("h3",{children:"Terminal Velocity"}),e.jsx("p",{children:"Streaming everything. Keyboard-first. 60 fps."}),e.jsx("a",{href:"docs.html",children:"INSTALL VIA TERMINAL →"})]}),e.jsxs(S,{from:"right",delay:80,className:"tri-card",children:[e.jsx("div",{className:"tri-k",children:"DAEMON"}),e.jsx("h3",{children:"Runs While You Sleep"}),e.jsx("p",{children:"A persistent daemon executes long goals across sessions and resumes cleanly."}),e.jsx("a",{href:"docs.html",children:"MEET THE DAEMON →"})]}),e.jsxs(S,{from:"left",delay:160,className:"tri-card",children:[e.jsx("div",{className:"tri-k",children:"MEMORY"}),e.jsx("h3",{children:"Learns Your Codebase"}),e.jsx("p",{children:"Procedural memory persists what worked. Every session starts smarter than the last."}),e.jsx("a",{href:"docs.html",children:"HOW MEMORY WORKS →"})]})]})]})})}function ds(){return e.jsxs("section",{className:"reposec",id:"repo",children:[e.jsxs("div",{className:"wrap",children:[e.jsx(I,{children:"NOTHING HIDDEN"}),e.jsx("h2",{className:"big2",children:"The whole repo, right here."}),e.jsx("p",{className:"lede",style:{marginBottom:24},children:"Every file, readable without leaving the page. This is the actual main branch, fetched live."})]}),e.jsx("div",{className:"wrap rb-window",children:e.jsx(es,{compact:!0})})]})}function us(){return e.jsxs("section",{className:"coda",children:[e.jsx(Se,{height:300,from:"#4E372C",to:"#F2A7B8"}),e.jsxs("div",{className:"wrap coda-inner",children:[e.jsx("h2",{className:"giant2",children:e.jsx(Re,{text:"SMALL IS THE FEATURE"})}),e.jsxs("div",{className:"cta-pair center",children:[e.jsx(G,{strength:.25,children:e.jsx("a",{className:"btn-loud",href:"https://github.com/xanstomper/mochi",children:"STAR ON GITHUB"})}),e.jsx(G,{strength:.2,children:e.jsx("a",{className:"btn-quiet invert",href:"changelog.html",children:"31 RELEASES AND COUNTING"})})]})]})]})}function ms(){return e.jsxs(e.Fragment,{children:[e.jsx("div",{className:"iridescence-bg","aria-hidden":"true",children:e.jsx(rs,{color:"#F2A7B8",speed:.7,scale:1.4,detail:7,warp:1.2,hueShift:10,saturation:.55,brightness:1.1,contrast:.85,mouseReact:!0,amplitude:.08,stir:.4,sheen:.25,clickSwirl:!0,grain:.04,opacity:.5,resolution:.75})}),e.jsx("div",{className:"iridescence-veil","aria-hidden":"true"}),e.jsx(is,{}),e.jsx(ns,{}),e.jsx(os,{}),e.jsx(cs,{}),e.jsx(ls,{}),e.jsx(ds,{}),e.jsx(us,{})]})}Ye(document.getElementById("root")).render(e.jsx(ms,{}));
