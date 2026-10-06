// The voice screen: one page that talks to a dot. Tap the dot, speak, and it
// answers over Gemini Live with the persona and tools the server locked into the
// token. Tool calls go to the dot's own /api/tool with the session id, so acts
// read back and run only on a matching yes; slow tools poll /api/job; display
// tools ({url, label}) put a link on screen and the model hears only that it's up.
// Typed questions are answered in text (POST /chat, when the dot has a text
// model), so typing never wakes the voice. "info" lists the dot's tools and the
// inbox it reads. "new" (or typing /clear) ends the session: the screen empties, the Live
// session and its resumption handle go, and the next turn starts a fresh session id.
//
// Extracted from hev dot's web/index.html, minus what's hev mind's own (cues,
// sub-agents, images, dead-air nuggets). A dot serves it with
// `screenRoutes(opts)`, chained ahead of `dot.fetch`.

import { installHead, type InstallOptions } from "../install/index.ts";
import type { Pack } from "../server/types.ts";

export type ScreenOptions = {
  /** Shown as the wordmark and the page title. */
  name: string;
  /** Under the wordmark, e.g. "finance". */
  subtitle?: string;
  /** Who the dot talks to, for the app's notes to the model. Default "the user". */
  user?: string;
  /** Friendly names for tools on the chips, e.g. { spend: "your spending" }. */
  labels?: Record<string, string>;
  /** The dot's packs, for their chip labels. */
  packs?: Pack[];
  /** The dot's routes. Default "/api". */
  base?: string;
  /** Accent color. Default hev dot's signal orange. */
  accent?: string;
  /** Makes the screen installable as an app; pair with installRoutes(). */
  install?: InstallOptions;
  /** An image for the orb, e.g. the dot's icon; round art fills it. Default a plain dot. */
  orb?: string;
  /** Colors, for light and dark. Anything left out keeps hev dot's paper and ink. */
  theme?: { light?: Palette; dark?: Palette };
};

/** The screen's colors. `accent` is the dot's signal: the cursor, the glow, links. */
export type Palette = Partial<Record<"paper" | "ink" | "muted" | "rule" | "card" | "accent", string>>;

