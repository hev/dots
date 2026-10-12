// Apps on the screen: named views mounted over the chat in the same page, so the
// Live session, transcript, chips, links and pending jobs stay exactly as they
// were. This is plain browser JS that the page script embeds; it is its own
// string so a test can run it against a fake page (see test/apps.test.ts).
//
// createApps({doc, win, hist, host, defs, onChange, onError, load}) returns
// {open, close, current}. Each open pushes a history entry, so back (Android,
// swipe-back, a standalone PWA's back) lands here as a popstate and closes the
// app. Closing from the page (the pill, a voice close) pops that entry itself.
//
// An app def is {html?, script?, module?}: html goes into the container, the
// script runs as a function body of (el, api), and module is a URL whose
// `mount(el, api)` is called. Any of them may return a cleanup function (or a
// promise of one). `api` is {name, el, on(event, fn), open(name), close()}; `on`
// listens for the screen's dot:* events on window and is undone on close.

export const APPS = String.raw`
function createApps(env){
  const {doc,win,hist,host,defs}=env, load=env.load||(u=>import(u));
  let cur=null, backing=false, queued=null;
  const inHist=()=>(hist.state&&hist.state.dotApp)||null;
  if(inHist()) hist.replaceState(null,'');  /* a reload can't bring the app back, so the entry goes */
  function teardown(){ const a=cur; cur=null; a.dead=true;
    for(const [ev,fn] of a.subs) win.removeEventListener(ev,fn);
    try{ a.cleanup&&a.cleanup(); }catch(e){}
    a.el.remove(); host.classList.remove('on'); env.onChange(null); }
  function show(name){ const def=defs[name], el=doc.createElement('div'), subs=[];
    el.className='app-view'; el.setAttribute('data-app',name); host.append(el);
    const a=cur={name,el,subs,dead:false,cleanup:null};
    const api={name,el,open,close,on(ev,fn){ win.addEventListener('dot:'+ev,fn); subs.push(['dot:'+ev,fn]); }};
    host.classList.add('on'); env.onChange(name);
    const keep=c=>{ if(typeof c!=='function') return; if(a.dead) c(); else a.cleanup=c; };
    const fail=e=>{ env.onError(name,e); if(cur===a) close(); };
    try{
      if(def.html) el.innerHTML=def.html;
      if(def.script) Promise.resolve(new Function('el','api',def.script)(el,api)).then(keep,fail);
      if(def.module) Promise.resolve(load(def.module)).then(m=>m.mount(el,api)).then(keep,fail);
    }catch(e){ fail(e); } }
  function open(name){
    if(!Object.prototype.hasOwnProperty.call(defs,name)) return false;
    if(cur&&cur.name===name) return true;
    if(backing){ queued=name; return true; }  /* a close is still popping its entry */
    const had=!!inHist();
    if(cur) teardown();
    hist[had?'replaceState':'pushState']({dotApp:name},'');
    show(name); return true; }
  function close(){ if(!cur) return false; teardown();
    if(inHist()){ backing=true; hist.back(); } return true; }
  win.addEventListener('popstate',()=>{ backing=false; const s=inHist();
    if(cur&&s!==cur.name) teardown();
    if(queued){ const q=queued; queued=null; open(q); }
    else if(!cur&&s&&Object.prototype.hasOwnProperty.call(defs,s)) show(s); });
  return {open,close,current:()=>cur&&cur.name};
}
`;
