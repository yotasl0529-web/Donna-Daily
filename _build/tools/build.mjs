// Donna Daily static site builder. Usage: node tools/build.mjs
// Reads data/editions/*.json, writes public/ atomically, records last successful update in data/state.json.
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data'), OUT = path.join(ROOT, 'public'), TMP = path.join(ROOT, '.public-tmp');
const REGIONS = {us:'United States', ca:'Canada', hk:'Hong Kong', cn:'China', world:'World'};
const SHORT = {us:'US', ca:'Canada', hk:'Hong Kong', cn:'China', world:'World'};
const TOPICS = {politics:'Politics & current affairs', business:'Business & tech', culture:'Culture & entertainment', sports:'Sports', human:'Human interest'};
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const nyNow = () => new Date().toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const fmtDate = d => new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});

function labelClass(l){ l=l.toLowerCase(); if(l.includes('allegation')) return 'lab-alleg'; if(l.includes('opinion')||l.includes('analysis')) return 'lab-op'; if(l.includes('reported')||l.includes('state media')) return 'lab-rep'; return 'lab-fact'; }

// ---------- validation (fail loudly; never publish a broken edition) ----------
function validate(ed){
  const errs=[];
  if(ed.kind!=='edition') return errs;
  if(!Array.isArray(ed.stories)||!ed.stories.length) errs.push('no stories');
  const ids=new Set();
  for(const s of ed.stories||[]){
    for(const k of ['id','region','topic','ts','dateLabel','headline','summary','why','label']) if(!s[k]) errs.push(`${s.id||'?'}: missing ${k}`);
    if(!REGIONS[s.region]) errs.push(`${s.id}: bad region ${s.region}`);
    if(!TOPICS[s.topic]) errs.push(`${s.id}: bad topic ${s.topic}`);
    if(!s.sources?.length) errs.push(`${s.id}: no sources`);
    for(const l of s.sources||[]) if(!/^https:\/\//.test(l.href)) errs.push(`${s.id}: non-https source ${l.href}`);
    if(ids.has(s.id)) errs.push(`duplicate id ${s.id}`); ids.add(s.id);
  }
  for(const r of Object.keys(REGIONS)){ const n=(ed.stories||[]).filter(s=>s.region===r).length; if(n>5) errs.push(`${r}: ${n} stories (max 5)`); }
  if(ed.leadId && !ids.has(ed.leadId)) errs.push('leadId not found');
  return errs;
}

// ---------- templates ----------
const CSS = `
:root{--red:#C8102E;--ink:#111;--paper:#fff;--muted:#555;--rule:#e3e3e3;--soft:#f6f4f1}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit}img{max-width:100%;height:auto}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:9}
.mast{background:var(--red);color:#fff;border-bottom:4px solid var(--ink)}
.mast .wrap{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;padding-bottom:8px}
.logo{font:900 30px/1 "Arial Black","Helvetica Neue",Impact,sans-serif;letter-spacing:-1px;text-transform:uppercase;text-decoration:none;color:#fff}
.logo span{display:inline-block;background:#fff;color:var(--red);padding:0 5px;margin-left:4px;transform:skewX(-8deg)}
.tag{font-size:12px;line-height:1.2;font-weight:700;text-transform:uppercase;letter-spacing:.06em;text-align:right;opacity:.95}
.strap{background:var(--ink);color:#fff;font-size:13px;line-height:1.4}
.strap .wrap{display:flex;flex-wrap:wrap;gap:2px 14px;padding-top:7px;padding-bottom:7px}
.strap b{color:#fff}.strap .upd{color:#ddd}
nav.chips{border-bottom:1px solid var(--rule);background:#fff}
nav.chips .wrap{display:flex;gap:8px;overflow-x:auto;padding-top:10px;padding-bottom:10px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
nav.chips .wrap::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:2px solid var(--ink);border-radius:999px;font-weight:800;font-size:15px;text-decoration:none;background:#fff;color:var(--ink);cursor:pointer}
.chip[aria-pressed=true],.chip:active{background:var(--ink);color:#fff}
.chip.red{border-color:var(--red);color:var(--red)}
main{padding-bottom:40px}
.kicker{display:inline-block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--red)}
h2.sec{font:900 24px/1.1 "Arial Black","Helvetica Neue",Arial,sans-serif;text-transform:uppercase;letter-spacing:-.5px;margin:28px 0 4px;padding-top:10px;border-top:5px solid var(--ink);scroll-margin-top:8px}
h2.sec .count{font:700 13px/1 -apple-system,Arial,sans-serif;color:var(--muted);text-transform:none;letter-spacing:0;margin-left:6px}
.lead{margin:16px 0 8px;padding:0 0 4px}
.lead h1{font:900 30px/1.08 "Arial Black","Helvetica Neue",Arial,sans-serif;letter-spacing:-.8px;margin:6px 0 10px}
.lead .bar{height:6px;background:var(--red);width:64px;margin-bottom:10px}
.card{border-bottom:1px solid var(--rule);padding:16px 0;scroll-margin-top:8px}
.card h3{font:800 21px/1.22 -apple-system,"Helvetica Neue",Arial,sans-serif;margin:6px 0 8px;letter-spacing:-.2px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;color:var(--muted)}
.lab{display:inline-block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:4px}
.lab-fact{background:#111;color:#fff}.lab-alleg{background:#fde2e2;color:#8a0b0b;border:1px solid #e9a3a3}
.lab-op{background:#efe6ff;color:#3f1d7a}.lab-rep{background:#fff2cc;color:#6b4a00}
p{margin:0 0 10px}.why{background:var(--soft);border-left:4px solid var(--red);padding:8px 12px;margin:10px 0}
.why b{font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.note{font-size:15px;color:#333}.note b{color:#000}
.srcs{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:6px}
.srcs a{display:flex;flex-direction:column;justify-content:center;min-height:48px;padding:8px 12px;border:1px solid #ccc;border-radius:8px;text-decoration:none;background:#fff}
.srcs a:active{background:var(--soft)}
.srcs .t{font-weight:700;font-size:15px;line-height:1.3;text-decoration:underline;text-decoration-color:#bbb}
.srcs .s{font-size:13px;color:var(--muted)}
.latest{list-style:none;padding:0;margin:8px 0 0}
.latest li{border-bottom:1px solid var(--rule)}
.latest a{display:block;padding:10px 0;min-height:44px;text-decoration:none}
.latest .h{font-weight:700;line-height:1.3}.latest .m{font-size:13px;color:var(--muted)}
.tools{margin:18px 0 0;border:2px solid var(--ink);border-radius:10px;padding:12px;display:none}
.js .tools{display:block}
.tools label{display:block;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px}
.tools input,.tools select{width:100%;min-height:48px;font-size:17px;padding:8px 12px;border:1px solid #999;border-radius:8px;background:#fff;color:var(--ink)}
.tools .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.tools .status{font-size:14px;color:var(--muted);margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.btn{min-height:44px;padding:0 16px;border-radius:8px;border:2px solid var(--ink);background:#fff;font-weight:800;font-size:15px;cursor:pointer;color:var(--ink)}
.hidden{display:none!important}
.empty{padding:16px;background:var(--soft);border-radius:8px;margin-top:12px}
.arch{list-style:none;padding:0;margin:8px 0}
.arch a{display:flex;flex-direction:column;justify-content:center;min-height:56px;padding:10px 12px;border:2px solid var(--ink);border-radius:8px;text-decoration:none;margin-bottom:8px}
.arch .t{font-weight:800}.arch .s{font-size:13px;color:var(--muted)}
details.guide{margin-top:24px;border-top:1px solid var(--rule);padding-top:8px}
details.guide summary{min-height:44px;display:flex;align-items:center;font-weight:800;cursor:pointer}
.banner{background:#fff2cc;border:1px solid #e6c766;padding:10px 12px;border-radius:8px;margin-top:14px;font-size:15px}
.banner a{font-weight:800}
footer{border-top:5px solid var(--ink);padding:16px 0 40px;font-size:13px;color:var(--muted)}
.blk h3{font:800 20px/1.25 -apple-system,Arial,sans-serif;margin:18px 0 8px}
dl.props{margin:0}dl.props dt{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--red);margin-top:10px}dl.props dd{margin:2px 0 0}
.rows{list-style:none;padding:0;margin:0}.rows li{border-bottom:1px solid var(--rule);padding:10px 0}.rows .h{font-weight:700}.rows .m{font-size:13px;color:var(--muted)}
.callout{background:var(--soft);border-left:4px solid var(--red);padding:10px 12px;margin:8px 0}
@media (min-width:760px){body{font-size:17px}.logo{font-size:44px}.lead h1{font-size:42px}.card h3{font-size:23px}.srcs{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const JS = `
(function(){document.documentElement.classList.add('js');
var q=document.getElementById('q'),r=document.getElementById('fr'),t=document.getElementById('ft'),st=document.getElementById('fstatus'),clr=document.getElementById('fclear'),em=document.getElementById('fempty');
if(!q)return;var cards=[].slice.call(document.querySelectorAll('[data-story]'));var secs=[].slice.call(document.querySelectorAll('[data-region-sec]'));
var chips=[].slice.call(document.querySelectorAll('[data-chip]'));var lat=[].slice.call(document.querySelectorAll('[data-latest]'));
function apply(){var qs=q.value.trim().toLowerCase(),rv=r.value,tv=t.value,n=0;
cards.forEach(function(c){var ok=(rv==='all'||c.dataset.region===rv)&&(tv==='all'||c.dataset.topic===tv)&&(!qs||c.textContent.toLowerCase().indexOf(qs)>-1);c.classList.toggle('hidden',!ok);if(ok)n++;});
lat.forEach(function(l){var c=document.getElementById(l.dataset.latest);l.classList.toggle('hidden',c&&c.classList.contains('hidden'));});
secs.forEach(function(s){var vis=s.querySelectorAll('[data-story]:not(.hidden)').length;s.classList.toggle('hidden',vis===0);});
chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.chip===rv));});
var on=rv!=='all'||tv!=='all'||qs;st.firstChild.textContent=on?('Showing '+n+' of '+cards.length+' stories'):(cards.length+' stories in this edition');clr.classList.toggle('hidden',!on);em.classList.toggle('hidden',n>0);
try{var u=new URL(location.href);['region','topic','q'].forEach(function(k){u.searchParams.delete(k)});if(rv!=='all')u.searchParams.set('region',rv);if(tv!=='all')u.searchParams.set('topic',tv);if(qs)u.searchParams.set('q',q.value.trim());history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
q.addEventListener('input',apply);r.addEventListener('change',apply);t.addEventListener('change',apply);
clr.addEventListener('click',function(){q.value='';r.value='all';t.value='all';apply();});
chips.forEach(function(c){c.addEventListener('click',function(e){var v=c.dataset.chip;if(r.value===v){r.value='all';}else{r.value=v;}apply();if(r.value!=='all'){e.preventDefault();var s=document.getElementById('region-'+v);if(s)s.scrollIntoView();}else{e.preventDefault();}});});
var p=new URLSearchParams(location.search);if(p.get('region'))r.value=p.get('region');if(p.get('topic'))t.value=p.get('topic');if(p.get('q'))q.value=p.get('q');apply();})();
`;

const srcList = srcs => `<ul class="srcs">${srcs.map(l=>`<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc(l.title)}</span><span class="s">${esc(l.site)}${l.date?' · '+esc(l.date):''} ↗</span></a></li>`).join('')}</ul>`;

function storyCard(s, lead=false){
  const meta = `<div class="meta"><span class="lab ${labelClass(s.label)}">${esc(s.label)}</span><span>${esc(SHORT[s.region])} · ${esc(TOPICS[s.topic])}</span><span>${esc(s.dateLabel)}</span></div>`;
  const body = `<p>${esc(s.summary)}</p><div class="why"><b>Why it matters</b><br>${esc(s.why)}</div>${s.note?`<p class="note"><b>Note:</b> ${esc(s.note)}</p>`:''}${srcList(s.sources)}`;
  if(lead) return `<article class="lead card" id="${esc(s.id)}" data-story data-region="${s.region}" data-topic="${s.topic}"><div class="bar"></div><span class="kicker">Lead story · ${esc(REGIONS[s.region])}</span><h1>${esc(s.headline)}</h1>${meta}<div style="height:10px"></div>${body}</article>`;
  return `<article class="card" id="${esc(s.id)}" data-story data-region="${s.region}" data-topic="${s.topic}">${meta}<h3>${esc(s.headline)}</h3>${body}</article>`;
}

function head(title, desc, rel){ return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#C8102E"><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23C8102E'/%3E%3Ctext x='32' y='46' font-size='40' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='%23fff'%3ED%3C/text%3E%3C/svg%3E"><style>${CSS}</style></head><body><a class="skip" href="#main">Skip to stories</a>`; }
function mast(rel, strapHtml){ return `<header class="mast"><div class="wrap"><a class="logo" href="${rel}index.html">Donna<span>Daily</span></a><div class="tag">US · Canada<br>HK · China · World</div></div></header><div class="strap"><div class="wrap">${strapHtml}</div></div>`; }
const foot = (rel, upd) => `<footer><div class="wrap"><p><b>Donna Daily</b> is a personal news digest for Derek, compiled by Donna (Grok Bot). Summaries are original; follow the source links for full reporting. Some sources (e.g. SCMP) may be paywalled.</p><p>Last successful update: ${esc(upd)}. <a href="${rel}editions/index.html">Past editions</a></p></div></footer>`;