const COLOR = /^#[0-9a-f]{3,8}$/i;
function vars(p: Palette = {}): string {
  return Object.entries(p)
    .filter(([, v]) => COLOR.test(v))
    .map(([k, v]) => `--${k === "accent" ? "sig" : k}:${v}`)
    .join(";");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page, as a string. */
export function screen(o: ScreenOptions): string {
  const cfg = {
    name: o.name,
    user: o.user ?? "the user",
    labels: Object.assign({}, ...(o.packs ?? []).map((p) => p.labels ?? {}), o.labels),
    base: o.base ?? "/api",
  };
  // JSON inside <script> must not close the tag.
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const accent = o.accent ?? "#e25822";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
${o.install ? installHead(o.install) : ""}
<title>${esc(o.name)}</title>
<style>${CSS.replace("__ACCENT__", accent)}${theme(o.theme)}</style>
</head>
<body>
<div class="app">
  <header><div class="wm">${esc(o.name)}<span class="cur"></span>${o.subtitle ? `<span class="sfx">${esc(o.subtitle)}</span>` : ""}</div>
    <button id="install" hidden>install</button><button id="new" title="clear the conversation and start fresh">new</button><button id="mode"></button><button id="infoBtn">info</button><button id="logBtn">log</button></header>
  <main>
    <button id="dot" aria-label="talk"><span id="halo"></span>${o.orb ? `<img id="core" class="art" src="${esc(o.orb)}" alt="">` : `<span id="core"></span>`}</button>
    <div id="status">tap to talk</div>
    <div id="you"></div><div id="say"></div>
    <div id="chips"></div><div id="links"></div>
  </main>
  <footer><input id="type" placeholder="or type" autocomplete="off"></footer>
  <section id="log"><div class="bar"><span id="logStats"></span><button id="copyLog">copy</button><button id="logClose">close</button></div><div id="list"></div></section>
  <section id="info"><div class="bar"><span>${esc(o.name)}</span><button id="infoClose">close</button></div><div id="about"></div></section>
  <div id="toast"></div>
</div>
<script>const CFG=${json};
${SCRIPT}</script>
</body>
</html>`;
}

function theme(t: ScreenOptions["theme"]): string {
  if (!t) return "";
  const light = vars(t.light), dark = vars(t.dark);
  return (light ? `:root{${light}}` : "") + (dark ? `@media (prefers-color-scheme:dark){:root{${dark}}}` : "");
}

/** Serves the screen at "/" (and "/index.html"); null for anything else, so it chains. */
export function screenRoutes(o: ScreenOptions) {
  const body = screen(o);
  return (req: Request): Response | null => {
    const p = new URL(req.url).pathname;
    if (req.method !== "GET" || (p !== "/" && p !== "/index.html")) return null;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  };
}

const CSS = `
:root{--paper:#fafaf5;--ink:#111;--muted:#6b6b66;--rule:#e8e5dc;--card:#fff;--sig:__ACCENT__;
  --mono:ui-monospace,"JetBrains Mono",Menlo,monospace;--sans:Inter,-apple-system,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#141413;--ink:#f2f0ea;--muted:#9a978e;--rule:#2c2b28;--card:#1d1c1a}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--paper);color:var(--ink);font-family:var(--sans);overscroll-behavior:none}
body{display:flex;justify-content:center}
button{font:inherit;color:inherit;background:none;border:1px solid var(--rule);border-radius:99px;padding:4px 10px;font-size:13px;cursor:pointer}
.app{width:100%;max-width:430px;height:100dvh;display:flex;flex-direction:column;position:relative;overflow:hidden}
header{display:flex;align-items:center;gap:8px;padding:max(14px,env(safe-area-inset-top)) 16px 8px}
.wm{font:700 19px var(--mono);margin-right:auto;display:flex;align-items:center}
.wm .cur{display:inline-block;width:.5em;height:1em;background:var(--sig);margin-left:.16em;animation:blink 1.2s steps(2) infinite}
.wm .sfx{color:var(--muted);font-weight:500;margin-left:.4em}
@keyframes blink{50%{opacity:0}}
#mode.priv{border-color:var(--sig);color:var(--sig)}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:0 16px;min-height:0}
#dot{position:relative;width:150px;height:150px;border:0;padding:0;border-radius:50%;background:none}
#halo{position:absolute;inset:0;border-radius:50%;background:var(--sig);opacity:.14;transition:transform .08s}
#core{position:absolute;inset:30px;border-radius:50%;background:var(--ink);transition:transform .08s,background .2s}
#dot.on #core{background:var(--sig)}
#dot.connecting #core{animation:pulse 1s ease-in-out infinite}
#core.art{width:90px;height:90px;object-fit:cover;background:var(--card);box-shadow:0 0 18px 2px color-mix(in srgb,var(--sig) 35%,transparent)}
#dot.on #core.art{background:var(--card);box-shadow:0 0 30px 8px color-mix(in srgb,var(--sig) 70%,transparent)}
@keyframes pulse{50%{opacity:.4}}
#status{font:500 13px var(--mono);color:var(--muted)}
#you{color:var(--muted);font-size:15px;text-align:center;min-height:1.2em}
#say{font-size:19px;line-height:1.35;text-align:center;max-height:30dvh;overflow:auto}
#chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.chip{font:500 12px var(--mono);border:1px solid var(--rule);border-radius:99px;padding:3px 9px;color:var(--muted)}
.chip.err{color:#c0392b}
#links{display:flex;flex-direction:column;gap:6px;width:100%}
#links a{display:flex;justify-content:space-between;padding:10px 12px;border:1px solid var(--rule);border-radius:12px;background:var(--card);color:var(--ink);text-decoration:none}
#links a i{color:var(--muted);font-style:normal}
.card{border:1px solid var(--rule);border-radius:14px;background:var(--card);overflow:hidden}
.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--rule)}
.card .ct{padding:10px 12px}.card b{display:block;font-size:16px}.card .sub{color:var(--muted);font-size:13px;margin-top:2px}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:8px 0 0;font-size:13px}.card dt{color:var(--muted)}.card dd{margin:0}
#links .card a.go{display:block;border:0;border-top:1px solid var(--rule);border-radius:0;padding:9px 12px;color:var(--sig);font-weight:600;text-align:center}
footer{padding:8px 16px max(14px,env(safe-area-inset-bottom))}
#type{width:100%;font:inherit;font-size:16px;padding:11px 14px;border-radius:99px;border:1px solid var(--rule);background:var(--card);color:var(--ink)}
#log,#info{position:absolute;inset:0;background:var(--paper);display:none;flex-direction:column}
#log.on,#info.on{display:flex}
#info .bar span{margin-right:auto;font:700 15px var(--mono)}
#about{flex:1;overflow:auto;padding:0 16px 16px;font-size:14px}
#about h3{font:600 12px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px}
#about .tl{padding:7px 0;border-bottom:1px solid var(--rule)}#about .tl b{font-weight:600}#about .tl i{font:11px var(--mono);color:var(--sig);font-style:normal;margin-left:6px}
#about .tl div{color:var(--muted);font-size:13px;margin-top:2px}#about a{color:var(--sig)}
#log .bar,#info .bar{display:flex;gap:8px;align-items:center;padding:max(14px,env(safe-area-inset-top)) 16px 8px}
#logStats{margin-right:auto;font:500 12px var(--mono);color:var(--muted)}
#list{flex:1;overflow:auto;padding:0 16px 16px;font-size:14px}
.m{padding:6px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.m.u{color:var(--muted)}.m.t{font:12px var(--mono);color:var(--muted)}
.m.tool{font:12px var(--mono);cursor:pointer}.m.tool.err b{color:#c0392b}
.m.tool pre{display:none;white-space:pre-wrap;margin:6px 0 0}.m.tool.open pre{display:block}
.m.tool .ms{float:right;color:var(--muted)}
#toast{position:absolute;left:16px;right:16px;bottom:90px;padding:10px 14px;border-radius:12px;background:var(--ink);color:var(--paper);font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.on{opacity:1}
`;

// Plain browser JS. CFG comes from the server. Kept in step with hev dot's
// web/index.html for the audio and Live session plumbing.
const SCRIPT = String.raw`
const $=s=>document.querySelector(s), API=CFG.base;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const keep=(k,v)=>{try{if(v===undefined)return localStorage[k];localStorage[k]=v;}catch{}};
const label=n=>CFG.labels[n]||n.replace(/_/g,' ');
function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('on'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('on'),3500); }
let ws=null, ready=false, handle=null, wantMic=true, micOpen=false, sayText='', youText='', wake=null, busy=0, gen=0;

/* demo vs private: the server refuses private mode to anyone not allowed */
let demo=keep('demo')!=='0';
function drawMode(){ $('#mode').textContent=demo?'demo':'private'; $('#mode').classList.toggle('priv',!demo); }
$('#mode').onclick=()=>{ demo=!demo; keep('demo',demo?'1':'0'); drawMode(); if(ws){ stop(); toast(demo?'Demo mode: no amounts or contact details.':'Private mode: full numbers. Tap to start again.'); } };
drawMode();

/* transcript, shipped to /trace every few seconds */
const newSid=()=>(crypto.randomUUID?.()||Date.now().toString(16)+Math.random().toString(16).slice(2)).toLowerCase();
let SID=newSid(), T0=Date.now(), trace=[], unsent=[], seq=0;
function rec(e){ e.id=SID.slice(0,8)+'-'+(++seq); e.ts=new Date().toISOString(); trace.push(e); unsent.push(e); }
function ship(beacon){ if(!unsent.length) return; const body=JSON.stringify({session:SID,events:unsent}); unsent=[];
  if(beacon&&navigator.sendBeacon) navigator.sendBeacon(API+'/trace',new Blob([body],{type:'application/json'}));
  else fetch(API+'/trace',{method:'POST',headers:{'content-type':'application/json'},body,keepalive:true}).catch(()=>{}); }
setInterval(()=>ship(false),4000); addEventListener('pagehide',()=>ship(true));
function show(cls,text){ const d=document.createElement('div'); d.className='m '+cls; d.textContent=text; $('#list').append(d); $('#list').scrollTop=1e9; return d; }
function log(cls,text,extra){ rec({t:Date.now()-T0,kind:cls,text,...extra}); return show(cls,text); }
function logTool(fc,result,ms){ const err=!!result?.error, body=JSON.stringify(result,null,1)||'';
  rec({t:Date.now()-T0,kind:'tool',name:fc.name,args:fc.args||{},ms,bytes:body.length,error:result?.error||null,result});
  const d=document.createElement('div'); d.className='m tool'+(err?' err':'');
  d.innerHTML='<span class="ms">'+ms+' ms</span><b>'+(err?'✗':'⚙')+' '+esc(fc.name)+'</b>('+esc(JSON.stringify(fc.args||{}))+')'+(err?'<br>'+esc(result.error):'')+'<pre>'+esc(body.slice(0,20000))+'</pre>';
  d.onclick=()=>d.classList.toggle('open'); $('#list').append(d);
  const ts=trace.filter(x=>x.kind==='tool'); $('#logStats').textContent=ts.length+' tool calls · '+ts.filter(x=>x.error).length+' errors'; }
/* info: the tools, as the dot sees them, and the inbox it reads */
const KIND={act:'needs a yes',private:'private mode',display:'shows on screen',slow:'sub-agent'};
$('#infoBtn').onclick=async()=>{ $('#info').classList.add('on'); const box=$('#about'); box.textContent='…';
  const i=await fetch(API+'/info').then(r=>r.json()).catch(()=>null); if(!i||i.error){ box.textContent='Couldn’t load the tool list.'; return; }
  box.innerHTML=(i.inbox?'<h3>Inbox</h3><div class="tl">Forward mail to <a href="mailto:'+esc(i.inbox)+'">'+esc(i.inbox)+'</a> and '+esc(CFG.name)+' can read it.</div>':'')+
    '<h3>Tools · '+i.tools.length+'</h3>'+i.tools.map(t=>'<div class="tl"><b>'+esc(label(t.name))+'</b>'+(KIND[t.kind]?'<i>'+KIND[t.kind]+'</i>':'')+'<div>'+esc(t.description)+'</div></div>').join('')+
    '<h3>Modes</h3><div class="tl">Tap the dot to talk; type to get answers in text. '+(demo?'Demo mode hides amounts and contact details.':'Private mode shows real numbers.')+'</div>'; };
$('#infoClose').onclick=()=>$('#info').classList.remove('on');
$('#logBtn').onclick=()=>$('#log').classList.add('on'); $('#logClose').onclick=()=>$('#log').classList.remove('on');
$('#copyLog').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(trace,null,1)).then(()=>toast('Copied as JSON')).catch(()=>toast('Copy blocked'));

/* audio out: 24 kHz PCM16, scheduled back to back */
let outCtx, outAt=0, playing=[], outLevel;
function ensureOut(){ if(outCtx) return; outCtx=new AudioContext({sampleRate:24000}); outLevel=outCtx.createAnalyser(); outLevel.fftSize=256; outLevel.connect(outCtx.destination); }
function play(b64){ ensureOut(); const bin=atob(b64), n=bin.length/2, buf=outCtx.createBuffer(1,n,24000), ch=buf.getChannelData(0);
  for(let i=0;i<n;i++){ let v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8); if(v>=32768) v-=65536; ch[i]=v/32768; }
  const src=outCtx.createBufferSource(); src.buffer=buf; src.connect(outLevel); const t=Math.max(outCtx.currentTime+.03,outAt); src.start(t); outAt=t+buf.duration;
  playing.push(src); src.onended=()=>{ playing=playing.filter(s=>s!==src); }; }
