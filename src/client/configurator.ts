// The desktop configurator: where the user sets up the dot they carry on their
// phone. One page, four tabs, over GET/PUT /api/config:
// - Tools & approvals: each tool on or off, and ask / always / deny.
// - Identity & look: the dot's name, icon (a URL or one of the dot's presets),
//   orb theme, voice and default text model.
// - System prompt: the dot's own instructions, with a dirty mark, a line diff
//   against what's saved, and Reset to default.
// - Sources: the dot's sources, each an opaque JSON object the dot gives meaning.
// Nothing here is policy: the server checks the login and every value, and the
// settings take effect on the next turn or session. `?embed=1` drops the page's
// own header, for a tab in another app's frame.

export type ConfiguratorOptions = {
  /** The dot's name, for the title. */
  name: string;
  /** The dot's routes. Default "/api". */
  base?: string;
  /** Accent color. Default hev dot's signal orange. */
  accent?: string;
  /** Icons the user can pick from, besides a URL of their own. */
  icons?: { label: string; src: string }[];
  /** Orb themes the user can pick from, besides a color of their own. */
  themes?: { label: string; color: string }[];
  /** Where the page lives. Default "/config". */
  path?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLOR = /^#[0-9a-f]{3,8}$/i;
const SRC = /^(https:\/\/|\/(?!\/))[^"'<>\s]+$/;

/** The page, as a string. */
export function configurator(o: ConfiguratorOptions): string {
  const cfg = {
    name: o.name,
    base: o.base ?? "/api",
    icons: (o.icons ?? []).filter((i) => SRC.test(i.src)).map((i) => ({ label: i.label, src: i.src })),
    themes: (o.themes ?? []).filter((t) => COLOR.test(t.color)).map((t) => ({ label: t.label, color: t.color })),
  };
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const accent = o.accent && COLOR.test(o.accent) ? o.accent : "#e25822";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.name)} · settings</title>
<style>${CSS.replace("__ACCENT__", accent)}</style>
</head>
<body>
<div class="wrap">
  <header id="top"><b>${esc(o.name)}</b><span>settings for your dot</span><a href="/">open the dot ↗</a></header>
  <nav role="tablist" aria-label="Settings">
    <button role="tab" id="tab-tools" aria-controls="tools" aria-selected="true">Tools &amp; approvals</button>
    <button role="tab" id="tab-identity" aria-controls="identity" aria-selected="false">Identity &amp; look</button>
    <button role="tab" id="tab-prompt" aria-controls="prompt" aria-selected="false">System prompt</button>
    <button role="tab" id="tab-sources" aria-controls="sources" aria-selected="false">Sources</button>
  </nav>
  <main>
    <div id="state" role="status">Loading…</div>
    <section role="tabpanel" id="tools" aria-labelledby="tab-tools">
      <p class="lede">What your dot can use, and what each needs before it runs. <b>Ask</b> puts an approval card on your phone; <b>Always</b> runs at once; <b>Deny</b> never runs.</p>
      <div id="toolList"></div>
    </section>
    <section role="tabpanel" id="identity" aria-labelledby="tab-identity" hidden>
      <label>Name <input id="idName" maxlength="60" autocomplete="off"></label>
      <fieldset><legend>Icon</legend><div id="iconPresets" class="presets"></div>
        <label>Icon URL <input id="idIcon" placeholder="https://… or /icon.png" autocomplete="off"></label><img id="iconPreview" alt="" hidden></fieldset>
      <fieldset><legend>Orb theme</legend><div id="themePresets" class="presets"></div>
        <label>Color <span class="row"><input id="idThemePick" type="color" aria-label="Pick a color"><input id="idTheme" placeholder="#e25822 (empty: the dot's own)" autocomplete="off"></span></label></fieldset>
      <label>Voice <span id="voiceBox"></span></label>
      <label>Text model <select id="idModel"></select></label>
    </section>
    <section role="tabpanel" id="prompt" aria-labelledby="tab-prompt" hidden>
      <div class="row between"><span id="promptMark" class="mark"></span><button id="promptReset" type="button">Reset to default</button></div>
      <textarea id="promptText" rows="16" aria-label="System prompt" spellcheck="true"></textarea>
      <div id="promptDiff" aria-label="Changes since saved"></div>
    </section>
    <section role="tabpanel" id="sources" aria-labelledby="tab-sources" hidden>
      <p class="lede">Where your dot reads from. Each source is a JSON object your dot understands, e.g. <code>{"kind":"layer","namespace":"notes"}</code>.</p>
      <div id="sourceList"></div>
      <button id="addSource" type="button">add a source</button>
    </section>
  </main>
  <footer id="bar"><span id="dirty"></span><button id="discard" type="button" disabled>Discard</button><button id="save" type="button" disabled>Save</button></footer>
  <div id="toast" role="alert"></div>
</div>
<script>const CFG=${json};
${SCRIPT}</script>
</body>
</html>`;
}

/** Serves the configurator at /config (or `path`); null for anything else, so it chains. The page is static; its data needs a login. */
export function configRoutes(o: ConfiguratorOptions) {
  const body = configurator(o);
  const path = o.path ?? "/config";
  return (req: Request): Response | null => {
    const p = new URL(req.url).pathname;
    if (req.method !== "GET" || (p !== path && p !== path + "/")) return null;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-frame-options": "SAMEORIGIN" } });
  };
}

const CSS = `
:root{--paper:#fafaf5;--ink:#111;--muted:#6b6b66;--rule:#e8e5dc;--card:#fff;--sig:__ACCENT__;
  --mono:ui-monospace,"JetBrains Mono",Menlo,monospace;--sans:Inter,-apple-system,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#141413;--ink:#f2f0ea;--muted:#9a978e;--rule:#2c2b28;--card:#1d1c1a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 var(--sans)}
button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--card);border:1px solid var(--rule);border-radius:99px;padding:6px 14px;cursor:pointer;min-height:36px}
button:disabled{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--sig);outline-offset:2px}
input,select,textarea{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:8px 10px;min-height:38px;width:100%}
input[type=color]{width:52px;padding:2px;flex:none}
.wrap{max-width:920px;margin:0 auto;padding:0 20px 90px;display:grid;grid-template-columns:200px 1fr;gap:0 28px}
header{grid-column:1/-1;display:flex;align-items:baseline;gap:10px;padding:20px 0 14px;border-bottom:1px solid var(--rule);margin-bottom:18px}
header b{font:700 20px var(--mono)}header span{color:var(--muted);margin-right:auto}header a{color:var(--sig);font-size:14px}
body.embed header{display:none}body.embed .wrap{padding-top:16px}
nav{display:flex;flex-direction:column;gap:4px;position:sticky;top:16px;align-self:start}
nav button{border:0;border-radius:10px;text-align:left;background:none;padding:9px 12px}
nav button[aria-selected=true]{background:var(--card);font-weight:600;box-shadow:inset 3px 0 0 var(--sig)}
main{min-width:0}
section label{display:flex;flex-direction:column;gap:5px;font-weight:600;font-size:14px;margin:0 0 16px}
fieldset{border:1px solid var(--rule);border-radius:12px;padding:12px 14px 2px;margin:0 0 16px}legend{font-weight:600;font-size:14px;padding:0 4px}
.row{display:flex;gap:8px;align-items:center}.between{justify-content:space-between;margin-bottom:8px}
.lede{color:var(--muted);margin:0 0 14px}
.presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.presets:empty{display:none}
.presets button{display:inline-flex;align-items:center;gap:6px}.presets button[aria-pressed=true]{border-color:var(--sig);box-shadow:0 0 0 1px var(--sig)}
.presets img{width:22px;height:22px;border-radius:50%;object-fit:cover}.presets i{width:16px;height:16px;border-radius:50%;display:inline-block}
#iconPreview{width:56px;height:56px;border-radius:50%;object-fit:cover;margin:0 0 12px;border:1px solid var(--rule)}
.tool{display:grid;grid-template-columns:auto 1fr auto;gap:4px 14px;align-items:center;padding:12px 14px;border:1px solid var(--rule);border-radius:12px;background:var(--card);margin-bottom:8px}
.tool .nm{font:600 14px var(--mono)}.tool .kd{font:11px var(--mono);color:var(--sig);margin-left:6px}.tool .ds{grid-column:2;color:var(--muted);font-size:13px}
.tool select{width:auto;min-width:110px;grid-row:1/span 2;grid-column:3}.tool input[type=checkbox]{width:20px;height:20px;min-height:0;grid-row:1/span 2}
.tool.off .nm,.tool.off .ds{opacity:.5}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:99px;overflow:hidden;grid-row:1/span 2;grid-column:3}
.seg button{border:0;border-radius:0;min-height:34px;padding:4px 12px;background:none}.seg button[aria-pressed=true]{background:var(--sig);color:#fff;font-weight:600}
.seg button+button{border-left:1px solid var(--rule)}
textarea{resize:vertical;font:14px/1.5 var(--mono);min-height:280px}
.mark{font:12px var(--mono);color:var(--muted)}.mark.dirty{color:var(--sig)}
#promptDiff{font:12px/1.5 var(--mono);margin-top:10px;border-radius:10px;overflow:hidden}#promptDiff:empty{display:none}
#promptDiff div{padding:1px 10px;white-space:pre-wrap;overflow-wrap:anywhere}#promptDiff .add{background:#2e7d3220}#promptDiff .del{background:#c0392b20;text-decoration:line-through}
.src{border:1px solid var(--rule);border-radius:12px;background:var(--card);padding:10px 12px;margin-bottom:8px}
.src .row{justify-content:space-between;margin-bottom:6px}.src b{font:600 13px var(--mono)}.src textarea{min-height:90px}.src.bad textarea{border-color:#c0392b}
.src .why{color:#c0392b;font-size:12px;margin-top:4px}.src .why:empty{display:none}
#state{color:var(--muted);margin-bottom:12px}#state:empty{display:none}#state.err{color:#c0392b}
footer{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;align-items:center;justify-content:flex-end;padding:12px max(20px,calc(50vw - 440px));background:var(--paper);border-top:1px solid var(--rule)}
#dirty{margin-right:auto;font:13px var(--mono);color:var(--muted)}#dirty.on{color:var(--sig)}
#save{background:var(--sig);border-color:var(--sig);color:#fff;font-weight:600}
#toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);padding:10px 16px;border-radius:12px;background:var(--ink);color:var(--paper);opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw}
#toast.on{opacity:1}
@media (max-width:700px){.wrap{grid-template-columns:1fr}nav{flex-direction:row;overflow:auto;position:static;margin-bottom:14px}nav button{white-space:nowrap}.tool{grid-template-columns:auto 1fr}.seg,.tool select{grid-column:1/-1;grid-row:auto;justify-self:start}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// Plain browser JS. CFG comes from the server; everything else from GET /api/config.
const SCRIPT = String.raw`
const $=s=>document.querySelector(s), API=CFG.base;
const clone=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(/[?&]embed=1\b/.test(location.search)) document.body.classList.add('embed');
function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('on'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('on'),3500); }
function state(m,err){ const s=$('#state'); s.textContent=m||''; s.classList.toggle('err',!!err); }
let view=null, saved=null, draft=null, srcText=[];

/* tabs: the hash keeps the one you're on across a reload */
const TABS=['tools','identity','prompt','sources'];
function tab(name){ if(!TABS.includes(name)) name='tools';
  for(const t of TABS){ $('#tab-'+t).setAttribute('aria-selected',String(t===name)); $('#'+t).hidden=t!==name; }
  if(location.hash!=='#'+name) history.replaceState(null,'','#'+name); }
for(const t of TABS) $('#tab-'+t).onclick=()=>tab(t);
$('nav').onkeydown=e=>{ const i=TABS.findIndex(t=>$('#tab-'+t).getAttribute('aria-selected')==='true'); const d=e.key==='ArrowDown'||e.key==='ArrowRight'?1:e.key==='ArrowUp'||e.key==='ArrowLeft'?-1:0; if(!d) return; e.preventDefault(); const n=TABS[(i+d+TABS.length)%TABS.length]; tab(n); $('#tab-'+n).focus(); };
tab(location.hash.slice(1));

async function load(){ state('Loading…');
  let r; try{ r=await fetch(API+'/config',{headers:{accept:'application/json'}}); }catch(e){ return state('Couldn’t reach '+CFG.name+'.',true); }
  const j=await r.json().catch(()=>({}));
  if(!r.ok) return state(r.status===403?'Settings need an allowed login. Sign in as the dot’s owner and reload.':(j.error||'Couldn’t load the settings ('+r.status+').'),true);
  take(j); state(''); }
function take(j){ view=j; saved=clone(j.config); draft=clone(j.config); srcText=draft.sources.map(s=>JSON.stringify(s,null,2)); $('#top b').textContent=saved.identity.name||CFG.name; draw(); }

/* tools & approvals */
const KIND={act:'act',private:'private',display:'display',slow:'slow'};
function drawTools(){ const box=$('#toolList'); box.textContent='';
  if(!view.tools.length){ box.textContent='This dot has no tools.'; return; }
  for(const t of view.tools){ const s=draft.tools[t.name]; const row=document.createElement('div'); row.className='tool'+(s.enabled?'':' off'); row.dataset.tool=t.name;
    const on=document.createElement('input'); on.type='checkbox'; on.checked=s.enabled; on.setAttribute('aria-label','Enable '+t.name); on.onchange=()=>{ s.enabled=on.checked; row.classList.toggle('off',!on.checked); dirty(); };
    const nm=document.createElement('div'); nm.innerHTML='<span class="nm"></span>'+(KIND[t.kind]?'<span class="kd"></span>':''); nm.querySelector('.nm').textContent=t.name; if(KIND[t.kind]) nm.querySelector('.kd').textContent=KIND[t.kind];
    const seg=document.createElement('div'); seg.className='seg'; seg.setAttribute('role','group'); seg.setAttribute('aria-label','Approval for '+t.name);
    for(const a of ['ask','always','deny']){ const b=document.createElement('button'); b.type='button'; b.dataset.approval=a; b.textContent=a; b.setAttribute('aria-pressed',String(s.approval===a));
      b.onclick=()=>{ s.approval=a; seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b))); dirty(); }; seg.append(b); }
    const ds=document.createElement('div'); ds.className='ds'; ds.textContent=t.description;
    row.append(on,nm,seg,ds); box.append(row); } }

/* identity & look */
function drawIdentity(){ const id=draft.identity;
  $('#idName').value=id.name; $('#idIcon').value=id.icon; $('#idTheme').value=id.theme; $('#idThemePick').value=/^#[0-9a-f]{6}$/i.test(id.theme)?id.theme:'#e25822';
  const ip=$('#iconPresets'); ip.textContent='';
  for(const i of [{label:'plain dot',src:''},...CFG.icons]){ const b=document.createElement('button'); b.type='button'; b.dataset.src=i.src; b.setAttribute('aria-pressed',String(id.icon===i.src));
    if(i.src){ const im=document.createElement('img'); im.src=i.src; im.alt=''; b.append(im); } b.append(document.createTextNode(i.label));
    b.onclick=()=>{ id.icon=i.src; $('#idIcon').value=i.src; preview(); dirty(); }; ip.append(b); }
  const tp=$('#themePresets'); tp.textContent='';
  for(const t of [{label:'the dot’s own',color:''},...CFG.themes]){ const b=document.createElement('button'); b.type='button'; b.dataset.color=t.color; b.setAttribute('aria-pressed',String(id.theme===t.color));
    const sw=document.createElement('i'); sw.style.background=t.color||'var(--ink)'; b.append(sw,document.createTextNode(t.label));
    b.onclick=()=>{ id.theme=t.color; $('#idTheme').value=t.color; if(t.color) $('#idThemePick').value=t.color; dirty(); }; tp.append(b); }
  const vb=$('#voiceBox'); vb.textContent='';
  if(Array.isArray(view.voices)){ const s=document.createElement('select'); s.id='idVoice'; s.setAttribute('aria-label','Voice');
    for(const v of ['',...view.voices]){ const o=document.createElement('option'); o.value=v; o.textContent=v||'the dot’s own'; s.append(o); }
    s.value=id.voice; s.onchange=()=>{ id.voice=s.value; dirty(); }; vb.append(s); }
  else { const i=document.createElement('input'); i.id='idVoice'; i.setAttribute('aria-label','Voice'); i.placeholder='a voice name (empty: the dot’s own)'; i.value=id.voice; i.oninput=()=>{ id.voice=i.value.trim(); dirty(); }; vb.append(i); }
  const m=$('#idModel'); m.textContent='';
  for(const x of [{id:'',name:'the dot’s default'},...view.models]){ const o=document.createElement('option'); o.value=x.id; o.textContent=x.name+(x.id?' ('+x.id+')':''); m.append(o); }
  m.value=id.model; m.disabled=!view.models.length; preview(); }
function preview(){ const src=draft.identity.icon, im=$('#iconPreview'); const ok=/^(https:\/\/|\/(?!\/))[^"'<>\s]+$/.test(src); im.hidden=!ok; if(ok) im.src=src;
  $('#iconPresets').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.src===src))); }
$('#idName').oninput=e=>{ draft.identity.name=e.target.value; dirty(); };
$('#idIcon').oninput=e=>{ draft.identity.icon=e.target.value.trim(); preview(); dirty(); };
$('#idTheme').oninput=e=>{ draft.identity.theme=e.target.value.trim(); if(/^#[0-9a-f]{6}$/i.test(draft.identity.theme)) $('#idThemePick').value=draft.identity.theme; dirty(); };
$('#idThemePick').oninput=e=>{ draft.identity.theme=e.target.value; $('#idTheme').value=e.target.value; dirty(); };
$('#idModel').onchange=e=>{ draft.identity.model=e.target.value; dirty(); };

/* system prompt: dirty against what's saved, a line diff, and a way back to the dot's default */
function diff(a,b){ const x=a.split('\n').slice(0,400), y=b.split('\n').slice(0,400), n=x.length, m=y.length;
  const L=Array.from({length:n+1},()=>new Uint16Array(m+1));
  for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--) L[i][j]=x[i]===y[j]?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
  const out=[]; let i=0,j=0; while(i<n&&j<m){ if(x[i]===y[j]){ i++; j++; } else if(L[i+1][j]>=L[i][j+1]) out.push(['del',x[i++]]); else out.push(['add',y[j++]]); }
  while(i<n) out.push(['del',x[i++]]); while(j<m) out.push(['add',y[j++]]); return out; }
function drawPrompt(){ const p=draft.systemPrompt, d=view.defaults.systemPrompt, changed=p!==saved.systemPrompt;
  const mark=$('#promptMark'); mark.textContent=(changed?'● unsaved changes · ':'saved · ')+(p===d?'the dot’s default':'edited from the default'); mark.classList.toggle('dirty',changed);
  $('#promptReset').disabled=p===d;
  const box=$('#promptDiff'); box.textContent='';
  if(changed) for(const [k,line] of diff(saved.systemPrompt,p)){ const e=document.createElement('div'); e.className=k; e.textContent=(k==='add'?'+ ':'- ')+line; box.append(e); } }
$('#promptText').oninput=e=>{ draft.systemPrompt=e.target.value; drawPrompt(); dirty(); };
$('#promptReset').onclick=()=>{ draft.systemPrompt=view.defaults.systemPrompt; $('#promptText').value=draft.systemPrompt; drawPrompt(); dirty(); toast('Back to the default. Save to keep it.'); };

/* sources: opaque JSON objects, each checked as you type */
function drawSources(){ const box=$('#sourceList'); box.textContent='';
  if(!srcText.length){ const p=document.createElement('p'); p.className='lede'; p.textContent='No sources yet.'; box.append(p); }
  srcText.forEach((txt,i)=>{ const el=document.createElement('div'); el.className='src'; el.dataset.i=i;
    const head=document.createElement('div'); head.className='row'; const b=document.createElement('b'); const rm=document.createElement('button'); rm.type='button'; rm.textContent='remove'; rm.setAttribute('aria-label','Remove source '+(i+1));
    rm.onclick=()=>{ srcText.splice(i,1); drawSources(); dirty(); }; head.append(b,rm);
    const ta=document.createElement('textarea'); ta.value=txt; ta.setAttribute('aria-label','Source '+(i+1)+' as JSON'); ta.spellcheck=false;
    const why=document.createElement('div'); why.className='why';
    const check=()=>{ const v=parseSource(ta.value); el.classList.toggle('bad',typeof v==='string'); why.textContent=typeof v==='string'?v:''; b.textContent=typeof v==='string'?'source '+(i+1):String(v.name??v.kind??v.namespace??'source '+(i+1)); };
    ta.oninput=()=>{ srcText[i]=ta.value; check(); dirty(); }; check();
    el.append(head,ta,why); box.append(el); }); }
function parseSource(t){ try{ const v=JSON.parse(t); return v&&typeof v==='object'&&!Array.isArray(v)?v:'A source is a JSON object, in { }.'; }catch(e){ return 'Not valid JSON yet.'; } }
$('#addSource').onclick=()=>{ srcText.push('{\n  "kind": "",\n  "name": ""\n}'); drawSources(); dirty(); $('#sourceList').lastChild?.querySelector('textarea')?.focus(); };

/* save: one PUT with everything; the server checks each value and keeps all of it or none */
function sources(){ const out=[]; for(const t of srcText){ const v=parseSource(t); if(typeof v==='string') return null; out.push(v); } return out; }
function changed(){ const s=sources(); return !same({...draft,sources:s??srcText},saved); }
function dirty(){ if(!view) return; const c=changed(); $('#dirty').textContent=c?'● unsaved changes':'all saved'; $('#dirty').classList.toggle('on',c); $('#save').disabled=!c; $('#discard').disabled=!c; }
function draw(){ drawTools(); drawIdentity(); $('#promptText').value=draft.systemPrompt; drawPrompt(); drawSources(); dirty(); }
$('#discard').onclick=()=>{ draft=clone(saved); srcText=draft.sources.map(s=>JSON.stringify(s,null,2)); draw(); toast('Changes discarded.'); };
$('#save').onclick=async()=>{ const s=sources(); if(!s){ tab('sources'); return toast('Fix the sources marked in red first.'); }
  $('#save').disabled=true; $('#dirty').textContent='saving…';
  let r, j={}; try{ r=await fetch(API+'/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({identity:draft.identity,systemPrompt:draft.systemPrompt,tools:draft.tools,sources:s})}); j=await r.json().catch(()=>({})); }
  catch(e){ dirty(); return toast('Couldn’t reach '+CFG.name+'. Nothing was saved.'); }
  if(!r.ok){ dirty(); return toast(j.error?'Not saved: '+j.error:'Not saved ('+r.status+').'); }
  take(j); toast('Saved. Your dot uses it from the next turn.'); };
addEventListener('beforeunload',e=>{ if(view&&changed()){ e.preventDefault(); e.returnValue=''; } });
addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='s'){ e.preventDefault(); if(!$('#save').disabled) $('#save').click(); } });
load();
`;
