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

// ---------- labels: describe the TYPE of claim, not a verification grade ----------
// New editions write `label` as one or more of the canonical labels joined with " + ", e.g. "Reported + official statement".
// Older editions used "Fact", "Fact (state media)", "Fact + allegation"… — those are mapped here so every archived edition renders.
const LABELS = {
  rep:   {text:'Reported',           cls:'lab-rep',   desc:'Reported by the linked news outlets; attributed to them, not independently confirmed by Donna Daily.'},
  off:   {text:'Official statement', cls:'lab-off',   desc:"A government, official body or company's own statement, figures or proposal, attributed to it."},
  claim: {text:'Claim',              cls:'lab-claim', desc:"An assertion by a person, government or group that hasn't been independently confirmed."},
  alleg: {text:'Allegation',         cls:'lab-alleg', desc:'Claimed, charged or argued in court; not proven.'},
  op:    {text:'Analysis',           cls:'lab-op',    desc:"Interpretation or opinion — the outlet's, an expert's, or Donna Daily's own — marked as such."},
  unn:   {text:'Unnamed sources',    cls:'lab-unn',   desc:'Rests partly on sources the outlet did not name.'},
  sm:    {text:'State media',        cls:'lab-sm',    desc:'Relies on state-controlled media (e.g. Xinhua, CCTV, Russian state media).'},
  ov:    {text:'Our view',           cls:'lab-ov',    desc:"Donna Daily's own analysis and argument, kept separate from news reporting; it draws on the linked sources and sets out more than one side. Used in special editions."},
};
const DAILY_LABELS = Object.fromEntries(Object.entries(LABELS).filter(([k])=>k!=='ov'));
function labelParts(label){
  const out=[]; const add=(k,text)=>{ if(!out.some(o=>o.k===k&&o.text===(text||LABELS[k].text))) out.push({k,text:text||LABELS[k].text}); };
  for(let p of String(label||'').split('+')){ p=p.trim().toLowerCase(); if(!p) continue;
    const hit=[];
    if(/our view/.test(p)) { add('ov'); continue; }
    if(/allegation/.test(p)) hit.push(['alleg']);
    if(/opinion/.test(p)) hit.push(['op','Opinion']); else if(/analysis/.test(p)) hit.push(['op']);
    if(/unnamed/.test(p)) hit.push(['unn']);
    if(/state media/.test(p)) hit.push(['sm']);
    if(/government statement|official statement|^official$/.test(p)) hit.push(['off']);
    else if(/government figures|official figures/.test(p)) hit.push(['off','Official figures']);
    else if(/company figures/.test(p)) hit.push(['off','Company figures']);
    else if(/industry figures/.test(p)) hit.push(['off','Industry figures']);
    else if(/proposal/.test(p)) hit.push(['off','Official proposal']);
    else if(/forecast/.test(p)) hit.push(['off','Official forecast']);
    if(/\bclaim/.test(p)) hit.push(['claim']);
    if(/preliminary/.test(p)) hit.push(['rep','Reported (preliminary)']);
    if(!hit.length && /^(fact|reported)\b/.test(p)) hit.push(['rep']);
    if(!hit.length) hit.push(['rep', p.replace(/^./,c=>c.toUpperCase())]);
    for(const [k,t] of hit) add(k,t);
  }
  return out.length?out:[{k:'rep',text:'Reported'}];
}
const badges = label => labelParts(label).map(b=>`<span class="lab ${LABELS[b.k].cls}" title="${esc(LABELS[b.k].desc)}">${esc(b.text)}</span>`).join('');
const labelText = label => labelParts(label).map(b=>b.text).join(' · ');

// Remove blanket "every source/story was checked" production copy from older editions at render time
// (archived JSON stays as published; the provenance section says what was actually checked).
function deblanket(t){
  let s=String(t??'');
  s=s.replace(/,? with every source re-?checked/gi,'');
  s=s.replace(/\s*Every (?:source and date|story|source) was (?:opened and checked|re-?checked|checked at the source|read at the source|read on its source page)(?: this (?:morning|evening)| on [A-Z][a-z]{2} \d{1,2})?(, and conflicting reports are flagged)?[;.]\s*([a-z])?/g,
    (m,conf,nx)=> ' '+(conf?'Conflicting reports are flagged. ':'')+(nx?nx.toUpperCase():''));
  s=s.replace(/\s{2,}/g,' ').trim();
  return s;
}

// Front-page deck: an explicit story.deck, else the first one or two sentences of the summary. The rest goes in "Read more".
function splitDeck(s){
  if(s.deck) return [s.deck, s.summary];
  const sents=String(s.summary).split(/(?<=[.!?][’'"”)]?)\s+(?=[A-Z‘“"'(])/);
  let deck=sents[0], i=1;
  if(i<sents.length && (deck.length<90 || (deck.length<170 && (deck+' '+sents[i]).length<=280))){ deck+=' '+sents[i]; i++; }
  return [deck, sents.slice(i).join(' ')];
}
const isoOk = v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(v);
const nyTime = iso => new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});

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
    if(s.image) for(const x of validateImage(s.image)) errs.push(`${s.id}: image ${x}`);
    if(s.deck!==undefined && (typeof s.deck!=='string'||!s.deck.trim())) errs.push(`${s.id}: deck must be a non-empty string`);
    for(const c of s.sourceChecks||[]){
      if(!/^https:\/\//.test(c.url||'')) errs.push(`${s.id}: sourceCheck url not https`);
      if(!c.checkedBy) errs.push(`${s.id}: sourceCheck missing checkedBy`);
      if(c.checkedAt!==undefined && !isoOk(c.checkedAt)) errs.push(`${s.id}: sourceCheck checkedAt must be ISO time with offset (${c.checkedAt})`);
      for(const k of ['claimsSupported','limits']) if(c[k]!==undefined && !(Array.isArray(c[k])&&c[k].every(x=>typeof x==='string'))) errs.push(`${s.id}: sourceCheck ${k} must be a list of strings`);
    }
  }
  if(ed.provenance!==undefined && !(Array.isArray(ed.provenance)&&ed.provenance.every(x=>typeof x==='string'))) errs.push('provenance must be a list of strings');
  for(const r of Object.keys(REGIONS)){ const n=(ed.stories||[]).filter(s=>s.region===r).length; if(n>5) errs.push(`${r}: ${n} stories (max 5)`); }
  if(ed.leadId && !ids.has(ed.leadId)) errs.push('leadId not found');
  return errs;
}