function flush(){ playing.forEach(s=>{ try{s.stop();}catch{} }); playing=[]; outAt=0; }

/* audio in: mic to 16 kHz PCM16, 40 ms chunks */
let inCtx, micStream, inLevel;
const WORKLET='class P extends AudioWorkletProcessor{constructor(){super();this.b=[];}process(i){const c=i[0][0];if(c){for(const s of c)this.b.push(s);while(this.b.length>=640){const f=this.b.splice(0,640),o=new Int16Array(640);for(let k=0;k<640;k++){const v=Math.max(-1,Math.min(1,f[k]));o[k]=v<0?v*32768:v*32767;}this.port.postMessage(o.buffer,[o.buffer]);}}return true;}}registerProcessor("p",P);';
async function startMic(){
  if(!isSecureContext||!navigator.mediaDevices){ toast('Voice needs HTTPS. Type for now.'); return false; }
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
  inCtx=new AudioContext({sampleRate:16000}); await inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET],{type:'text/javascript'})));
  const src=inCtx.createMediaStreamSource(micStream), node=new AudioWorkletNode(inCtx,'p'); inLevel=inCtx.createAnalyser(); inLevel.fftSize=256;
  src.connect(inLevel); src.connect(node);
  node.port.onmessage=e=>{ if(ws?.readyState===1&&ready&&micOpen){ const u=new Uint8Array(e.data); let s=''; for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]);
    ws.send(JSON.stringify({realtimeInput:{audio:{data:btoa(s),mimeType:'audio/pcm;rate=16000'}}})); } };
  return true; }