function renderEdition(ed, {rel, isCurrent, upd, archiveList, currentHref}){
  const stories = ed.stories; const lead = stories.find(s=>s.id===ed.leadId) || stories[0];
  const latest = [...stories].sort((a,b)=>a.ts<b.ts?1:-1).slice(0,6);
  const chips = Object.keys(REGIONS).map(r=>`<a class="chip" href="#region-${r}" data-chip="${r}" aria-pressed="false">${esc(SHORT[r])}</a>`).join('') + `<a class="chip red" href="${rel}editions/index.html">Past editions</a>`;
  const regionSecs = Object.keys(REGIONS).map(r=>{ const items=stories.filter(s=>s.region===r&&s.id!==lead.id); const total=stories.filter(s=>s.region===r).length;
    return `<section data-region-sec id="region-${r}"><h2 class="sec">${esc(REGIONS[r])}<span class="count">${total} ${total===1?'story':'stories'}${lead.region===r?' incl. lead':''}</span></h2>${items.map(s=>storyCard(s)).join('')}</section>`; }).join('');
  const strap = `<b>${esc(ed.title)} · ${esc(fmtDate(ed.date))}</b><span class="upd">Last successful update: ${esc(upd)}</span>`;
  return head(`Donna Daily — ${ed.title}, ${fmtDate(ed.date)}`, 'Verified US, Canada, Hong Kong, China and world news, labelled fact, allegation or opinion.', rel) + mast(rel, strap) +
  `<nav class="chips" aria-label="Regions"><div class="wrap">${chips}</div></nav><main id="main"><div class="wrap">` +
  (isCurrent?'':`<div class="banner">You're reading an archived edition. <a href="${currentHref}">Go to today's edition →</a></div>`) +
  (ed.notes?.length?`<p class="note" style="margin-top:12px">${ed.notes.map(esc).join(' ')}</p>`:'') +
  `<section data-region-sec id="lead-sec">${storyCard(lead,true)}</section>` +
  `<form class="tools" role="search" onsubmit="return false"><label for="q">Search this edition</label><input id="q" type="search" placeholder="e.g. election, Cohere, Tai Po" autocomplete="off"><div class="row"><div><label for="fr">Region</label><select id="fr"><option value="all">All regions</option>${Object.entries(REGIONS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></div><div><label for="ft">Topic</label><select id="ft"><option value="all">All topics</option>${Object.entries(TOPICS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></div></div><div class="status" id="fstatus"><span></span><button type="button" class="btn hidden" id="fclear">Clear filters</button></div></form>` +
  `<div class="empty hidden" id="fempty">No stories match. Try another word or clear the filters.</div>` +
  `<section id="latest"><h2 class="sec">Latest</h2><ul class="latest">${latest.map(s=>`<li data-latest="${esc(s.id)}"><a href="#${esc(s.id)}"><div class="h">${esc(s.headline)}</div><div class="m">${esc(SHORT[s.region])} · ${esc(s.dateLabel)} · ${esc(s.label)}</div></a></li>`).join('')}</ul></section>` +
  regionSecs +
  `<section id="archive"><h2 class="sec">Past editions</h2><ul class="arch">${archiveList}</ul></section>` +
  `<details class="guide"><summary>How to read the labels</summary><p><span class="lab lab-fact">Fact</span> Reported and confirmed by the linked sources.</p><p><span class="lab lab-alleg">Allegation</span> Claimed, charged or argued in court; not proven.</p><p><span class="lab lab-op">Opinion / analysis</span> Someone's view or interpretation, marked as such.</p><p><span class="lab lab-rep">Reported / state media</span> Based on unnamed sources or a single state-media outlet.</p><p>Every source link was opened and its date checked when the edition was built. No images are shown unless their licence allows it.</p></details>` +
  `</div></main>` + foot(rel, upd) + `<script>${JS}</script></body></html>`;
}

