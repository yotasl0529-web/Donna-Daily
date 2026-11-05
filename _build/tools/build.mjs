// Donna Daily static site builder. Usage: node tools/build.mjs
// Reads data/editions/*.json, writes public/ atomically, records last successful update in data/state.json.
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DD_DATA ? path.resolve(process.env.DD_DATA) : path.join(ROOT, 'data'), OUT = process.env.DD_OUT ? path.resolve(process.env.DD_OUT) : path.join(ROOT, 'public'), TMP = OUT + '-tmp';
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
// =====================================================================================================
// DAILY TEMPLATE (approved Nov 2026 redesign — see DESIGN.md). Layout, CSS and components live here;
// edition JSON is content only. Do not restyle per edition.
// =====================================================================================================
const photoYear = im => String(im.year || ((/\b(19\d{2}|20\d{2})\b/.exec(im.caption||'')||[])[1]) || '');
const fileTag = im => im.isFilePhoto ? `<b>File photo${photoYear(im)?', '+esc(photoYear(im)):''}</b> · ` : '';
const creditHtml = im => `Photo: <a href="${esc(im.sourcePage)}" target="_blank" rel="noopener noreferrer">${esc(im.credit)}</a> · <a href="${esc(im.licenseUrl)}" target="_blank" rel="noopener noreferrer license">${esc(im.license)}</a>`;
// lead / card figure: photo + caption line (File photo, year · caption · credit · licence)
function figure(im, rel, lead){
  if(!im) return '';
  return `<figure class="ph${lead?' ph-lead':''}"><img src="${esc(rel+im.src)}" width="${+im.width}" height="${+im.height}" alt="${esc(im.alt)}" decoding="async"${lead?' fetchpriority="high"':' loading="lazy"'}><figcaption>${fileTag(im)}${im.caption?esc(im.caption)+' · ':''}${creditHtml(im)}</figcaption></figure>`;
}
// compact thumbnail (regional lists): small 16:9 image beside the text, credit line under the card text
const thumb = (im, rel) => im ? `<div class="thumb"><img src="${esc(rel+im.src)}" width="${+im.width}" height="${+im.height}" alt="${esc(im.alt)}" loading="lazy" decoding="async"></div><p class="phcap">${fileTag(im)}${creditHtml(im)}</p>` : '';