function stopMic(){ micStream?.getTracks().forEach(t=>t.stop()); inCtx?.close(); micStream=inCtx=inLevel=null; }

/* the dot breathes with whoever is talking */
const lvl=a=>{ if(!a) return 0; const d=new Uint8Array(a.fftSize); a.getByteTimeDomainData(d); let m=0; for(const v of d) m=Math.max(m,Math.abs(v-128)); return m/128; };
const status=t=>$('#status').textContent=t;
(function anim(){ const o=lvl(outLevel), i=lvl(inLevel), speaking=o>.02, hearing=ready&&!speaking&&i>.05;
  if(ws&&ready) status(busy?'checking…':speaking?CFG.name:hearing?'hearing you':micStream?'listening':'typing · tap to talk');
  $('#halo').style.transform='scale('+(1+o*.35+(hearing?Math.min(i,.2):0))+')'; $('#core').style.transform='scale('+(1+o*.06)+')';
  requestAnimationFrame(anim); })();

function note(text){ ws?.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[{text:'[note from the app, not from '+CFG.user+'] '+text}]}],turnComplete:true}})); }

/* the Live session: the token carries the persona and tools, locked server-side */
async function start({mic=true}={}){ wantMic=mic; micOpen=false;
  const dot=$('#dot'); dot.classList.add('connecting'); status('waking…'); ensureOut(); outCtx.resume();
  try{
    const tk=await (await fetch(API+'/token?safe='+(demo?1:0))).json(); if(tk.error) throw new Error(tk.error);
    ws=new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token='+encodeURIComponent(tk.token));
    ws.onopen=()=>ws.send(JSON.stringify({setup:{model:tk.model,...(handle?{sessionResumption:{handle}}:{})}}));
    ws.onmessage=async ev=>onMsg(JSON.parse(typeof ev.data==='string'?ev.data:await ev.data.text()));
    ws.onclose=e=>{ const was=!!ws; ws=null; ready=false; dot.classList.remove('on','connecting'); stopMic(); wake?.release?.(); wake=null; micOpen=false;
      status(e.code===1000?'tap to talk':'disconnected · tap to reconnect'); if(e.code!==1000&&was) log('t','session closed '+e.code+(e.reason?' · '+e.reason:'')); };
  }catch(e){ dot.classList.remove('connecting'); status('tap to talk'); toast('Couldn’t wake '+CFG.name+': '+e.message); ws=null; }
}
function stop(){ if(ws){ const w=ws; ws=null; w.close(1000); } micOpen=false; flush(); }
async function onMsg(m){
  if(m.setupComplete){ ready=true; $('#dot').classList.remove('connecting'); $('#dot').classList.add('on');
    wake=await navigator.wakeLock?.request('screen').catch(()=>null);
    const mic=micStream?true:wantMic?await startMic().catch(e=>{ toast('Mic: '+e.message); return false; }):false;
    micOpen=true; if(!mic&&wantMic) status('typing only'); return; }
  if(m.sessionResumptionUpdate?.newHandle) handle=m.sessionResumptionUpdate.newHandle;
  if(m.goAway){ log('t','reconnecting'); const w=ws; ws=null; w?.close(1000); return start({mic:wantMic}); }
  if(m.toolCall) return tools(m.toolCall.functionCalls||[]);
  const sc=m.serverContent; if(!sc) return;
  if(sc.interrupted){ flush(); finishSay(); }
  if(sc.inputTranscription?.text){ youText+=sc.inputTranscription.text; $('#you').textContent='“'+youText.trim()+'”'; }
  for(const p of sc.modelTurn?.parts||[]) if(p.inlineData?.data) play(p.inlineData.data);
  if(sc.outputTranscription?.text){ if(youText){ log('u',youText.trim()); youText=''; } sayText+=sc.outputTranscription.text; $('#say').textContent=sayText; }
  if(sc.turnComplete&&sayText) finishSay();
}
function finishSay(){ if(youText){ log('u',youText.trim()); youText=''; } if(sayText.trim()) log('d',sayText.trim()); sayText=''; }