function renderBlocks(nodes, depth=0){
  return nodes.map(n=>{ if(typeof n==='string') return esc(n); const p=n.props||{};
    switch(n.type){
      case 'Section': return depth===0 ? `<section id="${esc(p.id||'')}"><h2 class="sec">${esc(p.heading)}</h2>${renderBlocks(n.children,1)}</section>` : `<div class="blk"><h3>${esc(p.heading)}</h3>${renderBlocks(n.children,depth+1)}</div>`;
      case 'Properties': return `<dl class="props">${p.items.map(i=>`<dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd>`).join('')}</dl>`;
      case 'Rows': return `<ul class="rows">${p.rows.map(r=>`<li><div class="h">${esc(r.title)}</div><div>${esc(r.detail||'')}</div><div class="m">${esc(r.meta||'')}</div></li>`).join('')}</ul>`;
      case 'LinkCards': return srcList(p.links);
      case 'NumberedList': return `<ol>${p.items.map(i=>`<li>${esc(i)}</li>`).join('')}</ol>`;
      case 'BulletList': return `<ul>${p.items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`;
      case 'Callout': return `<div class="callout"><b>${esc(p.lead||'')}</b> ${renderBlocks(n.children,depth+1)}</div>`;
      case 'Text': return `<p>${renderBlocks(n.children,depth+1)}</p>`;
      default: return renderBlocks(n.children||[],depth+1);
    }}).join('');
}
function renderArchive(ed, {upd, currentHref}){
  const rel='../';
  const strap = `<b>Archive · ${esc(ed.title)} · ${esc(fmtDate(ed.date))}</b><span class="upd">Originally published: ${esc(ed.updatedLabel)}</span>`;
  return head(`Donna Daily archive — ${ed.title}, ${fmtDate(ed.date)}`, ed.summary||'', rel) + mast(rel, strap) +
  `<nav class="chips" aria-label="Edition"><div class="wrap"><a class="chip" href="${currentHref}">Today's edition</a><a class="chip red" href="index.html">All past editions</a></div></nav><main id="main"><div class="wrap">` +
  `<div class="banner">Archived brief, kept as originally published (snapshot; not updated). <a href="${currentHref}">Go to today's edition →</a>${ed.droppedSections?.length?' A personal travel note was removed from this public copy.':''}</div>` +
  `<p style="margin-top:12px">${esc(ed.summary)}</p>` + renderBlocks(ed.blocks) + `</div></main>` + foot(rel, upd) + `</body></html>`;
}