const CSS = `
:root{--ink:#121212;--paper:#fff;--muted:#555;--rule:#dedede;--soft:#f6f5f2;--red:#B0102A;--brand:#C8102E;
--serif:Georgia,"Times New Roman",Times,serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 var(--sans);overflow-wrap:break-word}
a{color:inherit}img{max-width:100%;height:auto}p{margin:0 0 10px}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.wrap{max-width:1200px;margin:0 auto;padding:0 16px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:40}
.hidden{display:none!important}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* ---- masthead: compact, original Donna wordmark ---- */
.mast{border-top:4px solid var(--brand);border-bottom:1px solid var(--rule)}
.mast .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px}
.logo{display:inline-flex;align-items:center;min-height:44px;font:900 23px/1 "Arial Black","Helvetica Neue",Arial,sans-serif;letter-spacing:-.8px;text-transform:uppercase;text-decoration:none;color:var(--ink);white-space:nowrap}
.logo span{display:inline-block;background:var(--brand);color:#fff;padding:2px 5px;margin-left:4px;transform:skewX(-8deg)}
.mlinks{display:flex;align-items:center;gap:4px 16px;font:600 14px/1.2 var(--sans)}
.mlinks a{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;color:var(--red)}
.mlinks a:hover{text-decoration:underline}
.mtag{display:none;color:var(--muted);font-weight:500}
/* ---- edition status (publication time is separate from site maintenance time) ---- */
.edline{font:14px/1.4 var(--sans);color:var(--muted);padding:8px 0 6px}
.edline b{color:var(--ink);font-weight:700}
.edline .pause{display:block}
/* ---- region nav + on-demand search/topics ---- */
nav.regions{border-top:1px solid var(--ink);border-bottom:1px solid var(--rule);background:#fff}
nav.regions .wrap{display:flex;flex-wrap:wrap;align-items:stretch;justify-content:space-between;gap:0 2px}
.chip{flex:0 1 auto;display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 6px;font:600 15px/1.1 var(--sans);text-decoration:none;color:var(--ink);background:none;border:0;border-bottom:3px solid transparent;cursor:pointer;white-space:nowrap}
.chip:hover{color:var(--red)}
.chip[aria-pressed=true]{border-bottom-color:var(--red);color:var(--red);background:var(--soft)}
.chip .lg{display:none}
.ftbar{flex:1 0 100%;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;border-top:1px solid var(--rule);padding:0}
.ftoggle{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0;background:none;border:0;font:600 15px/1.2 var(--sans);color:var(--ink);cursor:pointer}
.ftoggle .chev{display:inline-block;width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px);margin-left:2px}
.ftoggle[aria-expanded=true] .chev{transform:rotate(-135deg) translateY(-2px)}
.fsum{font:14px/1.3 var(--sans);color:var(--muted)}
.js-only{display:none}.js .js-only{display:flex}
#fpanel{padding:4px 0 12px;border-bottom:1px solid var(--rule)}
#fpanel label{display:block;font:700 12px/1.2 var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:8px 0 4px}
#q{width:100%;min-height:44px;font:16px var(--sans);padding:8px 12px;border:1px solid #8a8a8a;border-radius:4px;background:#fff;color:var(--ink)}
.topics{display:flex;flex-wrap:wrap;gap:6px}
.tchip{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid #8a8a8a;border-radius:999px;background:#fff;font:600 14.5px/1.1 var(--sans);color:var(--ink);cursor:pointer}
.tchip .n{font-weight:500;color:var(--muted);font-size:13px}
.tchip[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}.tchip[aria-pressed=true] .n{color:#ddd}
.fstate{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font:14px/1.3 var(--sans);padding:6px 0;border-bottom:1px solid var(--rule)}
.fstate b{font-weight:700}
.btn{min-height:44px;padding:0 14px;border-radius:4px;border:1px solid var(--ink);background:#fff;font:700 15px var(--sans);cursor:pointer;color:var(--ink)}
.btn:hover{background:var(--soft)}
.empty{padding:16px;background:var(--soft);border-left:3px solid var(--red);margin:14px 0}
.empty .btn{margin-top:10px}
/* ---- newer coverage / notices ---- */
.newer{display:block;margin:12px 0 0;padding:8px 0 8px 12px;border-left:3px solid var(--red);text-decoration:none;font:15px/1.4 var(--sans)}
.newer .k{display:block;font:700 12px/1.3 var(--sans);text-transform:uppercase;letter-spacing:.07em;color:var(--red)}
.newer .h{font:700 18px/1.3 var(--serif)}
.newer .t{display:block;color:var(--muted);font-size:13.5px}
.newer:hover .h{text-decoration:underline}
.banner{margin:12px 0 0;padding:10px 12px;background:var(--soft);border-left:3px solid var(--ink);font-size:15px}
.banner a{font-weight:700;color:var(--red)}
/* ---- type ---- */
.kicker,.sec-label{font:700 12px/1.3 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--red)}
h1,h2,h3{font-family:var(--serif);font-weight:700;color:var(--ink)}
h2.sec{font:700 13px/1.2 var(--sans);text-transform:uppercase;letter-spacing:.1em;margin:30px 0 0;padding:10px 0 8px;border-top:2px solid var(--ink);display:flex;align-items:baseline;justify-content:space-between;gap:8px;scroll-margin-top:8px}
h2.sec .count{font-weight:500;letter-spacing:.02em;text-transform:none;color:var(--muted);font-size:13px}
.meta{font:13.5px/1.4 var(--sans);color:var(--muted);margin:0 0 6px}
.meta .lab{margin-right:6px}
.lab{display:inline-block;font:700 11px/1.3 var(--sans);text-transform:uppercase;letter-spacing:.06em;padding:1px 6px;border:1px solid #767676;border-radius:2px;color:var(--ink);vertical-align:1px}
.lab-alleg{border-color:var(--red);color:var(--red)}.lab-sm{border-style:dashed}.lab-op,.lab-ov{background:var(--ink);border-color:var(--ink);color:#fff}
.deck{font:17px/1.5 var(--sans);margin:0 0 8px}
/* ---- story cards ---- */
.card{padding:14px 0;border-bottom:1px solid var(--rule);scroll-margin-top:8px}
.card h3{font-size:21px;line-height:1.22;margin:2px 0 6px;letter-spacing:-.1px}
.card h3 a{text-decoration:none}
.lead{padding:16px 0 12px;border-bottom:0}
.lead h1{font-size:clamp(30px, 18px + 2.2vw, 46px);line-height:1.1;letter-spacing:-.4px;margin:4px 0 8px}
.lead .deck{font-size:18px;line-height:1.5}
.ph{margin:4px 0 10px}
.ph img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:#e9e9e9}
.ph figcaption,.phcap{font:12px/1.4 var(--sans);color:var(--muted);padding:4px 0 0;margin:0}
.ph figcaption b,.phcap b{font-weight:700;color:var(--ink)}
.ph figcaption a,.phcap a{color:var(--muted)}
.why{margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid var(--red);font:16px/1.5 var(--serif);font-style:italic}
.why .wl{display:block;font:700 11.5px/1.4 var(--sans);font-style:normal;text-transform:uppercase;letter-spacing:.07em;color:var(--red)}
.why .wl span{color:var(--muted);font-weight:600;text-transform:none;letter-spacing:0}
/* compact cards: text, small thumbnail on the right, credit line under */
.card.has-thumb{display:grid;grid-template-columns:minmax(0,1fr) 112px;column-gap:14px;align-items:start}
.card.has-thumb>.ctext{grid-column:1;grid-row:1}
.card.has-thumb>.thumb{grid-column:2;grid-row:1;margin-top:4px}
.card.has-thumb>.phcap,.card.has-thumb>details{grid-column:1/-1}
.thumb img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#e9e9e9}
.top-list .card h3{font-size:21px}
/* expansion: native details, no text glyphs (decorative chevron drawn with borders) */
details.more{margin:4px 0 0}
details.more>summary{display:inline-flex;align-items:center;gap:8px;min-height:44px;font:700 14.5px/1.2 var(--sans);color:var(--red);cursor:pointer;list-style:none}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px)}
details.more[open]>summary::after{transform:rotate(-135deg) translateY(-1px)}
details.more>summary .c{color:var(--muted);font-weight:500}
details.more .body{padding:4px 0 6px;font-size:16.5px}
details.more h4{font:700 12px/1.3 var(--sans);text-transform:uppercase;letter-spacing:.07em;margin:14px 0 4px}
.basis{font:14px/1.45 var(--sans);color:#333}
.note{font-size:15px;color:#333}.note b{color:#000}
.srcs{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:6px}
.srcs a{display:flex;flex-direction:column;justify-content:center;min-height:48px;padding:7px 11px;border:1px solid #cfcfcf;border-radius:4px;text-decoration:none;background:#fff}
.srcs a:hover{border-color:var(--red)}
.srcs .t{font:700 15px/1.3 var(--sans);text-decoration:underline;text-decoration-color:#bbb}
.srcs .s{font-size:13px;color:var(--muted)}
.chk{list-style:none;margin:4px 0 2px;padding:0 0 0 12px;border-left:2px solid var(--rule);font-size:13px;line-height:1.45;color:#333}
.chk li{margin:2px 0}.chk .lim{color:#7a3300}
.ptr{font:15px/1.5 var(--sans);color:var(--muted);padding:10px 0;margin:0;border-bottom:1px solid var(--rule)}
.ptr a{color:var(--ink)}
/* ---- past editions ---- */
.arch{list-style:none;padding:0;margin:4px 0 0}
.arch li{border-bottom:1px solid var(--rule)}
.arch a{display:flex;flex-direction:column;justify-content:center;min-height:52px;padding:8px 0;text-decoration:none}
.arch a:hover .t{color:var(--red);text-decoration:underline}
.arch .t{font:700 17px/1.3 var(--serif)}.arch .s{font-size:13.5px;color:var(--muted)}
.arch .none{color:var(--muted);padding:10px 0}
.archgrp{margin:6px 0 10px}
.archgrp .sub{font:700 20px/1.25 var(--serif);margin:14px 0 2px;padding-bottom:4px;border-bottom:1px solid var(--ink)}
.archgrp .cnt{font:500 14px var(--sans);color:var(--muted)}
.allpast{display:inline-flex;align-items:center;min-height:44px;font:700 15px var(--sans);color:var(--red)}
/* ---- about / legend / footer ---- */
details.about,details.guide{margin-top:20px;border-top:1px solid var(--rule);padding-top:4px}
details.about>summary,details.guide>summary{min-height:44px;display:flex;align-items:center;font:700 15px var(--sans);cursor:pointer}
details.about h3{font-size:17px;margin:14px 0 6px}
details.about ul{padding-left:20px;font-size:14.5px}details.about li{margin:4px 0}
.srcnote{font-size:15px;color:#333}
.totop{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:30;display:none;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;background:var(--ink);color:#fff;font:700 14px var(--sans);text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.js .totop.show{display:inline-flex}
footer{border-top:2px solid var(--ink);margin-top:32px;padding:14px 0 48px;font-size:13.5px;color:var(--muted)}
footer a{display:inline-flex;align-items:center;min-height:44px;color:var(--ink)}
footer .upd{font-size:13px}
/* archive snapshot blocks (kind:"archive") */
.blk h3{font-size:20px;margin:18px 0 8px}
dl.props dt{font:700 12px var(--sans);text-transform:uppercase;letter-spacing:.05em;color:var(--red);margin-top:10px}dl.props dd{margin:2px 0 0}
.rows{list-style:none;padding:0;margin:0}.rows li{border-bottom:1px solid var(--rule);padding:10px 0}.rows .h{font-weight:700}.rows .m{font-size:13px;color:var(--muted)}
.callout{background:var(--soft);border-left:3px solid var(--red);padding:10px 12px;margin:8px 0}
/* ---- phones ---- */
@media (max-width:379.98px){.chip{padding:0 3px;font-size:14.5px}.mlinks{gap:4px 10px}}
/* ---- tablet ---- */
@media (min-width:760px){
.wrap{padding:0 24px}
.logo{font-size:28px}
.mtag{display:inline}
.chip{padding:0 12px}.chip .sh{display:none}.chip .lg{display:inline}
nav.regions .wrap{justify-content:flex-start;gap:0 4px}
.card h3{font-size:22px}
.card.has-thumb{grid-template-columns:minmax(0,1fr) 168px;column-gap:18px}
.regions-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px;align-items:start}
.srcs{grid-template-columns:1fr 1fr}
.arch.cols{display:grid;grid-template-columns:1fr 1fr;column-gap:24px}
}
/* ---- desktop: lead ~2/3 + supporting column, compact regional sections ---- */
@media (min-width:1024px){
.wrap{padding:0 32px}
.mast .wrap{min-height:64px}.logo{font-size:34px}
nav.regions{position:sticky;top:0;z-index:20;box-shadow:0 1px 0 var(--rule)}
.edline{display:flex;flex-wrap:wrap;gap:2px 18px;align-items:baseline}
.edline .pause{display:inline}
.ftbar{flex:0 1 auto;margin-left:auto;border-top:0;gap:4px 16px}.ftbar .fsum{order:-1}
.front{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);column-gap:40px;align-items:start;margin-top:4px}
.front.nolead{grid-template-columns:minmax(0,1fr)}
.front.nolead .top-list{border-left:0;padding-left:0}
.top-list{border-left:1px solid var(--rule);padding-left:28px}
.top-list h2.sec{margin-top:16px}
.lead .lbody{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);column-gap:28px;align-items:start}
.lead .lbody.noph{grid-template-columns:minmax(0,1fr)}
.lead .lbody>.ph{grid-column:2;grid-row:1/span 2;margin-top:4px}
.lead .lbody>:not(.ph){grid-column:1}
.lead .lbody>details.more{grid-column:1/-1;grid-row:3}
.top-list .card h3{font-size:22px}.top-list .deck{font-size:16px}
.regions-grid{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:36px}
.regions-grid>section{min-width:0}
.card.has-thumb{grid-template-columns:minmax(0,1fr) 120px;column-gap:14px}
.regions-grid .card h3{font-size:20px}
.srcs{grid-template-columns:1fr}
.lead .srcs{grid-template-columns:1fr 1fr}
.arch.cols{grid-template-columns:repeat(3,1fr)}
main .wrap.read{max-width:880px}
.totop{display:none!important}
h2.sec{scroll-margin-top:60px}.card{scroll-margin-top:60px}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const JS = `
(function(){var d=document;d.documentElement.classList.add('js');
var tt=d.getElementById('totop');if(tt){var onS=function(){tt.classList.toggle('show',(window.scrollY||d.documentElement.scrollTop)>700);};addEventListener('scroll',onS,{passive:true});onS();}
var A=function(s){return [].slice.call(d.querySelectorAll(s));};
var q=d.getElementById('q');if(!q)return;
var tog=d.getElementById('ftoggle'),pan=d.getElementById('fpanel'),fsum=d.getElementById('fsum'),fst=d.getElementById('fstate'),fstt=d.getElementById('fstatetxt'),clr=d.getElementById('fclear'),em=d.getElementById('fempty'),emt=d.getElementById('femptytxt'),rst=d.getElementById('freset'),front=d.getElementById('front'),leadS=d.getElementById('lead-sec'),topS=d.getElementById('top-sec');
var cards=A('[data-story]'),secs=A('[data-region-sec]'),chips=A('[data-chip]'),tch=A('[data-tchip]'),ptrs=A('[data-ptr]'),emptyR=A('[data-empty-region]');
var RN=${'${RNJSON}'},TN=${'${TNJSON}'};var S={reg:'all',top:'all'};
tog.addEventListener('click',function(){var o=tog.getAttribute('aria-expanded')!=='true';tog.setAttribute('aria-expanded',String(o));pan.hidden=!o;if(o)q.focus();});
function m(c,r,t,qs){return (r==='all'||c.dataset.region===r)&&(t==='all'||c.dataset.topic===t)&&(!qs||c.textContent.toLowerCase().indexOf(qs)>-1);}
function apply(){var qs=q.value.trim().toLowerCase(),n=0;
cards.forEach(function(c){var ok=m(c,S.reg,S.top,qs);c.classList.toggle('hidden',!ok);if(ok)n++;});
var on=S.reg!=='all'||S.top!=='all'||!!qs;
secs.forEach(function(s){s.classList.toggle('hidden',!s.querySelector('[data-story]:not(.hidden)')&&(on||!s.querySelector('[data-ptr],[data-empty-region]')));});
ptrs.forEach(function(p){p.classList.toggle('hidden',on);});emptyR.forEach(function(p){p.classList.toggle('hidden',on);});
var lv=!!(leadS&&leadS.querySelector('[data-story]:not(.hidden)')),tv=!!(topS&&topS.querySelector('[data-story]:not(.hidden)'));
if(leadS)leadS.classList.toggle('hidden',!lv);if(topS)topS.classList.toggle('hidden',!tv);if(front){front.classList.toggle('nolead',!lv);front.classList.toggle('hidden',!lv&&!tv);}
chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.chip===S.reg));});
tch.forEach(function(c){var v=c.dataset.tchip;c.setAttribute('aria-pressed',String(v===S.top));var k=0;cards.forEach(function(x){if(m(x,S.reg,v,''))k++;});c.querySelector('.n').textContent=k;});
var parts=[];if(S.reg!=='all')parts.push(RN[S.reg]);if(S.top!=='all')parts.push(TN[S.top]);if(qs)parts.push('\\u201c'+q.value.trim()+'\\u201d');
fsum.textContent=on?('Showing '+n+' of '+cards.length):(cards.length+' stories');
fst.classList.toggle('hidden',!on);fstt.textContent='Showing '+n+' of '+cards.length+' stories'+(parts.length?': '+parts.join(' \\u00b7 '):'');
if(n===0){var tz=S.top!=='all'&&!cards.some(function(c){return c.dataset.topic===S.top;}),rz=S.reg!=='all'&&!cards.some(function(c){return c.dataset.region===S.reg;});
emt.textContent=rz?('No '+RN[S.reg]+' stories in this edition.'):tz?('No '+TN[S.top]+' stories in this edition.'):('No stories match'+(qs?' \\u201c'+q.value.trim()+'\\u201d':'')+(S.reg!=='all'?' in '+RN[S.reg]:'')+(S.top!=='all'?' in '+TN[S.top]:'')+'. Try another word or show all stories.');}
em.classList.toggle('hidden',n>0);
try{var u=new URL(location.href);['region','topic','q'].forEach(function(x){u.searchParams.delete(x)});if(S.reg!=='all')u.searchParams.set('region',S.reg);if(S.top!=='all')u.searchParams.set('topic',S.top);if(qs)u.searchParams.set('q',q.value.trim());history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
function reset(){q.value='';S.reg='all';S.top='all';apply();}
function act(el,fn){el.addEventListener('click',function(e){e.preventDefault();fn();});el.addEventListener('keydown',function(e){if(e.key===' '){e.preventDefault();fn();}});}
chips.forEach(function(c){act(c,function(){var v=c.dataset.chip;S.reg=(v==='all'||S.reg===v)?'all':v;apply();var nv=d.getElementById('regions');if(nv&&nv.getBoundingClientRect().top<0&&getComputedStyle(nv).position!=='sticky')nv.scrollIntoView();});});
tch.forEach(function(c){act(c,function(){var v=c.dataset.tchip;S.top=(v==='all'||S.top===v)?'all':v;apply();});});
q.addEventListener('input',apply);clr.addEventListener('click',reset);rst.addEventListener('click',function(){reset();var nv=d.getElementById('regions');if(nv)nv.scrollIntoView();});
var p=new URLSearchParams(location.search);if(RN[p.get('region')])S.reg=p.get('region');if(TN[p.get('topic')])S.top=p.get('topic');if(p.get('q'))q.value=p.get('q');
if(p.get('topic')||p.get('q')){tog.setAttribute('aria-expanded','true');pan.hidden=false;}
apply();})();
`.replace('${RNJSON}', JSON.stringify(REGIONS)).replace('${TNJSON}', JSON.stringify(TOPICS));

// ---------- sources & checks ----------
// checks: map url -> [{by, at?, ok:[], lim:[]}] built from story.sourceChecks and the automated link-check record (data/checks/<id>-links.json)
function chkLines(list){
  if(!list?.length) return '';
  return `<ul class="chk">${list.map(c=>c.auto
    ? `<li${c.ok?'':' class="lim"'}>${esc(c.result)} · automated link check${c.checkedAt?`, ${esc(nyTime(c.checkedAt))}`:''} (checks the link opens, not the claims)</li>`
    : `<li><b>${esc(c.checkedBy)}</b>${c.checkedAt?` (${esc(nyTime(c.checkedAt))})`:''}${c.claimsSupported?.length?`: supports — ${c.claimsSupported.map(esc).join('; ')}`:''}${c.limits?.length?`<span class="lim">${c.claimsSupported?.length?' · ':': '}Limit — ${c.limits.map(esc).join('; ')}</span>`:''}</li>`).join('')}</ul>`;
}
const srcList = (srcs, checks) => `<ul class="srcs">${srcs.map(l=>`<li><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc(l.title)}</span><span class="s">${esc(l.site)}${l.date?' · '+esc(l.date):''}<span aria-hidden="true">&nbsp;↗</span></span></a>${checks?chkLines(checks(l.href)):''}</li>`).join('')}</ul>`;
const TSHORT = {politics:'Politics', business:'Business & tech', culture:'Culture', sports:'Sports', human:'Human interest'};
// concise attribution near the preview: "CBS News, NPR and 2 more · Nov 3 (Election Day morning)"
function attrib(s){
  const sites=[...new Set(s.sources.map(l=>l.site))]; const more=sites.length-2;
  const who = sites.slice(0,2).join(', ') + (more>0?` and ${more} more`:'');
  return `${esc(who)} · ${esc(String(s.dateLabel).replace(/,? 20\d\d\b/,''))}`;
}
// only labels that change how to read the story are shown on the preview; plain "Reported" is the default and appears in the expanded view
const keyBadges = label => labelParts(label).filter(b=>b.k!=='rep').map(b=>`<span class="lab ${LABELS[b.k].cls}" title="${esc(LABELS[b.k].desc)}">${esc(b.text)}</span>`).join('');
const basis = label => `<p class="basis"><b>Basis:</b> ${labelParts(label).map(b=>`${esc(b.text)} — ${esc(LABELS[b.k].desc)}`).join(' ')}</p>`;
const whyBox = s => `<div class="why"><span class="wl">Why it matters <span>· Donna Daily analysis</span></span>${esc(s.why)}</div>`;
// variant: 'lead' | 'top' (supporting, text-only) | 'compact' (regional list, small thumbnail)
function storyCard(s, variant, rel='', checksFor=null){
  let [deck, rest] = splitDeck(s); const n = s.sources.length;
  // supporting column: one-sentence deck; the remainder moves into the expanded view (nothing is dropped)
  if(variant==='top'){ const ss=deck.split(/(?<=[.!?][’'"”)]?)\s+(?=[A-Z‘“"'(])/); if(ss.length>1 && ss[0].length>=60){ deck=ss[0]; rest=[ss.slice(1).join(' '), rest].filter(Boolean).join(' '); } }
  const kicker = `<span class="kicker">${esc(REGIONS[s.region])} · ${esc(TSHORT[s.topic])}</span>`;
  const meta = `<p class="meta">${keyBadges(s.label)}${attrib(s)}</p>`;
  const photoNote = (variant!=='lead' && s.image) ? `<p class="note"><b>About the photo:</b> ${s.image.isFilePhoto?'File photo. ':''}${esc(s.image.caption||s.image.alt)}${variant==='top'?` Photo: <a href="${esc(s.image.sourcePage)}" target="_blank" rel="noopener noreferrer">${esc(s.image.credit)}</a>, <a href="${esc(s.image.licenseUrl)}" target="_blank" rel="noopener noreferrer license">${esc(s.image.license)}</a>.`:''}</p>` : '';
  const more = `<details class="more"><summary>${variant==='lead'?'Full story, sources &amp; checks':'More'}<span class="c">${n} source${n===1?'':'s'}</span></summary><div class="body">${variant!=='lead'?whyBox(s):''}${rest?`<p>${esc(rest)}</p>`:''}${s.note?`<p class="note"><b>Note:</b> ${esc(s.note)}</p>`:''}${photoNote}${basis(s.label)}<h4>Sources &amp; checks</h4>${srcList(s.sources, checksFor?(u=>checksFor(s,u)):null)}</div></details>`;
  const attrs = `id="${esc(s.id)}" data-story data-region="${s.region}" data-topic="${s.topic}"`;
  if(variant==='lead') return `<article class="card lead${s.image?' has-ph':''}" ${attrs}>${kicker}<h1>${esc(s.headline)}</h1>${meta}<div class="lbody${s.image?'':' noph'}"><p class="deck">${esc(deck)}</p>${figure(s.image,rel,true)}${whyBox(s)}${more}</div></article>`;
  if(variant==='top') return `<article class="card" ${attrs}>${kicker}<h3>${esc(s.headline)}</h3>${meta}<p class="deck">${esc(deck)}</p>${more}</article>`;
  return `<article class="card${s.image?' has-thumb':''}" ${attrs}><div class="ctext"><span class="kicker">${esc(TSHORT[s.topic])}</span><h3>${esc(s.headline)}</h3>${meta}<p class="deck">${esc(deck)}</p></div>${thumb(s.image,rel)}${more}</article>`;
}

function head(title, desc){ return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#C8102E"><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23C8102E'/%3E%3Ctext x='32' y='46' font-size='40' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='%23fff'%3ED%3C/text%3E%3C/svg%3E"><style>${CSS}</style></head><body><a class="skip" href="#main">Skip to stories</a>`; }
function mast(rel){ return `<header class="mast"><div class="wrap"><a class="logo" href="${rel}index.html" aria-label="Donna Daily, latest edition">Donna<span>Daily</span></a><div class="mlinks"><a href="${rel}editions/index.html" data-past>Past editions</a></div></div></header>`; }
// region nav. On the live front page the items filter (role=button, aria-pressed); elsewhere they link to the latest edition's region view
function regionNav(rel, live, extra=''){
  const item = (k, sh, lg) => live
    ? `<a class="chip" href="#${k==='all'?'main':'region-'+k}" role="button" data-chip="${k}" aria-pressed="${k==='all'}"${k!=='all'?` aria-label="${esc(REGIONS[k])}"`:' aria-label="All regions"'}><span class="sh" aria-hidden="true">${esc(sh)}</span><span class="lg" aria-hidden="true">${esc(lg)}</span></a>`
    : `<a class="chip" href="${rel}index.html${k==='all'?'':'?region='+k}"${k!=='all'?` aria-label="${esc(REGIONS[k])}"`:' aria-label="All regions"'}><span class="sh" aria-hidden="true">${esc(sh)}</span><span class="lg" aria-hidden="true">${esc(lg)}</span></a>`;
  return `<nav class="regions" id="regions" aria-label="Regions"><div class="wrap">${item('all','All','All')}${Object.keys(REGIONS).map(r=>item(r, r==='hk'?'HK':SHORT[r], REGIONS[r]==='United States'?'US':REGIONS[r])).join('')}${extra}</div></nav>`;
}
const foot = (rel, upd) => `<footer><div class="wrap"><p><b>Donna Daily</b> is a personal news digest for Derek, compiled by Donna (Grok Bot). Summaries are original; follow the source links for full reporting. Some sources (e.g. SCMP) may be paywalled.</p><p class="upd">Site last rebuilt ${esc(upd)}. Rebuilds can change the design; they never re-date or rewrite a published edition. <a href="${rel}editions/index.html">Past editions</a></p></div></footer>`;
const LEGEND = `<details class="guide"><summary>How to read the labels</summary>${Object.values(DAILY_LABELS).map(l=>`<p><span class="lab ${l.cls}">${esc(l.text)}</span> ${esc(l.desc)}</p>`).join('')}<p>Labels describe the type of claim a story rests on; they are not a verification grade. Story previews show a label only when it changes how to read the story (an official statement, claim, allegation, analysis, unnamed sources or state media); plain reporting is the default and is stated in each story’s expanded view. Older editions used “Fact”; it is shown as “Reported”. <b>Why it matters</b> is Donna Daily’s own analysis, kept apart from the sourced reporting. Photos are openly licensed (Wikimedia Commons CC0/public domain/CC BY/CC BY-SA, or US-government public domain), cropped to fit and credited beside each picture. “File photo” (with the year when known) means the picture shows the person or place, not the event in the story.</p></details>`;
const SOURCING = `<p class="srcnote"><b>How this edition is sourced.</b> Stories are compiled from the linked sources and the summaries are original. Labels reflect the type of claim (reported by outlets, an official statement, a claim, an allegation or analysis); they are not a verification grade, and not every claim has been independently verified. Follow the links for full reporting.</p>`;

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
const ET = iso => new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET';
// Supporting stories: ed.topIds if given, else the first story of each region other than the lead, topped up to 5.
function pickTop(stories, lead, ed){
  let picks = (ed.topIds||[]).map(id=>stories.find(s=>s.id===id)).filter(s=>s&&s.id!==lead.id);
  if(!picks.length){ for(const r of Object.keys(REGIONS)){ const s=stories.find(x=>x.region===r&&x.id!==lead.id); if(s) picks.push(s); }
    for(const s of stories){ if(picks.length>=5) break; if(s.id!==lead.id && !picks.includes(s)) picks.push(s); } }
  return picks.slice(0,5);
}
function renderEdition(ed, {rel, isCurrent, upd, archiveList, currentHref, current, specials=[], notices=[]}){
  const stories = ed.stories; const lead = stories.find(s=>s.id===ed.leadId) || stories[0];
  const CI = checksIndex(ed); const top = pickTop(stories, lead, ed); const onFront = new Set([lead.id, ...top.map(s=>s.id)]);
  const nT = t => stories.filter(s=>s.topic===t).length;
  const pub = ed.publishedAt ? `Published ${esc(ET(ed.publishedAt))}` : `Published ${esc(fmtDate(ed.date))}`;
  const pubTime = ed.publishedAt ? `<time datetime="${esc(ed.publishedAt)}">${pub}</time>` : pub;
  // newer coverage: featured specials updated after this edition was published (front page only)
  const newer = isCurrent ? specials.filter(sp=>sp.featured && (sp.updatedAt||sp.date+'T23:59:00-05:00') > (ed.publishedAt||ed.date)).slice(0,1).map(sp=>`<a class="newer" href="${rel}editions/${esc(sp.id)}/index.html"><span class="k">Newer coverage · Special edition</span><span class="h">${esc(sp.bannerHeadline||sp.title)}</span><span class="t">${esc(sp.strapLabel||sp.title)} · ${sp.updatedAt?`Updated <time datetime="${esc(sp.updatedAt)}">${esc(ET(sp.updatedAt))}</time>`:esc(sp.publishedLabel||fmtDate(sp.date))}</span></a>`).join('') : '';
  const pause = isCurrent ? notices.map(n=>`<span class="pause">${esc(n.text)}</span>`).join('') : '';
  const edline = `<div class="edline"><span><b>${esc(ed.title)}</b> · ${pubTime}${isCurrent?' · Latest daily edition':''}</span>${pause}</div>`;
  const topicChips = [['all','All topics',stories.length],...Object.keys(TOPICS).map(t=>[t,TSHORT[t],nT(t)])].map(([k,v,n])=>`<button type="button" class="tchip" data-tchip="${k}" aria-pressed="${k==='all'}"><span>${esc(v)}</span><span class="n">${n}</span></button>`).join('');
  const ftbar = `<div class="ftbar js-only"><button type="button" class="ftoggle" id="ftoggle" aria-expanded="false" aria-controls="fpanel">Search &amp; topics<span class="chev" aria-hidden="true"></span></button><span class="fsum" id="fsum" aria-live="polite">${stories.length} stories</span></div>`;
  const tools = `<div id="fpanel" hidden><form role="search" onsubmit="return false"><label for="q">Search this edition</label><input id="q" type="search" placeholder="e.g. election, Hormuz, Tai Po" autocomplete="off"></form><div role="group" aria-labelledby="tlab"><label id="tlab">Topics</label><div class="topics">${topicChips}</div></div></div>` +
    `<div class="fstate hidden" id="fstate" role="status"><span id="fstatetxt"></span><button type="button" class="btn" id="fclear">Clear filters</button></div>` +
    `<div class="empty hidden" id="fempty" role="status"><span id="femptytxt">No stories match.</span><br><button type="button" class="btn" id="freset">Show all stories</button></div>`;
  const regionSecs = Object.keys(REGIONS).map(r=>{ const all=stories.filter(s=>s.region===r); const items=all.filter(s=>!onFront.has(s.id)); const up=all.filter(s=>onFront.has(s.id));
    const ptr = up.length ? `<p class="ptr" data-ptr>${items.length?'Also in this edition: ':'In this edition: '}${up.map(s=>`<a href="#${esc(s.id)}">${esc(s.headline)}</a>`).join('; ')}${up.length?' (above).':''}</p>` : '';
    const empty = all.length ? '' : `<p class="ptr" data-empty-region>No ${esc(REGIONS[r])} stories in this edition.</p>`;
    return `<section data-region-sec id="region-${r}" aria-labelledby="h-${r}"><h2 class="sec" id="h-${r}">${esc(REGIONS[r])}<span class="count">${all.length} ${all.length===1?'story':'stories'}</span></h2>${items.map(s=>storyCard(s,'compact',rel,CI.forUrl)).join('')}${ptr}${empty}</section>`; }).join('');
  return head(`Donna Daily — ${ed.title}, ${fmtDate(ed.date)}`, 'Sourced US, Canada, Hong Kong, China and world news, labelled by type of claim.') + mast(rel) +
  `<div class="wrap">${edline}</div>` + regionNav(rel, true, ftbar) +
  `<main id="main"><div class="wrap">` + tools +
  (isCurrent?'':`<div class="banner">Archived edition, kept as published (${pub}). <a href="${currentHref}">Go to the latest edition<span aria-hidden="true">&nbsp;→</span></a></div>`) +
  newer +
  `<div class="front" id="front"><section id="lead-sec" aria-label="Lead story">${storyCard(lead,'lead',rel,CI.forUrl)}</section>` +
  (top.length?`<section class="top-list" id="top-sec" aria-labelledby="h-top"><h2 class="sec" id="h-top">Top stories</h2>${top.map(s=>storyCard(s,'top',rel,CI.forUrl)).join('')}</section>`:'') + `</div>` +
  `<div class="regions-grid">${regionSecs}</div>` +
  `<section id="archive" aria-labelledby="h-arch"><h2 class="sec" id="h-arch">Past editions</h2>${archiveList}</section>` +
  aboutEdition(ed, lead, CI) + LEGEND +
  `</div></main><a class="totop" id="totop" href="#regions"><span aria-hidden="true">↑&nbsp;</span>Regions</a>` + foot(rel, upd) + `<script>${JS}</script></body></html>`;
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
  return head(`Donna Daily archive — ${ed.title}, ${fmtDate(ed.date)}`, deblanket(ed.summary||'')) + mast(rel) +
  `<div class="wrap"><div class="edline"><span><b>Archive · ${esc(ed.title)}</b> · ${esc(fmtDate(ed.date))} · Originally published ${esc(ed.updatedLabel||'')}</span></div></div>` + regionNav(rel, false) + `<main id="main"><div class="wrap read">` +
  `<div class="banner">Archived brief, kept as originally published (snapshot; not updated). <a href="${currentHref}">Go to the latest edition<span aria-hidden="true">&nbsp;→</span></a>${ed.droppedSections?.length?' A personal travel note was removed from this public copy.':''}</div>` +
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
:root{--ink:#121212;--paper:#fff;--muted:#555;--rule:#dedede;--soft:#f6f5f2;--acc:#B0102A;--accl:#f8e8eb;--brand:#C8102E}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit}img{max-width:100%;height:auto}
.serif,h1,h2,h3,.wm{font-family:Georgia,"Times New Roman",Times,serif}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:9}
.hidden{display:none!important}
.mast{border-top:4px solid var(--brand);border-bottom:1px solid var(--rule)}
.mast .wrap{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:54px}
.wm{font:900 22px/1 "Arial Black","Helvetica Neue",Arial,sans-serif;letter-spacing:-.8px;text-transform:uppercase;text-decoration:none;display:inline-flex;align-items:center;min-height:44px;white-space:nowrap}
.wm .dl{display:inline-block;background:var(--brand);color:#fff;padding:2px 5px;margin-left:4px;transform:skewX(-8deg)}
.wm i{font:italic 400 20px/1 Georgia,"Times New Roman",serif;text-transform:none;letter-spacing:0;color:var(--acc);margin-left:8px}
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
.lab-ov{background:var(--ink);color:#fff;border:1px solid var(--ink)}
.why{border-left:3px solid var(--acc);padding:4px 0 4px 12px;margin:8px 0;font-size:15.5px}
.why b{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--acc)}
details.more>summary{display:flex;align-items:center;min-height:44px;font-weight:700;font-size:15px;cursor:pointer;color:var(--acc);list-style:none}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:after{content:"";width:7px;height:7px;margin-left:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px)}details.more[open]>summary:after{transform:rotate(-135deg) translateY(-1px)}
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
 .mast .wrap{min-height:64px}.wm{font-size:30px}.wm i{font-size:26px}
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Donna Daily — ${esc(sp.title)}</title><meta name="description" content="${esc(sp.intro)}"><meta name="theme-color" content="#C8102E"><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23C8102E'/%3E%3Ctext x='32' y='45' font-size='38' font-family='Georgia,serif' font-weight='700' text-anchor='middle' fill='%23fff'%3ED%3C/text%3E%3C/svg%3E"><style>${SP_CSS}</style></head><body><a class="skip" href="#main">Skip to stories</a>` +
  `<header class="mast"><div class="wrap"><a class="wm" href="${rel}index.html" aria-label="Donna Daily, latest edition">Donna<span class="dl">Daily</span><i aria-hidden="true">${esc(C.wordmark)}</i></a><a class="back" href="${rel}index.html">Latest edition<span aria-hidden="true">&nbsp;→</span></a></div></header>` +
  `<div class="wrap"><div class="ttl"><div><p class="kick">Special edition · ${esc(sp.publishedLabel||fmtDate(sp.date))}${sp.updatedAt?` · <time datetime="${esc(sp.updatedAt)}">Last updated ${esc(nyTime(sp.updatedAt))}</time>`:''}</p><h1>${esc(sp.title)}</h1></div><p class="intro">${esc(sp.intro)}</p></div></div>` +
  `<div class="wrap"><nav class="snav" id="snav" aria-label="Sections and regions"><div class="tabs">${tabs}</div><div class="regs jsonly">${regs}</div><form class="srch jsonly" role="search" onsubmit="return false"><label for="q">Search this edition</label><input id="q" type="search" placeholder="${esc(C.searchHint)}" autocomplete="off"></form><div class="status jsonly"><span id="fsum" aria-live="polite">${st.length} ${esc(C.unit)}</span><button type="button" class="btn hidden" id="fclear">Show all stories</button></div></nav></div>` +
  `<main id="main"><div class="wrap"><div class="empty hidden" id="fempty" role="status"><span id="femptytxt">No stories match.</span><br><button type="button" class="btn" id="freset" style="margin-top:10px">Show all stories</button></div>` +
  `<div class="top" id="top"><div id="leadbox">${spCard(lead,CI,rel,true,C)}</div>${glance}</div>` + body + about + legend +
  `</div></main><a class="totop" id="totop" href="#snav"><span aria-hidden="true">↑&nbsp;</span>Back to top</a><footer><div class="wrap"><p><b>Donna Daily</b> · ${esc(sp.title)} is a special edition compiled by Donna (Grok Bot). Summaries and analysis are original; follow the source links for full reporting. Some sources are paywalled.</p><p><a href="${rel}index.html">Latest edition</a> · <a href="${rel}editions/index.html">Past editions</a></p><p>Site last rebuilt ${esc(upd)}. Rebuilds can change the design; the reporting stays as of the “last updated” time above.</p></div></footer><script>${spJs(Object.assign({},C.sections,Object.fromEntries(Object.entries(C.regions).map(([k,v])=>[k,(sp.regionPhrases||(sp.regionLabels?{}:{us:'the United States'}))[k]||v]))), C.unit)}</script></body></html>`;
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
// Edition publication times (data/published.json). A new edition without one gets this build's time recorded once.
const PUB_F = path.join(DATA,'published.json');
const PUBLOG = (()=>{ try{ return JSON.parse(fs.readFileSync(PUB_F,'utf8')); }catch{ return {}; } })();
const isoNY = d => { const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).formatToParts(d).map(x=>[x.type,x.value]));
  const off=(/GMT([+-]\d+)/.exec(p.timeZoneName)||[,'-5'])[1]; const oh=String(Math.abs(+off)).padStart(2,'0'); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${+off<0?'-':'+'}${oh}:00`; };
let pubChanged=false;
for(const e of editions){ if(!e.publishedAt && PUBLOG[e.id]) e.publishedAt=PUBLOG[e.id]; }
if(!current.publishedAt){ current.publishedAt=isoNY(new Date()); PUBLOG[current.id]=current.publishedAt; pubChanged=true; }
for(const e of editions) if(e.publishedAt && !isoOk(e.publishedAt)) { console.error(`BUILD FAILED: ${e.id} publishedAt must be ISO with offset`); process.exit(1); }
// Site notices (data/site.json): shown on the front page only while the build time is before showUntil.
const SITE = (()=>{ try{ return JSON.parse(fs.readFileSync(path.join(DATA,'site.json'),'utf8')); }catch{ return {}; } })();
const notices = (SITE.notices||[]).filter(n=>n.text && (!n.showUntil || Date.now() < Date.parse(n.showUntil)));
// DD_KEEP_UPD=1 reuses the previous state.json time (for maintenance rebuilds that publish no new edition)
const prevState = (()=>{ try{ return JSON.parse(fs.readFileSync(path.join(DATA,'state.json'),'utf8')); }catch{ return null; } })();
const upd = (process.env.DD_KEEP_UPD==='1' && prevState?.lastSuccessfulBuild) ? prevState.lastSuccessfulBuild : nyNow();
// Past editions are listed in two separate groups: Daily editions (Morning/Evening) and Special editions, each newest first.
const pastDaily = [...editions.slice(1), ...archives].sort((a,b)=>a.date<b.date||(a.date===b.date&&a.id<b.id)?1:-1);
const specLi = (relE) => specials.map(sp=>`<li class="spec"><a href="${relE}${sp.id}/index.html"><span class="t">${esc(sp.title)}</span><span class="s">Special edition · ${sp.stories.length} stories · ${sp.updatedAt?'Updated '+esc(ET(sp.updatedAt)):esc(sp.publishedLabel||fmtDate(sp.date))}</span></a></li>`).join('');
const dailyLi = (relE) => pastDaily.map(e=>`<li><a href="${relE}${e.id}.html"><span class="t">${esc(e.title)} — ${esc(fmtDate(e.date))}</span><span class="s">${e.kind==='archive'?'Earlier brief (snapshot)':`${e.stories.length} stories${e.publishedAt?' · Published '+esc(ET(e.publishedAt)):''}`}</span></a></li>`).join('');
const plural = (n,w) => `${n} ${w}${n===1?'':'s'}`;
// tag: heading element (h2 on the Past editions page, h3 inside the front page's Past editions section)
const archGroups = (relE, tag='h3') =>
  `<div class="archgrp" id="daily-editions"><${tag} class="sub">Daily editions <span class="cnt">(${plural(pastDaily.length,'edition')})</span></${tag}><ul class="arch arch-daily">${dailyLi(relE)||'<li class="none">No past daily editions yet.</li>'}</ul></div>` +
  `<div class="archgrp" id="special-editions"><${tag} class="sub">Special editions <span class="cnt">(${plural(specials.length,'edition')})</span></${tag}><ul class="arch arch-special">${specLi(relE)||'<li class="none">No special editions yet.</li>'}</ul></div>`;
// front page: the 6 newest daily editions and every special, then a link to the full list
const archLi = (relE, allHref) => { const full=archGroups(relE,'h3'); if(pastDaily.length<=6) return full + `<a class="allpast" href="${allHref}">All past editions<span aria-hidden="true">&nbsp;→</span></a>`;
  const short = full.replace(/(<ul class="arch arch-daily">)([\s\S]*?)(<\/ul>)/, (m,a,b,c)=>a+b.split('</li>').slice(0,6).join('</li>')+'</li>'+c); return short + `<a class="allpast" href="${allHref}">All past editions<span aria-hidden="true">&nbsp;→</span></a>`; };

fs.rmSync(TMP,{recursive:true,force:true}); fs.mkdirSync(path.join(TMP,'editions'),{recursive:true});
fs.writeFileSync(path.join(TMP,'index.html'), renderEdition(current,{rel:'',isCurrent:true,upd,archiveList:archLi('editions/','editions/index.html'),specials,notices}));
for(const sp of specials){ fs.mkdirSync(path.join(TMP,'editions',sp.id),{recursive:true}); fs.writeFileSync(path.join(TMP,'editions',sp.id,'index.html'), renderSpecial(sp,{upd})); }
for(const e of editions) fs.writeFileSync(path.join(TMP,'editions',e.id+'.html'), renderEdition(e,{rel:'../',isCurrent:false,upd,archiveList:archLi('','index.html'),currentHref:'../index.html',specials}));
for(const a of archives) fs.writeFileSync(path.join(TMP,'editions',a.id+'.html'), renderArchive(a,{upd,currentHref:'../index.html'}));
fs.writeFileSync(path.join(TMP,'editions','index.html'), head('Donna Daily — Past editions','Archive of Donna Daily editions') + mast('../') + `<div class="wrap"><div class="edline"><span><b>Past editions</b> · Daily editions are kept as published; special editions as of their last update.</span></div></div>` + regionNav('../', false) + `<main id="main"><div class="wrap read"><h2 class="sec">Latest daily edition</h2><ul class="arch"><li><a href="../index.html"><span class="t">${esc(current.title)} — ${esc(fmtDate(current.date))}</span><span class="s">${current.stories.length} stories · ${current.publishedAt?'Published '+esc(ET(current.publishedAt)):'current'}</span></a></li></ul>${archGroups('','h2')}</div></main>` + foot('../',upd) + `</body></html>`);
fs.writeFileSync(path.join(TMP,'data.json'), JSON.stringify({current: current.id, lastSuccessfulUpdate: upd, editions: editions.map(e=>({id:e.id,date:e.date,title:e.title,publishedAt:e.publishedAt||null,leadId:e.leadId||null,topIds:e.topIds||null,stories:e.stories})), archives: archives.map(a=>({id:a.id,date:a.date,title:a.title})), specials: specials.map(sp=>({id:sp.id,title:sp.title,href:`editions/${sp.id}/index.html`,sections:spCfg(sp).sections,regions:spCfg(sp).regions,updatedAt:sp.updatedAt||null,featured:!!sp.featured,test:sp.test||null,stories:sp.stories.map(s=>({id:s.id,section:s.section,region:s.region,regions:spRegions(s),opinionKind:s.opinionKind||null,headline:s.headline,image:!!s.image}))}))}));
fs.writeFileSync(path.join(TMP,'.nojekyll'),'');
// copy every edition's photos (data/img/** -> public/img/**) so archived editions keep their images
let nImg=0; (function cp(src,dst){ if(!fs.existsSync(src)) return; for(const d of fs.readdirSync(src,{withFileTypes:true})){ const a=path.join(src,d.name), b=path.join(dst,d.name);
  if(d.isDirectory()) cp(a,b); else if(IMG_EXT.test(d.name)){ fs.mkdirSync(dst,{recursive:true}); fs.copyFileSync(a,b); nImg++; } } })(IMG_DIR, path.join(TMP,'img'));
// atomic-ish swap
const OLD = OUT+'-old'; fs.rmSync(OLD,{recursive:true,force:true});
if(fs.existsSync(OUT)) fs.renameSync(OUT, OLD);
fs.renameSync(TMP, OUT); fs.rmSync(OLD,{recursive:true,force:true});
if(pubChanged) fs.writeFileSync(PUB_F, JSON.stringify(PUBLOG,null,1)+'\n');
fs.writeFileSync(path.join(DATA,'state.json'), JSON.stringify({lastSuccessfulBuild: upd, current: current.id, builtAtUTC: new Date().toISOString()},null,1));
const counts = Object.keys(REGIONS).map(r=>`${r}:${current.stories.filter(s=>s.region===r).length}`).join(' ');
for(const sp of specials) console.log(`SPECIAL OK ${sp.id} → editions/${sp.id}/index.html (${Object.keys(spCfg(sp).sections).map(k=>`${k}:${sp.stories.filter(s=>s.section===k).length}`).join(' ')}; ${sp.stories.filter(s=>s.image).length}/${sp.stories.length} with photos)`);
console.log(`BUILD OK ${current.id} (${counts}; ${current.stories.filter(s=>s.image).length}/${current.stories.length} with photos; ${nImg} image files) — ${upd}`);