/* display results: a tappable link; the model only hears that it's up */
function showLink(url,text){ let host; try{ host=new URL(url).hostname; }catch{ return; }
  const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.innerHTML='<span>'+esc(text||host)+'</span><i>'+esc(host)+' ↗</i>';
  const box=$('#links'); box.prepend(a); while(box.children.length>3) box.lastChild.remove(); log('t','🔗 '+(text||url),{url}); }

/* display cards: the screen draws it; a tap on the link hands the https URL to the phone, which opens the app */
function showCard(c){ const el=document.createElement('div'); el.className='card';
  el.innerHTML=(c.image?'<img src="'+esc(c.image.src)+'" alt="'+esc(c.image.alt)+'">':'')+
    '<div class="ct"><b>'+esc(c.title)+'</b>'+(c.subtitle?'<div class="sub">'+esc(c.subtitle)+'</div>':'')+
    (c.lines?.length?'<dl>'+c.lines.map(l=>'<dt>'+esc(l.k)+'</dt><dd>'+esc(l.v)+'</dd>').join('')+'</dl>':'')+'</div>'+
    (c.link&&/^https:/.test(c.link.url)?'<a class="go" href="'+esc(c.link.url)+'" target="_blank" rel="noopener">'+esc(c.link.label)+' ↗</a>':'');
  const box=$('#links'); box.prepend(el); while(box.children.length>3) box.lastChild.remove(); log('t','🗂 '+c.title,{card:c}); }