// Optional per-story photo. Only Wikimedia Commons CC0/PD/CC BY/CC BY-SA or US-government public-domain files (see README).
const IMG_DIR = path.join(DATA,'img');
const IMG_EXT = /\.(webp|jpe?g|png|avif)$/i;
function validateImage(im){
  const e=[];
  if(typeof im.src!=='string' || !/^img\/[A-Za-z0-9_\/.-]+$/.test(im.src) || im.src.includes('..') || !IMG_EXT.test(im.src)) e.push(`bad src ${im.src} (must be relative, e.g. img/<edition-id>/<story-id>.webp)`);
  else if(!fs.existsSync(path.join(DATA,im.src))) e.push(`file missing: data/${im.src}`);
  for(const k of ['alt','credit','license','licenseUrl','sourcePage']) if(!im[k]) e.push(`missing ${k}`);
  for(const k of ['licenseUrl','sourcePage']) if(im[k] && !/^https:\/\//.test(im[k])) e.push(`${k} not https`);
  if(!(im.width>0 && im.height>0)) e.push('missing width/height');
  if(typeof im.isFilePhoto!=='boolean') e.push('isFilePhoto must be true/false');
  if(!/^(CC0|Public domain|PD|CC BY(-SA)? \d)/i.test(im.license||'')) e.push(`license not allowed: ${im.license}`);
  return e;
}
function figure(im, rel, lead){
  if(!im) return '';
  const cap = `${im.isFilePhoto?'<b>File photo</b> · ':''}${im.caption?esc(im.caption)+' · ':''}Photo: <a href="${esc(im.sourcePage)}" target="_blank" rel="noopener noreferrer">${esc(im.credit)}</a> · <a href="${esc(im.licenseUrl)}" target="_blank" rel="noopener noreferrer license">${esc(im.license)}</a>`;
  return `<figure class="ph${lead?' ph-lead':''}"><img src="${esc(rel+im.src)}" width="${+im.width}" height="${+im.height}" alt="${esc(im.alt)}" decoding="async"${lead?' fetchpriority="high"':' loading="lazy"'}><figcaption>${cap}</figcaption></figure>`;
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
.spl{color:#fff;font-weight:700;text-decoration:underline;text-underline-offset:2px;display:inline-block;padding:13px 0;margin:-13px 0}
.mside .spl{display:block;margin:4px 0 0;padding:0}
nav.chips{border-bottom:1px solid var(--rule);background:#fff}
nav.chips .wrap{display:flex;flex-wrap:wrap;gap:8px;padding-top:10px;padding-bottom:10px}
.chip{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:44px;padding:0 16px;white-space:nowrap;border:2px solid var(--ink);border-radius:999px;font-weight:800;font-size:15px;text-decoration:none;background:#fff;color:var(--ink);cursor:pointer}
.chip[aria-pressed=true],.chip:active{background:var(--ink);color:#fff}
.chip[aria-pressed=true]{box-shadow:inset 0 -4px 0 var(--red)}
.chip .n{font-size:12px;font-weight:700;opacity:.75}
.chip .n0{opacity:.5}
/* phones: all five regions + Past editions in two tidy rows of three, no horizontal scrolling */
@media (max-width:759.98px){nav.chips .wrap{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
nav.chips .chip{padding:2px 4px;font-size:14.5px;min-width:0;white-space:normal;text-align:center;line-height:1.15}}
.chip.red{border-color:var(--red);color:var(--red)}
main{padding-bottom:40px}
.kicker{display:inline-block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--red)}
h2.sec{font:900 24px/1.1 "Arial Black","Helvetica Neue",Arial,sans-serif;text-transform:uppercase;letter-spacing:-.5px;margin:28px 0 4px;padding-top:10px;border-top:5px solid var(--ink);scroll-margin-top:8px}
h2.sec .count{font:700 13px/1 -apple-system,Arial,sans-serif;color:var(--muted);text-transform:none;letter-spacing:0;margin-left:6px}
.lead{margin:16px 0 8px;padding:0 0 4px}
.lead h1{font:900 25px/1.1 "Arial Black","Helvetica Neue",Arial,sans-serif;letter-spacing:-.8px;margin:6px 0 10px}
.lead .bar{height:6px;background:var(--red);width:64px;margin-bottom:10px}
.card{border-bottom:1px solid var(--rule);padding:16px 0;scroll-margin-top:8px}
.card h3{font:800 21px/1.22 -apple-system,"Helvetica Neue",Arial,sans-serif;margin:6px 0 8px;letter-spacing:-.2px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;color:var(--muted)}
.lab{display:inline-block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:4px}
.lab-rep{background:#fff;color:#111;border:1px solid #111}.lab-off{background:#e3eefc;color:#0b3b78;border:1px solid #9dbbe6}
.lab-claim{background:#ffe9d6;color:#7a3300;border:1px solid #f0b182}.lab-alleg{background:#fde2e2;color:#8a0b0b;border:1px solid #e9a3a3}
.lab-op{background:#efe6ff;color:#3f1d7a;border:1px solid #cdb8f0}.lab-unn{background:#fff2cc;color:#6b4a00;border:1px solid #e6c766}.lab-sm{background:#f1f1f1;color:#333;border:1px dashed #777}
.deck{font-size:17px}.lead .deck{font-size:17px;line-height:1.5;margin-bottom:12px}
.lead .meta{margin:0 0 8px}
details.more{margin:8px 0 0}
details.more>summary{display:flex;align-items:center;min-height:44px;font-weight:800;font-size:15px;cursor:pointer;color:var(--red);list-style:none}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:before{content:"+";display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:2px solid currentColor;border-radius:50%;margin-right:8px;font-size:16px;line-height:1}
details.more[open]>summary:before{content:"−"}
details.more>summary .c{color:var(--muted);font-weight:600;margin-left:4px}
details.more h4{font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin:12px 0 4px}
.chk{list-style:none;margin:4px 0 2px;padding:0 0 0 12px;border-left:3px solid var(--rule);font-size:13px;line-height:1.45;color:#333}
.chk li{margin:2px 0}.chk .lim{color:#7a3300}
details.about,details.guide{margin-top:24px;border-top:1px solid var(--rule);padding-top:8px}
details.about>summary,details.guide>summary{min-height:44px;display:flex;align-items:center;font-weight:800;cursor:pointer}
details.about h3{font-size:16px;margin:14px 0 6px}
details.about ul{padding-left:20px;font-size:15px}details.about li{margin:4px 0}
details.tools{margin:12px 0 0;border:2px solid var(--ink);border-radius:10px;padding:0 12px}
details.tools>summary{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;font-weight:800;font-size:15px;cursor:pointer;list-style:none}
details.tools>summary::-webkit-details-marker{display:none}
details.tools>summary .st{font-weight:600;color:var(--muted);font-size:14px;text-align:right}
details.tools>summary:after{content:"▾";font-size:14px}details.tools[open]>summary:after{content:"▴"}
details.tools form{padding:0 0 12px}
.empty .btn{margin-top:10px}
.totop{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:30;display:none;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;background:var(--ink);color:#fff;font-weight:800;font-size:14px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.js .totop.show{display:inline-flex}
p{margin:0 0 10px}.why{background:var(--soft);border-left:4px solid var(--red);padding:8px 12px;margin:10px 0}
.why b{font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.note,.srcnote{font-size:15px;color:#333}.note b{color:#000}
.srcs{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:6px}
.srcs a{display:flex;flex-direction:column;justify-content:center;min-height:48px;padding:8px 12px;border:1px solid #ccc;border-radius:8px;text-decoration:none;background:#fff}
.srcs a:active{background:var(--soft)}
.srcs .t{font-weight:700;font-size:15px;line-height:1.3;text-decoration:underline;text-decoration-color:#bbb}
.srcs .s{font-size:13px;color:var(--muted)}
.latest{list-style:none;padding:0;margin:8px 0 0}
.latest li{border-bottom:1px solid var(--rule)}
.latest a{display:block;padding:10px 0;min-height:44px;text-decoration:none}
.latest .h{font-weight:700;line-height:1.3}.latest .m{font-size:13px;color:var(--muted)}
.tools{display:none}
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
.banner{background:#fff2cc;border:1px solid #e6c766;padding:10px 12px;border-radius:8px;margin-top:14px;font-size:15px}
.banner a{font-weight:800}
.spb{display:flex;flex-direction:column;gap:2px;min-height:44px;margin:12px 0 0;padding:9px 12px;background:var(--ink);color:#fff;text-decoration:none;border-left:6px solid var(--red);border-radius:6px}
.spb .k{font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#ffb3bf}
.spb .h{font-weight:800;font-size:16px;line-height:1.25}.spb .h:after{content:" →"}
.spb .s{font-size:13px;color:#ddd;line-height:1.35}
@media (max-width:759.98px){.spb .s{display:none}}
@media (min-width:1024px){.spb{flex-direction:row;align-items:baseline;gap:14px;padding:12px 18px;margin-top:20px;border-radius:0}.spb .h{font-size:20px}.spb .s{font-size:14px}.spb:hover .h{text-decoration:underline}}
footer{border-top:5px solid var(--ink);padding:16px 0 40px;font-size:13px;color:var(--muted)}
.blk h3{font:800 20px/1.25 -apple-system,Arial,sans-serif;margin:18px 0 8px}
dl.props{margin:0}dl.props dt{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--red);margin-top:10px}dl.props dd{margin:2px 0 0}
.rows{list-style:none;padding:0;margin:0}.rows li{border-bottom:1px solid var(--rule);padding:10px 0}.rows .h{font-weight:700}.rows .m{font-size:13px;color:var(--muted)}
.ph{margin:0 0 10px;max-width:100%}
.ph img{display:block;width:100%;max-width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:#ddd;border-bottom:4px solid var(--red)}
.ph-lead{margin:0 -16px 12px}.ph-lead img{border-bottom-width:6px}
.ph figcaption{font-size:11.5px;line-height:1.35;color:var(--muted);padding:4px 0 0}
.ph-lead figcaption{padding:5px 16px 0}
.ph figcaption b{color:var(--red);text-transform:uppercase;letter-spacing:.05em;font-size:11px}
.ph figcaption a{display:inline-block;padding:14px 0;margin:-14px 0;color:var(--muted)}
.callout{background:var(--soft);border-left:4px solid var(--red);padding:10px 12px;margin:8px 0}
/* ---- tablet (760-1023px): two-column story grids. Phones (<760px) are untouched by everything below. ---- */
@media (min-width:760px){.ph-lead{margin:0 0 12px}.ph-lead figcaption{padding:5px 0 0}}
@media (min-width:760px){body{font-size:17px}.logo{font-size:44px}.lead h1{font-size:42px}.card h3{font-size:23px}.srcs{grid-template-columns:1fr 1fr}}
@media (min-width:760px) and (max-width:1023.98px){
section[data-region-sec]:not(#lead-sec){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px;align-items:start}
section[data-region-sec]>h2.sec{grid-column:1/-1}
section[data-region-sec]:not(#lead-sec)>.card .srcs{grid-template-columns:1fr}
.arch{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}}
/* ---- desktop (>=1024px): tabloid front page ---- */
.dt-only{display:none}
@media (min-width:1024px){
:root{--disp:Impact,Anton,"Haettenschweiler","Arial Narrow Bold","Oswald","Arial Black",sans-serif}
.dt-only{display:revert}.m-only{display:none}.chip.dt-only{display:inline-flex}
body{background:#fff}
.wrap{max-width:1264px;padding:0 32px}
main .wrap.read{max-width:920px}
main>.wrap>.note:first-child,main>.wrap>.banner+.note{font-size:14px;color:var(--muted)}
.mast{border-bottom:0;background:var(--red);background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(0,0,0,.08))}
.mast .wrap{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:24px;padding-top:18px;padding-bottom:16px}
.mside{font-size:13px;line-height:1.45;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.mside b{display:block;font-size:15px;letter-spacing:.04em}.mside .upd{display:block;opacity:.9;font-weight:600}
.logo{font-size:82px;letter-spacing:-3px;line-height:.95;text-align:center;white-space:nowrap;text-shadow:0 3px 0 rgba(0,0,0,.18)}
.logo span{padding:0 10px;margin-left:8px;text-shadow:none}
.logo:hover span{background:var(--ink);color:#fff}
.tag{font-size:13px;line-height:1.45}.tag:after{content:"Sourced · Linked · Labelled";display:block;opacity:.85;font-weight:600;margin-top:2px}
.strap{display:none}
nav.chips{position:sticky;top:0;z-index:20;background:var(--ink);border-bottom:5px solid var(--red);box-shadow:0 2px 8px rgba(0,0,0,.18)}
nav.chips .wrap{display:flex;gap:0;padding-top:0;padding-bottom:0;flex-wrap:nowrap}
.totop{display:none!important}
.chip{min-height:50px;padding:0 20px;border:0;border-radius:0;background:transparent;color:#fff;font:800 15px/1 -apple-system,"Helvetica Neue",Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em}
.chip:hover,.chip:focus-visible,.chip[aria-pressed=true]{background:var(--red);color:#fff;box-shadow:none}
.chip .n{font-size:11px}
.chip:active{background:#8f0b20}
.chip.red{color:#fff;margin-left:auto;background:#2a2a2a}.chip.red:hover{background:var(--red)}
h2.sec{font:400 32px/1 var(--disp);text-transform:uppercase;letter-spacing:.5px;margin:40px 0 14px;padding:0 0 8px;border-top:0;border-bottom:4px solid var(--red);display:flex;align-items:center;scroll-margin-top:70px}
h2.sec:before{content:"";flex:0 0 auto;width:12px;height:26px;background:var(--red);margin-right:10px}
h2.sec .count{margin-left:auto;font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.card{scroll-margin-top:70px}
.banner{margin-top:20px}
.top{display:grid;grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:auto 1fr;column-gap:36px;margin-top:24px;align-items:start}
.top>#lead-sec{grid-column:1;grid-row:1/span 2}
.top>.rail{grid-column:2;grid-row:1}
.top>#latest{grid-column:2;grid-row:2}
.lead{margin:0;padding:0;border-bottom:0;display:flex;flex-direction:column}
.lead>.kicker{order:-2;align-self:flex-start}.lead>h1{order:-1}.lead>.ph{margin-bottom:12px}
.lead .ph img{border-bottom-width:8px}
.lead .kicker{background:var(--red);color:#fff;padding:5px 9px;margin-top:4px}
.lead h1{font:400 44px/1.02 var(--disp);text-transform:uppercase;letter-spacing:.2px;margin:10px 0 14px;transition:color .15s}
.lead:hover h1{color:var(--red)}
.lead>p{font-size:18px;line-height:1.6}
.rail h2.sec,#latest h2.sec{margin-top:0;font-size:26px}
.rail ol{list-style:none;margin:0;padding:0}
.rail li{border-bottom:1px solid var(--rule)}.rail li:last-child{border-bottom:0}
.rail a{display:grid;grid-template-columns:128px 1fr;gap:12px;padding:10px 0;text-decoration:none;align-items:start}
.rail .th{display:block;width:128px;height:72px;object-fit:cover;background:#ddd;border-bottom:3px solid var(--red)}
.rail .nt{display:flex;align-items:center;justify-content:center;width:128px;height:72px;background:var(--ink);color:#fff;font:400 30px/1 var(--disp);border-bottom:3px solid var(--red)}
.rail .k{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--red);margin-bottom:3px}
.rail .h{display:block;font-weight:800;font-size:16px;line-height:1.25}
.rail .pc{font-size:11px;color:var(--muted);margin:4px 0 0}
.rail a:hover .h,.latest a:hover .h{color:var(--red);text-decoration:underline;text-decoration-thickness:2px}
.rail a:hover .th{filter:saturate(1.2) brightness(1.05)}
#latest{margin-top:22px}
.latest{counter-reset:n;margin:0}
.latest li{counter-increment:n}
.latest a{display:grid;grid-template-columns:38px 1fr;column-gap:6px;padding:9px 0;min-height:0}
.latest a:before{content:counter(n);grid-row:1/span 2;font:400 30px/1 var(--disp);color:var(--red)}
.latest a>div{grid-column:2}.latest .h{font-size:16px;line-height:1.25}
details.tools{margin:20px 0 0;border:0;border-top:4px solid var(--ink);border-radius:0;background:var(--soft);padding:0 18px}
details.tools form{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:18px;align-items:end;padding:0 0 16px}
.tools form>label{grid-column:1;grid-row:1}.tools form>#q{grid-column:1;grid-row:2}
.tools .row{grid-column:2;grid-row:1/span 2;margin-top:0}
.tools .status{grid-column:3;grid-row:1/span 2;margin:0;align-self:end;min-height:48px}
section[data-region-sec]:not(#lead-sec){display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:28px;align-items:start;grid-auto-flow:row dense}
section[data-region-sec]>h2.sec{grid-column:1/-1}
section[data-region-sec]:not(#lead-sec)>.card{border-bottom:0;padding:0 0 30px}
section[data-region-sec]:not(#lead-sec)>.card:first-of-type{grid-column:span 2}
section[data-region-sec]:not(#lead-sec)>.card:first-of-type h3{font:400 36px/1.05 var(--disp);letter-spacing:.2px;text-transform:uppercase}
section[data-region-sec]:not(#lead-sec)>.card:first-of-type .ph img{border-bottom-width:6px}
section[data-region-sec]:not(#lead-sec)>.card h3{font-size:20px;line-height:1.22;transition:color .15s}
section[data-region-sec]:not(#lead-sec)>.card:hover h3{color:var(--red)}
.card .ph img{transition:filter .2s}.card:hover .ph img{filter:saturate(1.2) brightness(1.04)}
section[data-region-sec]:not(#lead-sec)>.card p{font-size:16px;line-height:1.5}
section[data-region-sec]:not(#lead-sec)>.card .why{font-size:15px;line-height:1.45}
section[data-region-sec]:not(#lead-sec)>.card .srcs,section[data-region-sec]:not(#lead-sec)>.card:first-of-type .srcs{grid-template-columns:1fr;gap:4px}
section[data-region-sec]:not(#lead-sec)>.card:first-of-type .srcs{grid-template-columns:1fr 1fr}
.card:not(.lead) .srcs a{min-height:36px;padding:6px 10px;border-radius:6px}
.card:not(.lead) .srcs .t{font-size:14px}.card:not(.lead) .srcs .s{font-size:12px}
.srcs a:hover{border-color:var(--red);background:#fff7f7}.srcs a:hover .t{color:var(--red)}
.ph figcaption{font-size:11px}
.arch{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.arch a{margin:0;transition:border-color .15s,color .15s}.arch a:hover{border-color:var(--red);color:var(--red)}
details.guide,details.about{max-width:860px}
footer{background:var(--ink);color:#c9c9c9;border-top:6px solid var(--red);margin-top:24px;padding:24px 0 48px}
footer b{color:#fff}footer a{color:#fff}footer a:hover{color:#ff8a9a}
}
@media (min-width:1200px){
section[data-region-sec]:not(#lead-sec){grid-template-columns:repeat(4,minmax(0,1fr))}
.lead h1{font-size:50px}
}
/* fill the last grid row so a section never ends with one lonely card (data-n = cards excluding the lead) */
@media (min-width:1024px) and (max-width:1199.98px){
.chip{padding:0 13px;font-size:14px;letter-spacing:.05em}
section[data-region-sec][data-n="1"]>.card:first-of-type,section[data-region-sec][data-n="3"]>.card:last-of-type,section[data-region-sec][data-n="5"]>.card:last-of-type{grid-column:1/-1}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph,section[data-region-sec][data-n="3"]>.card:last-of-type.has-ph,section[data-region-sec][data-n="5"]>.card:last-of-type.has-ph{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);column-gap:28px}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph>.ph,section[data-region-sec][data-n="3"]>.card:last-of-type.has-ph>.ph,section[data-region-sec][data-n="5"]>.card:last-of-type.has-ph>.ph{grid-column:1;grid-row:1/span 6;margin:0}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph>:not(.ph),section[data-region-sec][data-n="3"]>.card:last-of-type.has-ph>:not(.ph),section[data-region-sec][data-n="5"]>.card:last-of-type.has-ph>:not(.ph){grid-column:2}
}
@media (min-width:1200px){
section[data-region-sec][data-n="1"]>.card:first-of-type,section[data-region-sec][data-n="4"]>.card:last-of-type{grid-column:1/-1}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph,section[data-region-sec][data-n="4"]>.card:last-of-type.has-ph{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);column-gap:28px}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph>.ph,section[data-region-sec][data-n="4"]>.card:last-of-type.has-ph>.ph{grid-column:1;grid-row:1/span 6;margin:0}
section[data-region-sec][data-n="1"]>.card:first-of-type.has-ph>:not(.ph),section[data-region-sec][data-n="4"]>.card:last-of-type.has-ph>:not(.ph){grid-column:2}
section[data-region-sec][data-n="2"]>.card:first-of-type{grid-column:span 3}
section[data-region-sec][data-n="5"]>.card:nth-of-type(4),section[data-region-sec][data-n="5"]>.card:nth-of-type(5){grid-column:span 2}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const JS = `
(function(){var d=document;d.documentElement.classList.add('js');
var tt=d.getElementById('totop');if(tt){var onS=function(){tt.classList.toggle('show',(window.scrollY||d.documentElement.scrollTop)>700);};addEventListener('scroll',onS,{passive:true});onS();}
var q=d.getElementById('q'),r=d.getElementById('fr'),t=d.getElementById('ft'),st=d.getElementById('fsum'),clr=d.getElementById('fclear'),em=d.getElementById('fempty'),emt=d.getElementById('femptytxt'),rst=d.getElementById('freset'),tools=d.getElementById('ftools');
if(!q)return;
try{if(matchMedia('(min-width:1024px)').matches)tools.open=true;}catch(e){}
var A=function(s){return [].slice.call(d.querySelectorAll(s));};
var cards=A('[data-story]'),secs=A('[data-region-sec]'),chips=A('[data-chip]'),tch=A('[data-tchip]'),lat=A('[data-lat]'),railLi=A('[data-rail]'),latS=d.getElementById('latest'),rail=d.querySelector('.rail');
function hid(id){var c=d.getElementById(id);return !c||c.classList.contains('hidden');}
function apply(){var qs=q.value.trim().toLowerCase(),rv=r.value,tv=t.value,n=0;
cards.forEach(function(c){var ok=(rv==='all'||c.dataset.region===rv)&&(tv==='all'||c.dataset.topic===tv)&&(!qs||c.textContent.toLowerCase().indexOf(qs)>-1);c.classList.toggle('hidden',!ok);if(ok)n++;});
var k=0;lat.forEach(function(l){var ok=!hid(l.dataset.lat)&&k<6;if(ok)k++;l.classList.toggle('hidden',!ok);});if(latS)latS.classList.toggle('hidden',k===0);
var kr=0;railLi.forEach(function(l){var ok=!hid(l.dataset.rail);if(ok)kr++;l.classList.toggle('hidden',!ok);});if(rail)rail.classList.toggle('hidden',kr===0);
secs.forEach(function(s){var vis=s.querySelectorAll('[data-story]:not(.hidden)').length;s.classList.toggle('hidden',vis===0);});
chips.forEach(function(c){var on=c.dataset.chip===rv;c.setAttribute('aria-pressed',String(on));});tch.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.tchip===tv));});
var on=rv!=='all'||tv!=='all'||!!qs;st.textContent=on?('Showing '+n+' of '+cards.length):(cards.length+' stories');clr.classList.toggle('hidden',!on);
if(n===0){var to=t.options[t.selectedIndex];emt.textContent=(tv!=='all'&&to&&to.dataset.n==='0')?('No '+to.dataset.name+' stories in this edition.'+(rv!=='all'||qs?'':' Try another topic.')):('No stories match'+(qs?' \\u201c'+q.value.trim()+'\\u201d':'')+(rv!=='all'?' in '+r.options[r.selectedIndex].dataset.name:'')+(tv!=='all'?' in '+t.options[t.selectedIndex].dataset.name:'')+'. Try another word or show all stories.');}
em.classList.toggle('hidden',n>0);
try{var u=new URL(location.href);['region','topic','q'].forEach(function(x){u.searchParams.delete(x)});if(rv!=='all')u.searchParams.set('region',rv);if(tv!=='all')u.searchParams.set('topic',tv);if(qs)u.searchParams.set('q',q.value.trim());history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
function reset(){q.value='';r.value='all';t.value='all';apply();}
q.addEventListener('input',apply);r.addEventListener('change',apply);t.addEventListener('change',apply);
clr.addEventListener('click',reset);rst.addEventListener('click',function(){reset();var m=d.getElementById('main');if(m)m.scrollIntoView();});
chips.forEach(function(c){c.addEventListener('click',function(e){e.preventDefault();var v=c.dataset.chip;r.value=(r.value===v)?'all':v;apply();if(r.value!=='all'){var s=d.getElementById('region-'+v);if(s&&!s.classList.contains('hidden'))s.scrollIntoView();}});});
tch.forEach(function(c){c.addEventListener('click',function(e){e.preventDefault();t.value=t.value===c.dataset.tchip?'all':c.dataset.tchip;apply();if(t.value!=='all'){var f=d.querySelector('section[data-region-sec]:not(#lead-sec):not(.hidden)');if(f)f.scrollIntoView();}});});
var p=new URLSearchParams(location.search);if(p.get('region')&&r.querySelector('option[value="'+p.get('region')+'"]'))r.value=p.get('region');if(p.get('topic')&&t.querySelector('option[value="'+p.get('topic')+'"]'))t.value=p.get('topic');if(p.get('q'))q.value=p.get('q');apply();})();
`;

// ---------- sources & checks ----------
// checks: map url -> [{by, at?, ok:[], lim:[]}] built from story.sourceChecks and the automated link-check record (data/checks/<id>-links.json)
function chkLines(list){
  if(!list?.length) return '';
  return `<ul class="chk">${list.map(c=>c.auto
    ? `<li${c.ok?'':' class="lim"'}>${esc(c.result)} · automated link check${c.checkedAt?`, ${esc(nyTime(c.checkedAt))}`:''} (checks the link opens, not the claims)</li>`
    : `<li><b>${esc(c.checkedBy)}</b>${c.checkedAt?` (${esc(nyTime(c.checkedAt))})`:''}${c.claimsSupported?.length?`: supports — ${c.claimsSupported.map(esc).join('; ')}`:''}${c.limits?.length?`<span class="lim">${c.claimsSupported?.length?' · ':': '}Limit — ${c.limits.map(esc).join('; ')}</span>`:''}</li>`).join('')}</ul>`;
}
const srcList = (srcs, checks) => `<ul class="srcs">${srcs.map(l=>`<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc(l.title)}</span><span class="s">${esc(l.site)}${l.date?' · '+esc(l.date):''} ↗</span></a>${checks?chkLines(checks(l.href)):''}</li>`).join('')}</ul>`;

function storyCard(s, lead=false, rel='', checksFor=null){
  const meta = `<div class="meta">${badges(s.label)}<span>${esc(SHORT[s.region])} · ${esc(TOPICS[s.topic])}</span><span>${esc(s.dateLabel)}</span></div>`;
  const [deck, rest] = splitDeck(s);
  const n = s.sources.length;
  const why = `<div class="why"><b>Why it matters</b><br>${esc(s.why)}</div>`;
  const more = `<details class="more"><summary>Read more<span class="c">· ${rest?'full story & ':''}${n} source${n===1?'':'s'}</span></summary>${rest?`<p>${esc(rest)}</p>`:''}${s.note?`<p class="note"><b>Note:</b> ${esc(s.note)}</p>`:''}<h4>Sources &amp; checks</h4>${srcList(s.sources, checksFor?(u=>checksFor(s,u)):null)}</details>`;
  const ph = s.image ? ' has-ph' : '';
  const attrs = `id="${esc(s.id)}" data-story data-region="${s.region}" data-topic="${s.topic}"`;
  if(lead) return `<article class="lead card${ph}" ${attrs}><span class="kicker">Lead story · ${esc(REGIONS[s.region])}</span><h1>${esc(s.headline)}</h1>${meta}<p class="deck">${esc(deck)}</p>${s.image?figure(s.image,rel,true):'<div class="bar"></div>'}${why}${more}</article>`;
  return `<article class="card${ph}" ${attrs}>${figure(s.image,rel,false)}${meta}<h3>${esc(s.headline)}</h3><p class="deck">${esc(deck)}</p>${why}${more}</article>`;
}

function head(title, desc, rel){ return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#C8102E"><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23C8102E'/%3E%3Ctext x='32' y='46' font-size='40' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='%23fff'%3ED%3C/text%3E%3C/svg%3E"><style>${CSS}</style></head><body><a class="skip" href="#main">Skip to stories</a>`; }
function mast(rel, strapHtml){ return `<header class="mast"><div class="wrap"><div class="mside dt-only">${strapHtml}</div><a class="logo" href="${rel}index.html">Donna<span>Daily</span></a><div class="tag">US · Canada<br>HK · China · World</div></div></header><div class="strap"><div class="wrap">${strapHtml}</div></div>`; }
// section links for pages without the live filters (archive snapshot pages, past-editions list): wrap on phones, desktop nav on >=1024px
const dtNav = rel => Object.keys(REGIONS).map(r=>`<a class="chip" href="${rel}index.html?region=${r}#region-${r}">${esc(SHORT[r])}</a>`).join('') + `<a class="chip dt-only" href="${rel}index.html?topic=sports">Sports</a>`;
const foot = (rel, upd) => `<footer><div class="wrap"><p><b>Donna Daily</b> is a personal news digest for Derek, compiled by Donna (Grok Bot). Summaries are original; follow the source links for full reporting. Some sources (e.g. SCMP) may be paywalled.</p><p>Last successful update: ${esc(upd)}. <a href="${rel}editions/index.html">Past editions</a></p></div></footer>`;
const LEGEND = `<details class="guide"><summary>How to read the labels</summary>${Object.values(DAILY_LABELS).map(l=>`<p><span class="lab ${l.cls}">${esc(l.text)}</span> ${esc(l.desc)}</p>`).join('')}<p>Labels describe the type of claim a story rests on; they are not a verification grade. Older editions used “Fact”; it is shown as “Reported”. Photos are openly licensed (Wikimedia Commons CC0/public domain/CC BY/CC BY-SA, or US-government public domain), cropped to fit, and credited under each picture. “File photo” means the picture shows the person or place, not the event in the story.</p></details>`;
const SOURCING = `<p class="srcnote"><b>How this edition is sourced.</b> Stories are compiled from the linked sources and the summaries are original. Labels reflect the type of claim (reported by outlets, an official statement, a claim, an allegation or analysis); they are not a verification grade, and not every claim has been independently verified. Follow the links for full reporting.</p>`;

// Desktop-only "Top stories" rail: the first story of each region (lead excluded), with thumbnails. Hidden on phones
// (display:none + loading=lazy, so phones never download the thumbnails). Photos are credited on the full story below.
function rail(stories, lead, rel){
  const picks=[]; for(const r of Object.keys(REGIONS)){ const s=stories.find(x=>x.region===r&&x.id!==lead.id); if(s) picks.push(s); }
  for(const s of stories){ if(picks.length>=5) break; if(s.id!==lead.id && !picks.includes(s)) picks.push(s); }
  if(!picks.length) return '';
  const li = picks.slice(0,5).map(s=>`<li data-rail="${esc(s.id)}"><a href="#${esc(s.id)}">${s.image?`<img class="th" src="${esc(rel+s.image.src)}" width="128" height="72" alt="" loading="lazy" decoding="async" title="Photo: ${esc(s.image.credit)} · ${esc(s.image.license)}">`:`<span class="nt" aria-hidden="true">${esc(SHORT[s.region].slice(0,2).toUpperCase())}</span>`}<span><span class="k">${esc(REGIONS[s.region])} · ${esc(labelText(s.label))}</span><span class="h">${esc(s.headline)}</span></span></a></li>`).join('');
  return `<aside class="rail dt-only" aria-label="Top stories"><h2 class="sec">Top stories</h2><ol>${li}</ol><p class="pc">Photos are credited with each full story below.</p></aside>`;
}

// checks for one edition: story.sourceChecks + automated link-check record
function checksIndex(ed){
  let lc=null; const f=path.join(DATA,'checks',`${ed.id}-links.json`);
  if(fs.existsSync(f)) try{ lc=JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ lc=null; }
  const auto = new Map(); for(const x of lc?.results||[]) auto.set(x.url,x);
  const forUrl = (s,u)=>{ const out=(s.sourceChecks||[]).filter(c=>c.url===u); const a=auto.get(u);
    if(a){ const ok=a.tag==='OK'; out.push({auto:true, checkedAt:a.checkedAt,
      result: ok?`Link opened (HTTP ${a.status})`:a.tag==='WARN'?`Automated access ${a.status==='ERR'?'failed':'blocked (HTTP '+a.status+')'}; not evidence of a broken link or inaccurate reporting`:`Link failed (HTTP ${a.status})`, ok}); }
    return out; };
  return {lc, forUrl};
}
function aboutEdition(ed, lead, CI){
  const notes=(ed.notes||[]).map(deblanket).filter(Boolean);
  const all=ed.stories.flatMap(s=>(s.sourceChecks||[]).map(c=>({s,c})));
  const byWho={}; for(const {c} of all) byWho[c.checkedBy]=(byWho[c.checkedBy]||0)+1;
  const res=CI.lc?.results||[]; const nOk=res.filter(x=>x.tag==='OK').length, nWarn=res.filter(x=>x.tag==='WARN').length, nFail=res.filter(x=>x.tag==='FAIL').length;
  return `<details class="about" id="about"><summary>About this edition</summary>${notes.map(n=>`<p class="note">${esc(n)}</p>`).join('')}${SOURCING}` +
  `<h3>Source checks on record</h3>` +
  (all.length||res.length ? '' : '<p class="note">No individual source checks are recorded for this edition.</p>') +
  (all.length?`<ul>${all.map(({s,c})=>`<li><a href="#${esc(s.id)}">${esc(s.headline)}</a> — <b>${esc(c.checkedBy)}</b>${c.checkedAt?` (${esc(nyTime(c.checkedAt))})`:''} on ${esc(c.publisher||c.url)}${c.claimsSupported?.length?`: ${c.claimsSupported.map(esc).join('; ')}`:''}${c.limits?.length?`. Limit: ${c.limits.map(esc).join('; ')}`:''}</li>`).join('')}</ul>`:'') +
  (res.length?`<p class="note">Automated link check${CI.lc.ranAt?` (${esc(nyTime(CI.lc.ranAt))})`:''}: ${nOk} of ${res.length} source links opened${nWarn?`; ${nWarn} blocked or failed automated access (not evidence of a broken link)`:''}${nFail?`; ${nFail} failed`:''}. This checks that links open, not what they say.</p>`:'') +
  ((ed.provenance||[]).map(p=>`<p class="note">${esc(p)}</p>`).join('')) + `</details>`;
}

function renderEdition(ed, {rel, isCurrent, upd, archiveList, currentHref, specials=[]}){
  const stories = ed.stories; const lead = stories.find(s=>s.id===ed.leadId) || stories[0];
  const CI = checksIndex(ed);
  const byTs = [...stories].sort((a,b)=>a.ts<b.ts?1:-1);
  const nR = r => stories.filter(s=>s.region===r).length, nT = t => stories.filter(s=>s.topic===t).length;
  const cnt = n => `<span class="n${n?'':' n0'}" aria-label="${n} ${n===1?'story':'stories'}">${n}</span>`;
  const chips = Object.keys(REGIONS).map(r=>`<a class="chip" href="#region-${r}" role="button" data-chip="${r}" aria-pressed="false">${esc(SHORT[r])}${cnt(nR(r))}</a>`).join('') + `<a class="chip dt-only" href="?topic=sports" role="button" data-tchip="sports" aria-pressed="false">Sports${cnt(nT('sports'))}</a><a class="chip red" href="${rel}editions/index.html"><span class="m-only">Past editions</span><span class="dt-only">Archive</span></a>`;
  const regionSecs = Object.keys(REGIONS).map(r=>{ const items=stories.filter(s=>s.region===r&&s.id!==lead.id); const total=nR(r);
    return `<section data-region-sec id="region-${r}" data-n="${items.length}"><h2 class="sec">${esc(REGIONS[r])}<span class="count">${total} ${total===1?'story':'stories'}${lead.region===r?' incl. lead':''}</span></h2>${items.map(s=>storyCard(s,false,rel,CI.forUrl)).join('')}</section>`; }).join('');
  const spl = specials.map(sp=>`<a class="spl" href="${rel}editions/${esc(sp.id)}/index.html">${esc(spCfg(sp).strapLabel)} →</a>`).join('');
  // prominent banner for featured specials (front page only); never replaces the current edition
  const spBanner = isCurrent ? specials.filter(sp=>sp.featured).slice(0,1).map(sp=>`<a class="spb" href="${rel}editions/${esc(sp.id)}/index.html"><span class="k">${esc(sp.bannerKicker||'Special edition')}</span><span class="h">${esc(sp.bannerHeadline||sp.title)}</span>${sp.bannerDeck?`<span class="s">${esc(sp.bannerDeck)}</span>`:''}</a>`).join('') : '';
  const strap = `<b>${esc(ed.title)} · ${esc(fmtDate(ed.date))}</b><span class="upd">Last successful update: ${esc(upd)}</span>${spl}`;
  const tools = `<details class="tools" id="ftools"><summary><span>Search &amp; filter</span><span class="st" id="fsum" aria-live="polite">${stories.length} stories</span></summary><form role="search" onsubmit="return false"><label for="q">Search this edition</label><input id="q" type="search" placeholder="e.g. election, Hormuz, Tai Po" autocomplete="off"><div class="row"><div><label for="fr">Region</label><select id="fr"><option value="all" data-name="all regions">All regions (${stories.length})</option>${Object.entries(REGIONS).map(([k,v])=>`<option value="${k}" data-name="${esc(v)}" data-n="${nR(k)}">${esc(v)} (${nR(k)})</option>`).join('')}</select></div><div><label for="ft">Topic</label><select id="ft"><option value="all" data-name="all topics">All topics (${stories.length})</option>${Object.entries(TOPICS).map(([k,v])=>`<option value="${k}" data-name="${esc(v)}" data-n="${nT(k)}">${esc(v)} (${nT(k)}${nT(k)?'':' — none this edition'})</option>`).join('')}</select></div></div><div class="status"><span></span><button type="button" class="btn hidden" id="fclear">Show all stories</button></div></form></details>` +
    `<div class="empty hidden" id="fempty" role="status"><span id="femptytxt">No stories match.</span><br><button type="button" class="btn" id="freset">Show all stories</button></div>`;
  return head(`Donna Daily — ${ed.title}, ${fmtDate(ed.date)}`, 'Sourced US, Canada, Hong Kong, China and world news, labelled by type of claim.', rel) + mast(rel, strap) +
  `<nav class="chips" id="regions" aria-label="Regions"><div class="wrap">${chips}</div></nav><main id="main"><div class="wrap">` +
  (isCurrent?'':`<div class="banner">You're reading an archived edition. <a href="${currentHref}">Go to today's edition →</a></div>`) +
  spBanner + tools +
  `<div class="top"><section data-region-sec id="lead-sec">${storyCard(lead,true,rel,CI.forUrl)}</section>` + rail(stories, lead, rel) +
  `<section id="latest"><h2 class="sec">Latest</h2><ul class="latest">${byTs.map((s,i)=>`<li data-lat="${esc(s.id)}"${i>=6?' class="hidden"':''}><a href="#${esc(s.id)}"><div class="h">${esc(s.headline)}</div><div class="m">${esc(SHORT[s.region])} · ${esc(s.dateLabel)} · ${esc(labelText(s.label))}</div></a></li>`).join('')}</ul></section></div>` +
  regionSecs +
  `<section id="archive"><h2 class="sec">Past editions</h2><ul class="arch">${archiveList}</ul></section>` +
  aboutEdition(ed, lead, CI) + LEGEND +
  `</div></main><a class="totop" id="totop" href="#regions">↑ Top · Regions</a>` + foot(rel, upd) + `<script>${JS}</script></body></html>`;
}

function renderBlocks(nodes, depth=0){
  return nodes.map(n=>{ if(typeof n==='string') return esc(deblanket(n)); const p=n.props||{};
    switch(n.type){
      case 'Section': return depth===0 ? `<section id="${esc(p.id||'')}"><h2 class="sec">${esc(p.heading)}</h2>${renderBlocks(n.children,1)}</section>` : `<div class="blk"><h3>${esc(p.heading)}</h3>${renderBlocks(n.children,depth+1)}</div>`;
      case 'Properties': return `<dl class="props">${p.items.map(i=>`<dt>${esc(i.label)}</dt><dd>${esc(deblanket(i.value))}</dd>`).join('')}</dl>`;
      case 'Rows': return `<ul class="rows">${p.rows.map(r=>`<li><div class="h">${esc(r.title)}</div><div>${esc(deblanket(r.detail||''))}</div><div class="m">${esc(r.meta||'')}</div></li>`).join('')}</ul>`;
      case 'LinkCards': return srcList(p.links);
      case 'NumberedList': return `<ol>${p.items.map(i=>`<li>${esc(deblanket(i))}</li>`).join('')}</ol>`;
      case 'BulletList': return `<ul>${p.items.map(i=>`<li>${esc(deblanket(i))}</li>`).join('')}</ul>`;
      case 'Callout': return `<div class="callout"><b>${esc(p.lead||'')}</b> ${renderBlocks(n.children,depth+1)}</div>`;
      case 'Text': return `<p>${renderBlocks(n.children,depth+1)}</p>`;
      default: return renderBlocks(n.children||[],depth+1);
    }}).join('');
}
function renderArchive(ed, {upd, currentHref}){
  const rel='../';
  const strap = `<b>Archive · ${esc(ed.title)} · ${esc(fmtDate(ed.date))}</b><span class="upd">Originally published: ${esc(ed.updatedLabel)}</span>`;
  return head(`Donna Daily archive — ${ed.title}, ${fmtDate(ed.date)}`, deblanket(ed.summary||''), rel) + mast(rel, strap) +
  `<nav class="chips" aria-label="Edition"><div class="wrap"><a class="chip" href="${currentHref}">Today's edition</a>${dtNav('../')}<a class="chip red" href="index.html">All past editions</a></div></nav><main id="main"><div class="wrap read">` +
  `<div class="banner">Archived brief, kept as originally published (snapshot; not updated). <a href="${currentHref}">Go to today's edition →</a>${ed.droppedSections?.length?' A personal travel note was removed from this public copy.':''}</div>` +
  `<p style="margin-top:12px">${esc(deblanket(ed.summary))}</p>` + renderBlocks(ed.blocks) + `<details class="about"><summary>About this snapshot</summary>${SOURCING.replace('this edition','this brief')}</details>` + `</div></main>` + foot(rel, upd) + `</body></html>`;
}

// ---------- special editions (data/specials/*.json, kind:"special") ----------
// A month-in-review (or other one-off) edition with News / Life / Opinion / Culture sections, rendered at
// editions/<id>/index.html. Specials are kept on every build and never become the front page (see README).
const SP_SECTIONS = {news:'News', life:'Life', opinion:'Opinion', culture:'Culture'};
const SP_REGIONS = {us:'United States', ca:'Canada', hk:'Hong Kong', cn:'China'};
const SP_SHORT = {us:'US', ca:'Canada', hk:'HK', cn:'China'};
const spRegions = s => [s.region, ...(s.alsoRegions||[])];
// Per-special configuration. A special may define its own sections/regions (e.g. the midterms special uses
// Senate/House/States/New York/Reaction/Analysis and National/Northeast/South/Midwest/West/World).
// Defaults reproduce the October 2026 in Review layout. The opinion section key is always "opinion".
function spCfg(sp){
  return {
    sections: sp.sectionLabels || SP_SECTIONS,
    regions: sp.regionLabels || SP_REGIONS,
    short: sp.regionShort || sp.regionLabels || SP_SHORT,
    glanceTitle: sp.glanceTitle || 'Month at a glance',
    unit: sp.unitLabel || 'stories this month',
    wordmark: sp.wordmark || 'Review',
    searchHint: sp.searchHint || 'Search this edition, e.g. Alberta, Tai Po, Mao',
    ourViewIntro: sp.ourViewIntro || 'Donna Daily’s own analysis of the month’s biggest arguments, setting out more than one side and drawing on the linked reporting.',
    strapLabel: sp.strapLabel || String(sp.title).replace(/^(\w+) \d{4} in Review$/,'$1 in Review'),
  };
}
function validateSpecial(sp){
  const errs=[]; const ids=new Set(); const C=spCfg(sp);
  for(const k of ['id','title','intro','date']) if(!sp[k]) errs.push(`missing ${k}`);
  for(const k of ['sectionLabels','regionLabels','regionShort']) if(sp[k]!==undefined && !(sp[k]&&typeof sp[k]==='object'&&!Array.isArray(sp[k])&&Object.values(sp[k]).every(v=>typeof v==='string'&&v))) errs.push(`${k} must be an object of labels`);
  if(sp.regionShort && sp.regionLabels && Object.keys(sp.regionShort).join()!==Object.keys(sp.regionLabels).join()) errs.push('regionShort keys must match regionLabels');
  if(sp.sectionLabels && Object.keys(sp.sectionLabels).some(k=>!/^[a-z]+$/.test(k))) errs.push('section keys must be lowercase letters');
  if(sp.updatedAt!==undefined && !isoOk(sp.updatedAt)) errs.push('updatedAt must be ISO time with offset');
  if(!/^[a-z0-9-]+$/.test(sp.id||'')) errs.push('id must be lowercase letters, digits and dashes');
  if(!Array.isArray(sp.stories)||!sp.stories.length) errs.push('no stories');
  for(const s of sp.stories||[]){
    for(const k of ['id','section','region','ts','dateLabel','headline','deck','summary','why','label']) if(!s[k]) errs.push(`${s.id||'?'}: missing ${k}`);
    if(!C.sections[s.section]) errs.push(`${s.id}: bad section ${s.section}`);
    if(!C.regions[s.region]) errs.push(`${s.id}: bad region ${s.region}`);
    for(const r of s.alsoRegions||[]) if(!C.regions[r]||r===s.region) errs.push(`${s.id}: bad alsoRegions ${r}`);
    if(!/^\d{4}-\d{2}-\d{2}/.test(s.ts||'')) errs.push(`${s.id}: ts must start YYYY-MM-DD`);
    if(s.section==='opinion'){
      if(!['ourview','column'].includes(s.opinionKind)) errs.push(`${s.id}: opinion needs opinionKind ourview|column`);
      if(s.opinionKind==='column' && !(s.author&&s.outlet)) errs.push(`${s.id}: column needs author and outlet`);
      if(s.opinionKind==='column' && !labelParts(s.label).some(b=>b.k==='op')) errs.push(`${s.id}: column must be labelled Opinion`);
      if(s.opinionKind==='ourview' && !labelParts(s.label).some(b=>b.k==='ov')) errs.push(`${s.id}: Our view must be labelled "Our view"`);
    } else if(s.opinionKind) errs.push(`${s.id}: opinionKind only on opinion stories`);
    if(!s.sources?.length) errs.push(`${s.id}: no sources`);
    for(const l of s.sources||[]) { if(!/^https:\/\//.test(l.href||'')) errs.push(`${s.id}: non-https source ${l.href}`); if(!l.title||!l.site) errs.push(`${s.id}: source needs title and site`); }
    const hrefs=new Set((s.sources||[]).map(l=>l.href));
    for(const c of s.sourceChecks||[]){
      if(!hrefs.has(c.url)) errs.push(`${s.id}: sourceCheck url is not one of the story's sources (${c.url})`);
      if(!c.checkedBy) errs.push(`${s.id}: sourceCheck missing checkedBy`);
      if(c.checkedAt!==undefined && !isoOk(c.checkedAt)) errs.push(`${s.id}: sourceCheck checkedAt must be ISO time with offset`);
      for(const k of ['claimsSupported','limits']) if(c[k]!==undefined && !(Array.isArray(c[k])&&c[k].every(x=>typeof x==='string'))) errs.push(`${s.id}: sourceCheck ${k} must be a list of strings`);
    }
    if(s.image) for(const x of validateImage(s.image)) errs.push(`${s.id}: image ${x}`);
    if(ids.has(s.id)) errs.push(`duplicate id ${s.id}`); ids.add(s.id);
  }
  if(sp.leadId && !ids.has(sp.leadId)) errs.push('leadId not found');
  for(const k of ['notes','provenance']) if(sp[k]!==undefined && !(Array.isArray(sp[k])&&sp[k].every(x=>typeof x==='string'))) errs.push(`${k} must be a list of strings`);
  return errs;
}

const SP_CSS = `
:root{--ink:#161616;--paper:#fff;--muted:#5b5b5b;--rule:#dcdcdc;--soft:#f5f3ef;--acc:#0f4c5c;--accl:#e6f0f2}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit}img{max-width:100%;height:auto}
.serif,h1,h2,h3,.wm{font-family:Georgia,"Times New Roman",Times,serif}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:9}
.hidden{display:none!important}
.mast{border-bottom:1px solid var(--ink)}
.mast .wrap{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:54px}
.wm{font-size:26px;font-weight:700;letter-spacing:-.3px;text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
.wm i{font-style:italic;font-weight:400;color:var(--acc);margin-left:5px}
.mast .back{font-size:14px;font-weight:600;color:var(--acc);text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
.ttl{padding:12px 0 4px;border-bottom:3px double var(--ink)}
.kick{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--acc);margin:0}
.ttl h1{font-size:30px;line-height:1.08;font-weight:700;margin:4px 0 6px;letter-spacing:-.4px}
.intro{font-size:16px;line-height:1.5;color:#333;margin:0 0 8px}
.snav{padding:8px 0 4px;border-bottom:1px solid var(--rule)}
.tabs,.regs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.tab,.reg{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:44px;padding:0 12px;font:700 15px/1.1 -apple-system,"Segoe UI",Arial,sans-serif;color:var(--ink);text-decoration:none;background:#fff;cursor:pointer}
.tab{border:0;border-bottom:3px solid transparent;padding:0 9px}
.tab[aria-pressed=true]{border-bottom-color:var(--acc);color:var(--acc)}
.reg{border:1px solid #9a9a9a;border-radius:999px}
.reg[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
@media (max-width:759.98px){.tabs{gap:2px}.tab{padding:0 6px}.regs{gap:5px}.reg{padding:0 10px}.regs .lbl{position:absolute;left:-999px}.intro{font-size:15.5px}}
.tab .n,.reg .n{font-size:12px;font-weight:600;opacity:.75}
.regs .lbl{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);align-self:center;margin-right:2px}
.jsonly{display:none}.js .jsonly{display:flex}
.srch{gap:8px;align-items:center;margin:2px 0 6px}
.srch input{flex:1 1 auto;min-width:0;min-height:44px;font-size:16px;padding:6px 12px;border:1px solid #9a9a9a;border-radius:6px}
.srch label{position:absolute;left:-999px}
.status{font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;min-height:24px}
.btn{min-height:44px;padding:0 14px;border-radius:6px;border:1px solid var(--ink);background:#fff;font-weight:700;font-size:15px;cursor:pointer;color:var(--ink)}
.empty{padding:16px;background:var(--soft);margin:14px 0;border-left:3px solid var(--acc)}
h2.sh{font-size:26px;font-weight:700;margin:26px 0 2px;padding-top:8px;border-top:2px solid var(--ink);display:flex;align-items:baseline;gap:10px;scroll-margin-top:8px}
h2.sh .count{font:600 13px/1 -apple-system,Arial,sans-serif;color:var(--muted)}
.sub h3.subh{font-size:19px;font-style:italic;font-weight:400;margin:14px 0 2px;color:var(--acc);border-bottom:1px solid var(--rule);padding-bottom:4px}
.sub .subd{font-size:14px;color:var(--muted);margin:4px 0 0}
.sc{border-bottom:1px solid var(--rule);padding:14px 0;scroll-margin-top:8px}
.sc .k{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--acc)}
.sc h3{font-size:21px;line-height:1.22;font-weight:700;margin:4px 0 6px}
.sc.ov h3{font-size:23px}
.by{font-size:14px;margin:-2px 0 6px;color:#333}.by b{font-weight:700}
.deck{font-size:17px;margin:0 0 8px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;color:var(--muted);margin:0 0 6px}
.lab{display:inline-block;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:3px}
.lab-rep{background:#fff;color:#111;border:1px solid #111}.lab-off{background:#e3eefc;color:#0b3b78;border:1px solid #9dbbe6}
.lab-claim{background:#ffe9d6;color:#7a3300;border:1px solid #f0b182}.lab-alleg{background:#fde2e2;color:#8a0b0b;border:1px solid #e9a3a3}
.lab-op{background:#efe6ff;color:#3f1d7a;border:1px solid #cdb8f0}.lab-unn{background:#fff2cc;color:#6b4a00;border:1px solid #e6c766}.lab-sm{background:#f1f1f1;color:#333;border:1px dashed #777}
.lab-ov{background:var(--acc);color:#fff;border:1px solid var(--acc)}
.why{border-left:3px solid var(--acc);padding:4px 0 4px 12px;margin:8px 0;font-size:15.5px}
.why b{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--acc)}
details.more>summary{display:flex;align-items:center;min-height:44px;font-weight:700;font-size:15px;cursor:pointer;color:var(--acc);list-style:none}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:after{content:"▾";margin-left:6px;font-size:13px}details.more[open]>summary:after{content:"▴"}
details.more>summary .c{color:var(--muted);font-weight:500;margin-left:6px}
details.more h4{font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 4px}
.note{font-size:15px;color:#333}.note b{color:#000}
.srcs{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:6px}
.srcs a{display:flex;flex-direction:column;justify-content:center;min-height:48px;padding:7px 11px;border:1px solid #cfcfcf;border-radius:6px;text-decoration:none}
.srcs .t{font-weight:700;font-size:15px;line-height:1.3;text-decoration:underline;text-decoration-color:#bbb}
.srcs .s{font-size:13px;color:var(--muted)}
.chk{list-style:none;margin:4px 0 2px;padding:0 0 0 12px;border-left:2px solid var(--rule);font-size:13px;line-height:1.45;color:#333}
.chk li{margin:2px 0}.chk .lim{color:#7a3300}
.ph{margin:0 0 10px}
.ph img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#ddd}
.ph figcaption{font-size:11.5px;line-height:1.35;color:var(--muted);padding:4px 0 0}
.ph figcaption b{text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:var(--ink)}
.ph figcaption a{display:inline-block;padding:14px 0;margin:-14px 0;color:var(--muted)}
.lead{padding:12px 0 14px;border-bottom:1px solid var(--ink)}
.lead h2.lh{font-size:27px;line-height:1.12;font-weight:700;margin:4px 0 8px;letter-spacing:-.3px}
.lead .deck{font-size:17.5px;line-height:1.5}
#glance h2{font-size:20px;font-weight:700;margin:20px 0 4px;padding-top:8px;border-top:2px solid var(--ink)}
#glance ol{list-style:none;padding:0;margin:0}
#glance li{border-bottom:1px solid var(--rule)}
#glance a{display:grid;grid-template-columns:58px 1fr;gap:8px;min-height:44px;padding:8px 0;text-decoration:none}
#glance .d{font-size:13px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
#glance .h{font-family:Georgia,"Times New Roman",serif;font-size:16px;line-height:1.3}
#glance .m{display:block;font-size:12px;color:var(--muted);font-family:-apple-system,Arial,sans-serif}
details.about,details.guide{margin-top:24px;border-top:1px solid var(--rule);padding-top:6px}
details.about>summary,details.guide>summary{min-height:44px;display:flex;align-items:center;font-weight:700;cursor:pointer}
details.about h3{font-size:17px;margin:14px 0 6px}
details.about ul{padding-left:20px;font-size:14.5px}details.about li{margin:4px 0}
.totop{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:30;display:none;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;background:var(--ink);color:#fff;font-weight:700;font-size:14px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.js .totop.show{display:inline-flex}
footer{border-top:1px solid var(--ink);margin-top:30px;padding:14px 0 50px;font-size:13px;color:var(--muted)}
footer a{display:inline-flex;align-items:center;min-height:44px}
@media (min-width:760px){.ttl h1{font-size:44px}.lead h2.lh{font-size:36px}.srcs{grid-template-columns:1fr 1fr}
 .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px;align-items:start}.grid .srcs{grid-template-columns:1fr}}
@media (min-width:1024px){
 .wrap{max-width:1200px;padding:0 32px}
 .mast .wrap{min-height:64px}.wm{font-size:34px}
 .ttl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);column-gap:40px;align-items:end;padding:20px 0 12px}
 .ttl h1{font-size:54px;margin:4px 0 0}.ttl .intro{font-size:17px;margin:0}
 .snav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px;padding:6px 0}
 .snav .tabs,.snav .regs,.snav .srch{margin:0}.snav .srch{flex:1 1 220px}.snav .status{flex-basis:100%;min-height:0}
 .tab:hover{color:var(--acc)}.reg:hover{border-color:var(--acc)}
 h2.sh{font-size:32px;scroll-margin-top:110px}.sc{scroll-margin-top:110px}
 .top{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);column-gap:40px;align-items:start;margin-top:8px}
 .top.nolead{grid-template-columns:1fr}.top.nolead #glance ol{columns:2;column-gap:40px}.top.nolead #glance li{break-inside:avoid}
 .lead{border-bottom:0;padding-top:16px}.lead h2.lh{font-size:44px;line-height:1.06}
 .lead .deck{font-size:19px}
 #glance h2{margin-top:16px}
 .grid{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:32px}
 .grid>.sc{border-bottom:0;border-top:1px solid var(--rule);padding:14px 0 26px}
 .grid .sc h3{font-size:20px}.grid .sc .deck{font-size:16px}
 .grid.ovg>.sc h3{font-size:24px}
 .srcs a:hover{border-color:var(--acc)}.sc:hover h3{color:var(--acc)}
 details.about,details.guide{max-width:860px}
}
@media (min-width:1280px){.grid.g4{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const spJs = (NM, unit) => `
(function(){var d=document;d.documentElement.classList.add('js');
var tt=d.getElementById('totop');if(tt){var onS=function(){tt.classList.toggle('show',(window.scrollY||d.documentElement.scrollTop)>700);};addEventListener('scroll',onS,{passive:true});onS();}
var A=function(s){return [].slice.call(d.querySelectorAll(s));};
var cards=A('[data-story]'),tabs=A('[data-tab]'),regs=A('[data-reg]'),secs=A('[data-sec]'),subs=A('[data-sub]'),gl=A('[data-g]');
var q=d.getElementById('q'),st=d.getElementById('fsum'),clr=d.getElementById('fclear'),em=d.getElementById('fempty'),emt=d.getElementById('femptytxt'),rst=d.getElementById('freset'),top=d.getElementById('top'),lead=d.getElementById('leadbox'),gS=d.getElementById('glance');
var S={sec:'all',reg:'all'};var NM=${JSON.stringify(NM).replace(/</g,'\\u003c')};
function m(c,s,r,qs){return (s==='all'||c.dataset.section===s)&&(r==='all'||(' '+c.dataset.regions+' ').indexOf(' '+r+' ')>-1)&&(!qs||c.textContent.toLowerCase().indexOf(qs)>-1);}
function cnt(s,r,qs){var n=0;cards.forEach(function(c){if(m(c,s,r,qs))n++;});return n;}
function apply(){var qs=q.value.trim().toLowerCase(),n=0;
cards.forEach(function(c){var ok=m(c,S.sec,S.reg,qs);c.classList.toggle('hidden',!ok);if(ok)n++;});
tabs.forEach(function(t){var v=t.dataset.tab;t.setAttribute('aria-pressed',String(v===S.sec));t.querySelector('.n').textContent=cnt(v,S.reg,qs);});
regs.forEach(function(t){var v=t.dataset.reg;t.setAttribute('aria-pressed',String(v===S.reg));t.querySelector('.n').textContent=cnt(S.sec,v,qs);});
subs.forEach(function(s){s.classList.toggle('hidden',!s.querySelector('[data-story]:not(.hidden)'));});
secs.forEach(function(s){s.classList.toggle('hidden',!s.querySelector('[data-story]:not(.hidden)'));});
var lh=!lead||!lead.querySelector('[data-story]:not(.hidden)');if(lead)lead.classList.toggle('hidden',lh);
var k=0;gl.forEach(function(l){var c=d.getElementById(l.dataset.g);var ok=c&&!c.classList.contains('hidden')&&k<12;if(ok)k++;l.classList.toggle('hidden',!ok);});
gS.classList.toggle('hidden',k===0);top.classList.toggle('nolead',lh);top.classList.toggle('hidden',lh&&k===0);
var on=S.sec!=='all'||S.reg!=='all'||!!qs;st.textContent=on?('Showing '+n+' of '+cards.length+' stories'):(cards.length+' ${unit}');clr.classList.toggle('hidden',!on);
if(n===0)emt.textContent='No stories match'+(qs?' \\u201c'+q.value.trim()+'\\u201d':'')+(S.sec!=='all'?' in '+NM[S.sec]:'')+(S.reg!=='all'?' for '+NM[S.reg]:'')+'. Try another word, or show every story.';
em.classList.toggle('hidden',n>0);
try{var u=new URL(location.href);['section','region','q'].forEach(function(x){u.searchParams.delete(x)});if(S.sec!=='all')u.searchParams.set('section',S.sec);if(S.reg!=='all')u.searchParams.set('region',S.reg);if(qs)u.searchParams.set('q',q.value.trim());history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
function reset(){q.value='';S.sec='all';S.reg='all';apply();}
tabs.forEach(function(t){t.addEventListener('click',function(e){e.preventDefault();var v=t.dataset.tab;S.sec=(v==='all'||S.sec===v)?'all':v;apply();});});
regs.forEach(function(t){t.addEventListener('click',function(e){e.preventDefault();var v=t.dataset.reg;S.reg=(v==='all'||S.reg===v)?'all':v;apply();});});
q.addEventListener('input',apply);clr.addEventListener('click',reset);rst.addEventListener('click',function(){reset();d.getElementById('snav').scrollIntoView();});
var p=new URLSearchParams(location.search);if(p.get('section')&&p.get('section')!=='all'&&tabs.some(function(t){return t.dataset.tab===p.get('section')}))S.sec=p.get('section');if(regs.some(function(t){return t.dataset.reg===p.get('region')}))S.reg=p.get('region');if(p.get('q'))q.value=p.get('q');apply();})();
`;

const spDate = ts => new Date(ts.slice(0,10)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
// "2026-11-03T21:05" (written in ET) -> "Tue 9:05p"; date-only ts -> "Nov 3"
const spWhen = ts => { const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(ts||''); if(!m) return spDate(ts);
  const dow=new Date(m[1]+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',timeZone:'UTC'}); let h=+m[2]; const ap=h<12?'a':'p'; h=h%12||12; return `${dow} ${h}${m[3]==='00'?'':':'+m[3]}${ap}`; };
function spCard(s, CI, rel, lead=false, C=spCfg({})){
  const regs = spRegions(s); const regTxt = regs.map(r=>C.regions[r]).join(' · ');
  const kick = s.opinionKind==='ourview' ? `Our view · ${regTxt}` : s.opinionKind==='column' ? `Opinion · ${regTxt}` : `${C.sections[s.section]} · ${regTxt}`;
  const by = s.opinionKind==='column' ? `<p class="by">By <b>${esc(s.author)}</b> · ${esc(s.outlet)}</p>` : s.opinionKind==='ourview' ? `<p class="by"><b>Donna Daily</b> · analysis, drawing on the linked reporting</p>` : '';
  const meta = `<div class="meta">${badges(s.label)}<span>${esc(s.dateLabel)}</span></div>`;
  const n = s.sources.length;
  const why = `<div class="why"><b>${s.opinionKind==='column'?'Why read it':'Why it matters'}</b><br>${esc(s.why)}</div>`;
  const more = `<details class="more"><summary>Read more<span class="c">· ${s.opinionKind==='column'?'the argument &amp; ':'full story &amp; '}${n} source${n===1?'':'s'}</span></summary><p>${esc(s.summary)}</p>${s.note?`<p class="note"><b>Note:</b> ${esc(s.note)}</p>`:''}${s.opinionKind==='column'?'<p class="note">Paraphrased by Donna Daily; read the original for the writer’s own words.</p>':''}<h4>Sources &amp; checks</h4>${srcList(s.sources, u=>CI.forUrl(s,u))}</details>`;
  const attrs = `id="${esc(s.id)}" data-story data-section="${s.section}" data-region="${s.region}" data-regions="${regs.join(' ')}"`;
  const cls = `sc${s.opinionKind==='ourview'?' ov':''}${s.image?' has-ph':''}`;
  if(lead) return `<article class="${cls} lead" ${attrs}><span class="k">Lead · ${esc(kick)}</span><h2 class="lh">${esc(s.headline)}</h2><p class="deck">${esc(s.deck)}</p>${meta}${figure(s.image,rel,true)}${why}${more}</article>`;
  return `<article class="${cls}" ${attrs}>${figure(s.image,rel,false)}<span class="k">${esc(kick)}</span><h3>${esc(s.headline)}</h3>${by}<p class="deck">${esc(s.deck)}</p>${meta}${why}${more}</article>`;
}
// interleave regions (us, ca, hk, cn) so each section reads across all four
function roundRobin(list, keys=Object.keys(SP_REGIONS)){ if(list.some(s=>s.order!==undefined)) return [...list].sort((a,b)=>(a.order??99)-(b.order??99));
  const by={}; for(const s of list) (by[s.region]=by[s.region]||[]).push(s); const out=[]; let i=0, more=true;
  while(more){ more=false; for(const r of keys){ const x=by[r]?.[i]; if(x){ out.push(x); more=true; } } i++; } return out; }
function renderSpecial(sp, {upd}){
  const rel='../../'; const st=sp.stories; const lead=st.find(s=>s.id===sp.leadId)||st[0];
  const CI = checksIndex(sp); const C = spCfg(sp);
  const nS = k => st.filter(s=>k==='all'||s.section===k).length, nR = r => st.filter(s=>r==='all'||spRegions(s).includes(r)).length;
  const tabs = [['all','All'],...Object.entries(C.sections)].map(([k,v])=>`<a class="tab" href="${k==='all'?'#top':'#sec-'+k}" role="button" data-tab="${k}" aria-pressed="${k==='all'}">${esc(v)} <span class="n">${nS(k)}</span></a>`).join('');
  const regs = `<span class="lbl">Region</span>` + [['all','All'],...Object.entries(C.short)].map(([k,v])=>`<button type="button" class="reg" data-reg="${k}" aria-pressed="${k==='all'}" aria-label="${esc(k==='all'?'All regions':C.regions[k])}">${esc(v)} <span class="n">${nR(k)}</span></button>`).join('');
  const sec = (k, inner) => `<section data-sec="${k}" id="sec-${k}"><h2 class="sh">${esc(C.sections[k])}<span class="count">${nS(k)} ${nS(k)===1?'story':'stories'}</span></h2>${inner}</section>`;
  const grid = (list, cls='') => `<div class="grid g4 ${cls}">${list.map(s=>spCard(s,CI,rel,false,C)).join('')}</div>`;
  const body = Object.keys(C.sections).map(k=>{
    const list = roundRobin(st.filter(s=>s.section===k && s.id!==lead.id), Object.keys(C.regions));
    if(k!=='opinion') return sec(k, grid(list));
    const ov=list.filter(s=>s.opinionKind==='ourview'), cols=list.filter(s=>s.opinionKind==='column');
    return sec(k, `<div class="sub" data-sub="ourview"><h3 class="subh">Our view</h3><p class="subd">${esc(C.ourViewIntro)}</p><div class="grid ovg">${ov.map(s=>spCard(s,CI,rel,false,C)).join('')}</div></div>` +
      `<div class="sub" data-sub="columns"><h3 class="subh">What columnists are arguing</h3><p class="subd">Named writers at other outlets, paraphrased in our words, with links to the originals.</p>${grid(cols)}</div>`);
  }).join('');
  const byTs=[...st].sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
  const gList = sp.glanceIds ? sp.glanceIds.map(id=>st.find(s=>s.id===id)).filter(Boolean) : byTs;
  const glance = `<section id="glance" aria-label="${esc(C.glanceTitle)}"><h2>${esc(C.glanceTitle)}</h2><ol>${gList.map((s,i)=>`<li data-g="${esc(s.id)}"${i>=12?' class="hidden"':''}><a href="#${esc(s.id)}"><span class="d">${esc(spWhen(s.ts))}</span><span class="h">${esc(s.glance||s.headline)}<span class="m">${esc(C.sections[s.section])} · ${esc(spRegions(s).map(r=>C.short[r]).join(', '))}</span></span></a></li>`).join('')}</ol></section>`;
  const all=st.flatMap(s=>(s.sourceChecks||[]).map(c=>({s,c})));
  const res=CI.lc?.results||[]; const nOk=res.filter(x=>x.tag==='OK').length, nWarn=res.filter(x=>x.tag==='WARN').length, nFail=res.filter(x=>x.tag==='FAIL').length;
  const nPh=st.filter(s=>s.image).length;
  const about = `<details class="about" id="about"><summary>About this edition</summary>${(sp.notes||[]).map(n=>`<p class="note">${esc(n)}</p>`).join('')}` +
    `<p class="note"><b>How this edition is sourced.</b> Summaries and analysis are original and compiled from the linked sources; nothing is quoted at length${st.some(s=>s.sources.some(l=>/Globe and Mail/.test(l.site)))?', and Globe and Mail pieces are cited as “subscriber” links':''}. Labels describe the type of claim (reported, official statement, allegation, opinion, Our view); they are not a verification grade, and not every claim has been independently verified. Major news claims rest on at least two sources where we could find them; single-source items say so.</p>` +
    `<p class="note">${st.length} stories · ${nPh} with photos · ${Object.entries(C.sections).map(([k,v])=>`${v} ${nS(k)}`).join(' · ')}.</p>` +
    (sp.provenance||[]).map(p=>`<p class="note">${esc(p)}</p>`).join('') +
    (res.length?`<p class="note">Automated link check${CI.lc.ranAt?` (${esc(nyTime(CI.lc.ranAt))})`:''}: ${nOk} of ${res.length} source links opened${nWarn?`; ${nWarn} blocked or failed automated access (an access limit, not evidence of a broken link)`:''}${nFail?`; ${nFail} failed`:''}. This checks that links open, not what they say.</p>`:'') +
    `<h3>Source checks on record</h3>` + (all.length?`<ul>${all.map(({s,c})=>`<li><a href="#${esc(s.id)}">${esc(s.headline)}</a> — <b>${esc(c.checkedBy)}</b>${c.checkedAt?` (${esc(nyTime(c.checkedAt))})`:''} on ${esc(c.publisher||c.url)}${c.claimsSupported?.length?`: ${c.claimsSupported.map(esc).join('; ')}`:''}${c.limits?.length?`. Limit: ${c.limits.map(esc).join('; ')}`:''}</li>`).join('')}</ul>`:'<p class="note">No individual source checks are recorded.</p>') + `</details>`;
  const used = new Set(st.flatMap(s=>labelParts(s.label).map(b=>b.k)));
  const legend = `<details class="guide"><summary>How to read the labels</summary>${Object.entries(LABELS).filter(([k])=>used.has(k)).map(([k,l])=>`<p><span class="lab ${l.cls}">${esc(l.text)}</span> ${esc(l.desc)}</p>`).join('')}<p>Photos are openly licensed (Wikimedia Commons CC0, public domain, CC BY or CC BY-SA, or US-government public domain), cropped to fit and credited under each picture. “File photo” means the picture shows the person or place, not the event in the story.</p></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Donna Daily — ${esc(sp.title)}</title><meta name="description" content="${esc(sp.intro)}"><meta name="theme-color" content="#0f4c5c"><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230f4c5c'/%3E%3Ctext x='32' y='45' font-size='38' font-family='Georgia,serif' font-weight='700' text-anchor='middle' fill='%23fff'%3ED%3C/text%3E%3C/svg%3E"><style>${SP_CSS}</style></head><body><a class="skip" href="#main">Skip to stories</a>` +
  `<header class="mast"><div class="wrap"><a class="wm" href="${rel}index.html">Donna Daily<i>${esc(C.wordmark)}</i></a><a class="back" href="${rel}index.html">Today’s edition →</a></div></header>` +
  `<div class="wrap"><div class="ttl"><div><p class="kick">Special edition · ${esc(sp.publishedLabel||fmtDate(sp.date))}${sp.updatedAt?` · <time datetime="${esc(sp.updatedAt)}">Last updated ${esc(nyTime(sp.updatedAt))}</time>`:''}</p><h1>${esc(sp.title)}</h1></div><p class="intro">${esc(sp.intro)}</p></div></div>` +
  `<div class="wrap"><nav class="snav" id="snav" aria-label="Sections and regions"><div class="tabs">${tabs}</div><div class="regs jsonly">${regs}</div><form class="srch jsonly" role="search" onsubmit="return false"><label for="q">Search this edition</label><input id="q" type="search" placeholder="${esc(C.searchHint)}" autocomplete="off"></form><div class="status jsonly"><span id="fsum" aria-live="polite">${st.length} ${esc(C.unit)}</span><button type="button" class="btn hidden" id="fclear">Show all stories</button></div></nav></div>` +
  `<main id="main"><div class="wrap"><div class="empty hidden" id="fempty" role="status"><span id="femptytxt">No stories match.</span><br><button type="button" class="btn" id="freset" style="margin-top:10px">Show all stories</button></div>` +
  `<div class="top" id="top"><div id="leadbox">${spCard(lead,CI,rel,true,C)}</div>${glance}</div>` + body + about + legend +
  `</div></main><a class="totop" id="totop" href="#snav">↑ Back to top</a><footer><div class="wrap"><p><b>Donna Daily</b> · ${esc(sp.title)} is a special edition compiled by Donna (Grok Bot). Summaries and analysis are original; follow the source links for full reporting. Some sources are paywalled.</p><p><a href="${rel}index.html">Today’s edition</a> · <a href="${rel}editions/index.html">Past editions</a> · Built ${esc(upd)}</p></div></footer><script>${spJs(Object.assign({},C.sections,Object.fromEntries(Object.entries(C.regions).map(([k,v])=>[k,(sp.regionPhrases||(sp.regionLabels?{}:{us:'the United States'}))[k]||v]))), C.unit)}</script></body></html>`;
}

// ---------- main ----------
const eds = fs.readdirSync(path.join(DATA,'editions')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(DATA,'editions',f),'utf8')));
let errors=[]; for(const e of eds) for(const x of validate(e)) errors.push(`${e.id}: ${x}`);
// specials: data/specials/*.json (kind:"special"). Always rebuilt and kept; they never replace the daily front page.
const SPEC_DIR = path.join(DATA,'specials');
const specials = (fs.existsSync(SPEC_DIR)?fs.readdirSync(SPEC_DIR).filter(f=>f.endsWith('.json')):[]).map(f=>JSON.parse(fs.readFileSync(path.join(SPEC_DIR,f),'utf8'))).filter(e=>e.kind==='special').sort((a,b)=>a.id<b.id?1:-1);
for(const sp of specials) for(const x of validateSpecial(sp)) errors.push(`special ${sp.id}: ${x}`);
for(const sp of specials) if(eds.some(e=>e.id===sp.id)) errors.push(`special ${sp.id}: id clashes with a daily edition`);
if(errors.length){ console.error('BUILD FAILED — previous site left unchanged:\n'+errors.join('\n')); process.exit(1); }
const editions = eds.filter(e=>e.kind==='edition').sort((a,b)=>a.id<b.id?1:-1);
const archives = eds.filter(e=>e.kind==='archive').sort((a,b)=>a.id<b.id?1:-1);
if(!editions.length){ console.error('BUILD FAILED: no edition'); process.exit(1); }
const current = editions[0];
const upd = nyNow();
const allPast = [...editions.slice(1), ...archives].sort((a,b)=>a.date<b.date||(a.date===b.date&&a.id<b.id)?1:-1);
const specLi = (relE) => specials.map(sp=>`<li class="spec"><a href="${relE}${sp.id}/index.html"><span class="t">${esc(sp.title)}</span><span class="s">Special edition · ${sp.stories.length} stories · ${esc(Object.values(spCfg(sp).sections).join(', '))}</span></a></li>`).join('');
const archLi = (relE) => specLi(relE) + (allPast.length? allPast.map(e=>`<li><a href="${relE}${e.id}.html"><span class="t">${esc(e.title)} — ${esc(fmtDate(e.date))}</span><span class="s">${e.kind==='archive'?'Earlier brief (snapshot)':`${e.stories.length} stories`}</span></a></li>`).join('') : (specials.length?'':'<li>No past editions yet.</li>'));

fs.rmSync(TMP,{recursive:true,force:true}); fs.mkdirSync(path.join(TMP,'editions'),{recursive:true});
fs.writeFileSync(path.join(TMP,'index.html'), renderEdition(current,{rel:'',isCurrent:true,upd,archiveList:archLi('editions/'),specials}));
for(const sp of specials){ fs.mkdirSync(path.join(TMP,'editions',sp.id),{recursive:true}); fs.writeFileSync(path.join(TMP,'editions',sp.id,'index.html'), renderSpecial(sp,{upd})); }
for(const e of editions) fs.writeFileSync(path.join(TMP,'editions',e.id+'.html'), renderEdition(e,{rel:'../',isCurrent:false,upd,archiveList:archLi(''),currentHref:'../index.html'}));
for(const a of archives) fs.writeFileSync(path.join(TMP,'editions',a.id+'.html'), renderArchive(a,{upd,currentHref:'../index.html'}));
fs.writeFileSync(path.join(TMP,'editions','index.html'), head('Donna Daily — Past editions','Archive of Donna Daily editions','../') + mast('../', `<b>Past editions</b><span class="upd">Last successful update: ${esc(upd)}</span>`) + `<nav class="chips" aria-label="Sections"><div class="wrap"><a class="chip" href="../index.html">Today's edition</a>${dtNav('../')}</div></nav><main id="main"><div class="wrap read"><h2 class="sec">Today</h2><ul class="arch"><li><a href="../index.html"><span class="t">${esc(current.title)} — ${esc(fmtDate(current.date))}</span><span class="s">${current.stories.length} stories · current</span></a></li></ul><h2 class="sec">Earlier</h2><ul class="arch">${archLi('')}</ul></div></main>` + foot('../',upd) + `</body></html>`);
fs.writeFileSync(path.join(TMP,'data.json'), JSON.stringify({current: current.id, lastSuccessfulUpdate: upd, editions: editions.map(e=>({id:e.id,date:e.date,title:e.title,stories:e.stories})), archives: archives.map(a=>({id:a.id,date:a.date,title:a.title})), specials: specials.map(sp=>({id:sp.id,title:sp.title,href:`editions/${sp.id}/index.html`,sections:spCfg(sp).sections,regions:spCfg(sp).regions,updatedAt:sp.updatedAt||null,test:sp.test||null,stories:sp.stories.map(s=>({id:s.id,section:s.section,region:s.region,regions:spRegions(s),opinionKind:s.opinionKind||null,headline:s.headline,image:!!s.image}))}))}));
fs.writeFileSync(path.join(TMP,'.nojekyll'),'');
// copy every edition's photos (data/img/** -> public/img/**) so archived editions keep their images
let nImg=0; (function cp(src,dst){ if(!fs.existsSync(src)) return; for(const d of fs.readdirSync(src,{withFileTypes:true})){ const a=path.join(src,d.name), b=path.join(dst,d.name);
  if(d.isDirectory()) cp(a,b); else if(IMG_EXT.test(d.name)){ fs.mkdirSync(dst,{recursive:true}); fs.copyFileSync(a,b); nImg++; } } })(IMG_DIR, path.join(TMP,'img'));
// atomic-ish swap
const OLD = OUT+'-old'; fs.rmSync(OLD,{recursive:true,force:true});
if(fs.existsSync(OUT)) fs.renameSync(OUT, OLD);
fs.renameSync(TMP, OUT); fs.rmSync(OLD,{recursive:true,force:true});
fs.writeFileSync(path.join(DATA,'state.json'), JSON.stringify({lastSuccessfulBuild: upd, current: current.id, builtAtUTC: new Date().toISOString()},null,1));
const counts = Object.keys(REGIONS).map(r=>`${r}:${current.stories.filter(s=>s.region===r).length}`).join(' ');
for(const sp of specials) console.log(`SPECIAL OK ${sp.id} → editions/${sp.id}/index.html (${Object.keys(spCfg(sp).sections).map(k=>`${k}:${sp.stories.filter(s=>s.section===k).length}`).join(' ')}; ${sp.stories.filter(s=>s.image).length}/${sp.stories.length} with photos)`);
console.log(`BUILD OK ${current.id} (${counts}; ${current.stories.filter(s=>s.image).length}/${current.stories.length} with photos; ${nImg} image files) — ${upd}`);