// ---------- main ----------
const eds = fs.readdirSync(path.join(DATA,'editions')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(DATA,'editions',f),'utf8')));
let errors=[]; for(const e of eds) for(const x of validate(e)) errors.push(`${e.id}: ${x}`);
if(errors.length){ console.error('BUILD FAILED — previous site left unchanged:\n'+errors.join('\n')); process.exit(1); }
const editions = eds.filter(e=>e.kind==='edition').sort((a,b)=>a.id<b.id?1:-1);
const archives = eds.filter(e=>e.kind==='archive').sort((a,b)=>a.id<b.id?1:-1);
if(!editions.length){ console.error('BUILD FAILED: no edition'); process.exit(1); }
const current = editions[0];
const upd = nyNow();
const allPast = [...editions.slice(1), ...archives].sort((a,b)=>a.date<b.date||(a.date===b.date&&a.id<b.id)?1:-1);
const archLi = (relE) => allPast.length? allPast.map(e=>`<li><a href="${relE}${e.id}.html"><span class="t">${esc(e.title)} — ${esc(fmtDate(e.date))}</span><span class="s">${e.kind==='archive'?'Earlier brief (snapshot)':`${e.stories.length} stories`}</span></a></li>`).join('') : '<li>No past editions yet.</li>';

fs.rmSync(TMP,{recursive:true,force:true}); fs.mkdirSync(path.join(TMP,'editions'),{recursive:true});
fs.writeFileSync(path.join(TMP,'index.html'), renderEdition(current,{rel:'',isCurrent:true,upd,archiveList:archLi('editions/')}));
for(const e of editions) fs.writeFileSync(path.join(TMP,'editions',e.id+'.html'), renderEdition(e,{rel:'../',isCurrent:false,upd,archiveList:archLi(''),currentHref:'../index.html'}));
for(const a of archives) fs.writeFileSync(path.join(TMP,'editions',a.id+'.html'), renderArchive(a,{upd,currentHref:'../index.html'}));
fs.writeFileSync(path.join(TMP,'editions','index.html'), head('Donna Daily — Past editions','Archive of Donna Daily editions','../') + mast('../', `<b>Past editions</b><span class="upd">Last successful update: ${esc(upd)}</span>`) + `<nav class="chips"><div class="wrap"><a class="chip" href="../index.html">Today's edition</a></div></nav><main id="main"><div class="wrap"><h2 class="sec">Today</h2><ul class="arch"><li><a href="../index.html"><span class="t">${esc(current.title)} — ${esc(fmtDate(current.date))}</span><span class="s">${current.stories.length} stories · current</span></a></li></ul><h2 class="sec">Earlier</h2><ul class="arch">${archLi('')}</ul></div></main>` + foot('../',upd) + `</body></html>`);
fs.writeFileSync(path.join(TMP,'data.json'), JSON.stringify({current: current.id, lastSuccessfulUpdate: upd, editions: editions.map(e=>({id:e.id,date:e.date,title:e.title,stories:e.stories})), archives: archives.map(a=>({id:a.id,date:a.date,title:a.title}))}));
fs.writeFileSync(path.join(TMP,'.nojekyll'),'');
// atomic-ish swap
const OLD = OUT+'-old'; fs.rmSync(OLD,{recursive:true,force:true});
if(fs.existsSync(OUT)) fs.renameSync(OUT, OLD);
fs.renameSync(TMP, OUT); fs.rmSync(OLD,{recursive:true,force:true});
fs.writeFileSync(path.join(DATA,'state.json'), JSON.stringify({lastSuccessfulBuild: upd, current: current.id, builtAtUTC: new Date().toISOString()},null,1));
const counts = Object.keys(REGIONS).map(r=>`${r}:${current.stories.filter(s=>s.region===r).length}`).join(' ');
console.log(`BUILD OK ${current.id} (${counts}) — ${upd}`);