async function call(fc){ const r=await fetch(API+'/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:fc.name,args:fc.args||{},safe:demo,session:SID})}); return r.json(); }
async function tools(calls){ const g=gen;
  const responses=await Promise.all(calls.map(async fc=>{
    const chip=document.createElement('span'); chip.className='chip'; chip.textContent='⟳ '+label(fc.name); $('#chips').append(chip);
    busy++; const t0=performance.now(); let result;
    try{ result=await call(fc); }catch(e){ result={error:String(e)}; }
    if(g!==gen) return null; busy--; logTool(fc,result,Math.round(performance.now()-t0));
    if(result?.job){ awaitJob(fc,result.job); result={working:true,note:'This takes a while. The answer will come back by itself; say so and carry on.'}; }
    else if(result?.card&&!result.error){ showCard(result.card); result={shown:true,...(result.card.note?{note:result.card.note}:{})}; }
    else if(result?.url&&result.label&&!result.error){ showLink(result.url,result.label); result={shown:true}; }
    chip.className='chip'+(result?.error?' err':''); chip.textContent=(result?.error?'✗ ':'✓ ')+label(fc.name); setTimeout(()=>chip.remove(),6000);
    return {id:fc.id,name:fc.name,response:{result}}; }));
  if(g===gen) ws?.send(JSON.stringify({toolResponse:{functionResponses:responses}})); }

/* slow tools: poll the job, then hand the result back to relay */
function awaitJob(fc,id){ const t0=Date.now(), g=gen; busy++;
  const tick=async()=>{ if(g!==gen) return; const r=await (await fetch(API+'/job/'+id)).json().catch(()=>({})); if(g!==gen) return;
    if(r.status!=='done'&&!r.error&&Date.now()-t0<600000) return setTimeout(tick,3000);
    busy--; logTool({name:fc.name+' (done)',args:fc.args},r.result??r,Date.now()-t0);
    const msg='The result of '+fc.name+' is back. Tell '+CFG.user+' what it says:\n'+JSON.stringify(r.result??r);
    if(ws&&ready) note(msg); else toast(label(fc.name)+' is ready. Open the log.'); };
  setTimeout(tick,3000); }

const goFull=()=>{ if(!document.fullscreenElement&&!matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) document.documentElement.requestFullscreen?.({navigationUI:'hide'}).catch(()=>{}); };
$('#dot').onclick=async()=>{ if(ws&&ready&&!micStream){ wantMic=true; await startMic().catch(e=>{ toast('Mic: '+e.message); }); }
  else if(ws){ stop(); status('tap to talk'); } else { goFull(); $('#you').textContent=''; $('#say').textContent=''; start(); } };
/* text mode: a typed question gets a typed answer, from the server's chat loop.
   Voice stops, so nothing talks over the page. The server traces these turns itself. */
let textOk=true;
async function ask(t){ const g=gen; if(ws){ stop(); }
  show('u',t); $('#you').textContent='“'+t+'”'; $('#say').textContent='…'; status('thinking…');
  let res; try{ res=await fetch(API+'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t,session:SID,safe:demo})}); }
  catch(e){ $('#say').textContent=''; toast('Couldn’t reach '+CFG.name+': '+e.message); status('tap to talk'); return true; }
  if(res.status===404){ textOk=false; $('#say').textContent=''; $('#list').lastChild?.remove(); return false; }
  const rd=res.body.getReader(), dec=new TextDecoder(); let buf='', chips=[];
  for(;;){ const {value,done}=await rd.read(); if(g!==gen) return true; if(done) break; buf+=dec.decode(value,{stream:true});
    let i; while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim()) continue; const m=JSON.parse(line);
      if(m.slow){ status('asking a sub-agent…'); const c=document.createElement('span'); c.className='chip'; c.textContent='⟳ '+label(m.slow); $('#chips').append(c); chips.push(c); }
      if(m.display){ if(m.display.card) showCard(m.display.card); else if(m.display.url) showLink(m.display.url,m.display.label); }
      if(m.error){ $('#say').textContent=''; show('t','✗ '+m.error); toast(m.error); }
      if(m.reply){ $('#say').textContent=m.reply; show('d',m.reply); } } }
  chips.forEach(c=>c.remove()); status('tap to talk'); return true; }

/* a fresh session: the old one's trace ships and ends; everything on screen and in the Live session goes */
function fresh(){ log('t','cleared'); ship(false); gen++; busy=0; stop(); handle=null;
  SID=newSid(); T0=Date.now(); trace=[]; seq=0;
  for(const s of ['#list','#links','#chips','#you','#say','#logStats']) $(s).textContent='';
  $('#log').classList.remove('on'); status('tap to talk'); toast('Fresh start.'); }
$('#new').onclick=fresh;
$('#type').onkeydown=async e=>{ if(e.key!=='Enter'||!e.target.value.trim()) return; const t=e.target.value.trim(); e.target.value='';
  if(/^\/(clear|new)$/i.test(t)) return fresh();
  if(textOk&&await ask(t)) return;
  if(!ws){ await start({mic:false}); await new Promise(r=>{ const i=setInterval(()=>{ if(ready||!ws){ clearInterval(i); r(); } },100); }); }
  if(!ws) return; flush(); log('u',t); $('#you').textContent='“'+t+'”'; sayText=''; $('#say').textContent='';
  ws.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[{text:t}]}],turnComplete:true}})); };

/* installable: the worker comes from installRoutes() */
let installEv=null;
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); installEv=e; $('#install').hidden=false; });
addEventListener('appinstalled',()=>{ installEv=null; $('#install').hidden=true; });
$('#install').onclick=async()=>{ if(!installEv) return; installEv.prompt(); await installEv.userChoice; installEv=null; $('#install').hidden=true; };
`;
