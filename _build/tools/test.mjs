// Renders the built site at phone, tablet and desktop sizes and checks the approved Nov 2026 design (DESIGN.md):
// publication state, first screen, typography, curated front page, regions/topics/search, expansion, sources,
// accessibility basics (focus, contrast, touch targets, no stray glyphs), archive + specials, and edge cases.
// Usage: node tools/test.mjs [baseURL]      (edge-case fixture: built automatically into /tmp/dd-fixture)
import { chromium } from 'playwright-core'; import path from 'path'; import fs from 'fs'; import { execFileSync } from 'child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUB = path.join(ROOT,'public');
const base = process.argv[2] || 'file://' + PUB + '/';
const exe = ['/usr/bin/google-chrome','/usr/bin/chromium'].find(f=>fs.existsSync(f));
const browser = await chromium.launch({executablePath: exe, args:['--no-sandbox']});
const sizes = [[360,844],[390,844],[430,844],[768,1024],[1280,800],[1286,683],[1440,900]];   // phones <760px; tablet 760-1023; desktop >=1024
const REG = ['us','ca','hk','cn','world'], TOP = ['politics','business','culture','sports','human'];
const DJ = JSON.parse(fs.readFileSync(path.join(PUB,'data.json'),'utf8')); const CUR = DJ.editions.find(e=>e.id===DJ.current);
const nReg = r => CUR.stories.filter(s=>s.region===r).length, nTop = t => CUR.stories.filter(s=>s.topic===t).length, nRT=(r,t)=>CUR.stories.filter(s=>(r==='all'||s.region===r)&&(t==='all'||s.topic===t)).length;
const N_TOTAL = CUR.stories.length;
const lead = CUR.stories.find(s=>s.id===CUR.leadId) || CUR.stories[0];
const words = h => h.split(/[^A-Za-z]+/).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length);
const SEARCH_Q = (words(lead.headline)[0] || '').toLowerCase();
const SITE = (()=>{ try{ return JSON.parse(fs.readFileSync(path.join(ROOT,'data','site.json'),'utf8')); }catch{ return {}; } })();
let fail = 0; const shots = path.join(ROOT,'screenshots'); fs.mkdirSync(shots,{recursive:true});
const check = (c,msg)=>{ console.log((c?'PASS ':'FAIL ')+msg); if(!c) fail++; };
check(N_TOTAL>0 && !!SEARCH_Q && !!CUR.publishedAt, `current edition ${CUR.id}: ${N_TOTAL} stories, published ${CUR.publishedAt}, search term "${SEARCH_Q}"`);
const edPages = fs.readdirSync(path.join(PUB,'editions')).filter(f=>f.endsWith('.html')).map(f=>'editions/'+f);
const SPECIALS = DJ.specials || [];
const spPages = SPECIALS.map(sp=>sp.href);
const edEditionPages = edPages.filter(p=>{ const id=path.basename(p,'.html'); return DJ.editions.some(e=>e.id===id); });

// ---------- static checks over every built page ----------
{ const pages = ['index.html', ...edPages, ...spPages]; let bad=[], nExt=0, nInt=0;
  for (const p of pages) { const html = fs.readFileSync(path.join(PUB,p),'utf8'); const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]));
    for (const m of html.matchAll(/<a\s[^>]*href="([^"]*)"/g)) { const raw = m[1].replace(/&amp;/g,'&');
      if (/^https?:\/\//.test(raw)) { nExt++; try { const u=new URL(raw); if(u.protocol!=='https:'||!u.hostname.includes('.')||/\s/.test(raw)) bad.push(`${p}: ${raw}`); } catch { bad.push(`${p}: malformed ${raw}`); } continue; }
      if (raw.startsWith('#')) { nInt++; if (raw.length>1 && !ids.has(raw.slice(1))) bad.push(`${p}: missing anchor ${raw}`); continue; }
      if (raw.startsWith('?')) { nInt++; continue; }
      nInt++; const [file] = raw.split(/[?#]/); const target = path.normalize(path.join(PUB, path.dirname(p), file||path.basename(p)));
      if (!target.startsWith(PUB) || !fs.existsSync(target)) bad.push(`${p}: unresolved ${raw}`);
      const hash = raw.split('#')[1]; if (hash && fs.existsSync(target)) { const t = fs.readFileSync(target,'utf8'); if (!t.includes(`id="${hash}"`)) bad.push(`${p}: ${raw} anchor missing in target`); } }
    check(!/Every (source|story)[^<]{0,40}(checked|read at the source|read on its source page|re-?checked)/i.test(html), `${p} has no blanket "every source/story was checked" copy`);
    check(!/class="lab [^"]*">(Fact|Verified)</.test(html) && !/>\s*Verified\s*</.test(html), `${p} has no blanket "Fact"/"Verified" badge`);
  }
  check(bad.length===0, `links well-formed (${nExt} external https, ${nInt} internal resolve) ${bad.slice(0,8).join(' | ')}`); }

// ---------- shared in-page probes ----------
const PROBES = () => { window.__dd = {
  shown: e=>!!e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden',
  lum: c=>{ const m=c.match(/[\d.]+/g).map(Number); const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]); },
  bg: e=>{ for(let x=e;x;x=x.parentElement){ const c=getComputedStyle(x).backgroundColor; const m=c.match(/[\d.]+/g); if(m&&(m.length<4||+m[3]>0.5)) return c; } return 'rgb(255, 255, 255)'; },
  ratio: e=>{ const a=window.__dd.lum(getComputedStyle(e).color), b=window.__dd.lum(window.__dd.bg(e)); return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05); } }; };
for (const [w,h] of sizes) {
  const phone = w<760, desk = w>=1024, tag = `${w}x${h}`;
  const ctx = await browser.newContext({viewport:{width:w,height:h}, deviceScaleFactor: phone?2:1, isMobile: phone, hasTouch: phone});
  await ctx.addInitScript(PROBES);
  const page = await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const vis = () => page.locator('[data-story]:not(.hidden)').count();
  const openPanel = async () => { if (await page.getAttribute('#ftoggle','aria-expanded')!=='true') await page.click('#ftoggle'); };
  // ---- every daily page: overflow, clipping, photos ----
  for (const p of ['index.html', ...edPages]) {
    await page.goto(base+p); await page.waitForLoadState('load');
    const ov = await page.evaluate(()=>({sw:document.documentElement.scrollWidth, iw:innerWidth,
      clip:[...document.querySelectorAll('h1,h2,h3,.deck,.chip,.tchip,.btn,.ftoggle,.meta,.logo,.newer,.edline,.arch a,summary')].filter(e=>__dd.shown(e)&&(e.scrollWidth>e.clientWidth+1)&&getComputedStyle(e).overflowX!=='visible').map(e=>e.className+':'+e.textContent.slice(0,30)),
      out:[...document.querySelectorAll('main *, header *, nav *')].filter(e=>{ if(!__dd.shown(e)) return false; const r=e.getBoundingClientRect(); return r.width>0 && (r.right>innerWidth+0.5||r.left<-0.5) && !e.closest('.skip'); }).slice(0,3).map(e=>e.tagName+'.'+e.className)}));
    check(ov.sw<=ov.iw && ov.clip.length===0 && ov.out.length===0, `${tag} ${p} no horizontal overflow or clipped text (${ov.sw}<=${ov.iw}) ${ov.clip.slice(0,3).join('|')} ${ov.out.join('|')}`);
    const im = await page.evaluate(()=>{ const out={n:0,bad:[],lazyLead:0};
      document.querySelectorAll('.ph img, .thumb img').forEach(i=>{ out.n++; const r=i.getBoundingClientRect(), pr=i.closest('article').getBoundingClientRect();
        if(r.left<-0.5||r.right>innerWidth+0.5||r.right>pr.right+1) out.bad.push(i.getAttribute('src')+' outside');
        const ratio=r.width/r.height; if(r.width>0&&(ratio<1.7||ratio>1.85)) out.bad.push(i.getAttribute('src')+' ratio '+ratio.toFixed(2));
        if(!i.getAttribute('width')||!i.getAttribute('height')||!i.getAttribute('alt')) out.bad.push(i.getAttribute('src')+' attrs');
        if(i.closest('.ph-lead')&&i.loading==='lazy') out.lazyLead++;
        const cap=i.closest('figure')?.querySelector('figcaption') || i.closest('article').querySelector(':scope>.phcap');
        if(!cap||!cap.querySelector('a[href^="https://"]')||!/Photo:/.test(cap.textContent)) out.bad.push(i.getAttribute('src')+' no linked credit');
        if(i.closest('.thumb') && r.width>200) out.bad.push(i.getAttribute('src')+' thumbnail too large '+Math.round(r.width)); });
      return out; });
    check(im.bad.length===0 && im.lazyLead===0, `${tag} ${p} ${im.n} photos: inside column, 16:9, alt/size set, credit + licence linked, thumbnails small ${im.bad.slice(0,4).join(' | ')}`);
    const body = await page.evaluate(()=>({len:document.querySelector('main').innerText.length, title:document.title}));
    check(body.len>200 && /Donna Daily/.test(body.title), `${tag} ${p} renders (${body.len} chars)`);
  }
  // file photos are labelled as such, with the year when the caption gives one
  for (const p of edEditionPages) { await page.goto(base+p);
    const a = await page.evaluate(()=>({chips:[...document.querySelectorAll('[data-chip]')].filter(e=>{const r=e.getBoundingClientRect();return __dd.shown(e)&&r.left>=0&&r.right<=innerWidth;}).length,
      more:document.querySelectorAll('details.more').length, about:!!document.querySelector('details.about'), banner:!!document.querySelector('.banner a[href="../index.html"]'), pub:/Published/.test(document.querySelector('.banner')?.textContent||''), newer:!!document.querySelector('.newer')}));
    check(a.chips===6 && a.more>0 && a.about && a.banner && a.pub && !a.newer, `${tag} ${p} archived edition: All + 5 regions, story expansion, About, "kept as published" banner with link to latest`); }

  await page.goto(base+'index.html'); await page.waitForLoadState('load');
  // ---- 1. publication state ----
  const P = await page.evaluate(()=>{ const ed=document.querySelector('.edline'); const t=ed?.querySelector('time'); const nw=document.querySelector('.newer'); const lead=document.querySelector('#lead-sec h1');
    return {ed:ed?.textContent||'', dt:t?.getAttribute('datetime'), foot:document.querySelector('footer').textContent, newer:nw?{txt:nw.textContent, href:nw.getAttribute('href'), before:(nw.compareDocumentPosition(lead)&Node.DOCUMENT_POSITION_FOLLOWING)>0, dt:nw.querySelector('time')?.getAttribute('datetime')}:null,
      pause:[...document.querySelectorAll('.edline .pause')].map(e=>e.textContent)}; });
  check(P.dt===CUR.publishedAt && P.ed.includes(CUR.title) && /Published .*ET/.test(P.ed) && /Latest daily edition/.test(P.ed) && !/rebuilt|Last successful update/i.test(P.ed), `${tag} edition line: "${P.ed.replace(/\s+/g,' ').slice(0,120)}" (publication time ${P.dt}, no maintenance time mixed in)`);
  check(/Site last rebuilt .+E[SD]T/.test(P.foot) && /never re-date/.test(P.foot), `${tag} footer carries the separate site-maintenance time`);
  const newerSp = SPECIALS.filter(sp=>sp.featured && sp.updatedAt && sp.updatedAt > CUR.publishedAt);
  check(newerSp.length ? (!!P.newer && P.newer.href===newerSp[0].href && P.newer.before && P.newer.dt===newerSp[0].updatedAt && /Newer coverage/.test(P.newer.txt) && /Updated .*ET/.test(P.newer.txt)) : !P.newer, `${tag} newer coverage: ${P.newer?P.newer.txt.replace(/\s+/g,' '):'none'}`);
  const expPause = (SITE.notices||[]).filter(n=>!n.showUntil||Date.now()<Date.parse(n.showUntil)).map(n=>n.text);
  check(JSON.stringify(P.pause)===JSON.stringify(expPause), `${tag} pause notice ${JSON.stringify(P.pause)}`);
  // ---- 2/3. first screen + typography ----
  const F = await page.evaluate(()=>{ const r=s=>document.querySelector(s)?.getBoundingClientRect(); const h1=document.querySelector('#lead-sec h1'); const cs=getComputedStyle(h1);
    const im=r('#lead-sec .ph'), dk=r('#lead-sec .deck'), hr=h1.getBoundingClientRect(); const h3=document.querySelector('#top-sec h3, .card h3'); const deckEl=document.querySelector('.card .deck');
    return {h1T:hr.top, h1B:hr.bottom, deckT:dk.top, deckB:dk.bottom, h1BeforeImg: !im || (h1.compareDocumentPosition(document.querySelector('#lead-sec .ph'))&Node.DOCUMENT_POSITION_FOLLOWING)>0 && (im.top>=hr.bottom-1),
      deckBeforeImg: !im || (dk.bottom<=im.top+1) || (im.left>=dk.right-1), h1Size:parseFloat(cs.fontSize), h1Font:cs.fontFamily, h1Upper:cs.textTransform, h3Size:parseFloat(getComputedStyle(h3).fontSize), h3Font:getComputedStyle(h3).fontFamily,
      body:parseFloat(getComputedStyle(deckEl).fontSize), metaFont:getComputedStyle(document.querySelector('.meta')).fontFamily, bg:getComputedStyle(document.body).backgroundColor, ink:getComputedStyle(document.body).color,
      fpanelHidden:document.getElementById('fpanel').hidden, toggle:document.getElementById('ftoggle').getAttribute('aria-expanded'),
      about:(()=>{const a=document.querySelector('details.about'); const last=[...document.querySelectorAll('section[data-region-sec]')].pop(); return !!a&&!a.open&&(last.compareDocumentPosition(a)&Node.DOCUMENT_POSITION_FOLLOWING)>0&&/not every claim has been independently verified/i.test(a.textContent);})() }; });
  check(F.h1BeforeImg && F.deckBeforeImg, `${tag} lead headline and summary come before (or beside) the lead photo`);
  if (phone || w===1286) check(F.h1B<=h && F.deckT<h, `${tag} lead headline fully visible on the first screen (top ${Math.round(F.h1T)}, bottom ${Math.round(F.h1B)}px; summary starts ${Math.round(F.deckT)}px)`);
  if (w===390) check(F.deckB<=844, `390x844 lead headline + summary fully visible on the first screen (summary bottom ${Math.round(F.deckB)}px)`);
  if (desk) check(F.h1T<=360, `${tag} lead headline starts at y=${Math.round(F.h1T)} (was ~511-533 before the redesign)`);
  check(/Georgia/.test(F.h1Font) && /Georgia/.test(F.h3Font) && F.h1Upper==='none' && !/Georgia/.test(F.metaFont), `${tag} sentence-case serif headlines, sans metadata`);
  const [lo,hi] = phone ? [30,34] : w>=1280 ? [42,48] : [30,48];
  check(F.h1Size>=lo && F.h1Size<=hi, `${tag} lead headline ${F.h1Size}px (target ${lo}-${hi})`);
  check(F.h3Size>=20 && F.h3Size<=26 && F.body>=16 && F.body<=18, `${tag} secondary headline ${F.h3Size}px, body ${F.body}px`);
  check(F.bg==='rgb(255, 255, 255)' && /rgb\(1[0-9], 1[0-9], 1[0-9]\)/.test(F.ink), `${tag} white background, near-black text (${F.ink})`);
  check(F.fpanelHidden && F.toggle==='false', `${tag} search/topics panel closed until opened`);
  check(F.about, `${tag} "About this edition" collapsed after the stories, with the sourcing note`);
  if (w===390) await page.screenshot({path:`${shots}/redesign-after-home-390x844.png`});
  if (w===1280) await page.screenshot({path:`${shots}/redesign-after-home-1280x800.png`});
  if (w===1286) await page.screenshot({path:`${shots}/redesign-after-home-1286x683.png`});
  // ---- 4. curated front page: one lead, 4-5 supporting, each story exactly once ----
  const Lp = await page.evaluate(()=>{ const lead=document.getElementById('lead-sec').getBoundingClientRect(), top=document.getElementById('top-sec'), tr=top.getBoundingClientRect(), fr=document.getElementById('front').getBoundingClientRect();
    const ids=[...document.querySelectorAll('[data-story]')].map(e=>e.id); const rg=document.querySelector('.regions-grid');
    return {nTop:top.querySelectorAll('[data-story]').length, nLead:document.querySelectorAll('#lead-sec [data-story]').length, ids, dup:ids.length-new Set(ids).size, side: tr.left>=lead.right-1 && tr.top<lead.bottom, ratio:lead.width/fr.width,
      cols:getComputedStyle(rg).gridTemplateColumns.split(' ').filter(Boolean).length, latest:!!document.getElementById('latest'), sticky:getComputedStyle(document.getElementById('regions')).position,
      topImgs:top.querySelectorAll('img').length, stack: tr.top>=lead.bottom-1 }; });
  check(Lp.nLead===1 && Lp.nTop>=4 && Lp.nTop<=5 && Lp.dup===0 && Lp.ids.length===N_TOTAL && !Lp.latest, `${tag} curated front: 1 lead, ${Lp.nTop} supporting, every one of ${N_TOTAL} stories appears exactly once, no duplicate Latest list`);
  check(Lp.topImgs===0, `${tag} supporting stories are text-only (no large file photos)`);
  if (desk) check(Lp.side && Lp.ratio>0.6 && Lp.ratio<0.72 && Lp.cols>=3 && Lp.sticky==='sticky', `${tag} desktop: lead ${Math.round(Lp.ratio*100)}% wide with supporting column beside it, ${Lp.cols}-column regional sections, sticky region bar`);
  if (phone) check(Lp.stack && Lp.cols===1 && Lp.sticky!=='sticky', `${tag} phone: single column, lead then supporting stories, no sticky header`);
  // ---- nav: All + 5 regions + Past editions visible, no hidden scroll, ≥44px ----
  const N = await page.evaluate(()=>{ const inView=e=>{const r=e.getBoundingClientRect();return __dd.shown(e)&&r.left>=0&&r.right<=innerWidth&&r.width>0;};
    const nav=document.querySelector('nav.regions .wrap');
    return {chips:[...document.querySelectorAll('[data-chip]')].filter(inView).length, past:[...document.querySelectorAll('a[data-past]')].some(inView), scroll:nav.scrollWidth>nav.clientWidth+1, sports:!!document.querySelector('[data-chip=sports]'),
      names:[...document.querySelectorAll('[data-chip]')].map(e=>e.getAttribute('aria-label'))}; });
  check(N.chips===6 && N.past && !N.scroll && !N.sports, `${tag} region bar: All + 5 regions (${N.names.join(', ')}) and Past editions visible, no hidden scroll, Sports is a topic not a region`);
  // ---- touch targets (≥44px everywhere) ----
  await openPanel();
  const small = await page.evaluate(()=>[...document.querySelectorAll('.chip,.tchip,.btn,.ftoggle,#q,.arch a,.allpast,.mlinks a,.logo,footer a,details>summary,.srcs a')].filter(e=>__dd.shown(e)&&!e.closest('details:not([open])>*:not(summary)')).map(e=>[e.textContent.trim().slice(0,20),Math.round(e.getBoundingClientRect().height)]).filter(x=>x[1]<44));
  check(small.length===0, `${tag} touch targets >=44px (${small.length} small ${JSON.stringify(small.slice(0,3))})`);
  // ---- contrast (AA 4.5:1 for text) ----
  const lowC = await page.evaluate(()=>[...document.querySelectorAll('.edline,.edline b,.chip,.ftoggle,.fsum,.tchip,.tchip .n,.newer .k,.newer .h,.newer .t,.kicker,.meta,.lab,.deck,.why,.why .wl,.why .wl span,details.more>summary,details.more>summary .c,.phcap,.ph figcaption,.ptr,h2.sec,h2.sec .count,.arch .s,footer p,.mlinks a,.lead h1,.card h3')].filter(e=>__dd.shown(e)).map(e=>[e.className||e.tagName, +__dd.ratio(e).toFixed(2)]).filter(x=>x[1]<4.5));
  check(lowC.length===0, `${tag} text contrast >= 4.5:1 (${lowC.length} low ${JSON.stringify(lowC.slice(0,3))})`);
  // ---- keyboard focus is visible ----
  await page.goto(base+'index.html'); let focusBad=[], stops=0;
  for (let i=0;i<14;i++) { await page.keyboard.press('Tab'); const f = await page.evaluate(()=>{ const e=document.activeElement; if(!e||e===document.body) return null; const cs=getComputedStyle(e); return {t:(e.textContent||e.id).trim().slice(0,18), ow:parseFloat(cs.outlineWidth), os:cs.outlineStyle}; });
    if (f) { stops++; if (!(f.os!=='none' && f.ow>=2)) focusBad.push(f.t); } }
  check(stops>=10 && focusBad.length===0, `${tag} keyboard: ${stops} tab stops all show a visible focus outline ${focusBad.slice(0,3).join('|')}`);
  // ---- regions ----
  for (const r of REG) { await page.click(`[data-chip=${r}]`); const v = await vis();
    const st = await page.evaluate(r=>{ const c=document.querySelector(`[data-chip=${r}]`), o=document.querySelector('[data-chip=all]');
      return {pressed:c.getAttribute('aria-pressed'), others:[...document.querySelectorAll('[data-chip]')].filter(x=>x!==c&&x.getAttribute('aria-pressed')==='true').length, a:getComputedStyle(c).borderBottomColor+getComputedStyle(c).color, b:getComputedStyle(o).borderBottomColor+getComputedStyle(o).color,
        state:!document.getElementById('fstate').classList.contains('hidden') && !!document.querySelector('#fstate #fclear'), secs:[...document.querySelectorAll('section[data-region-sec]:not(.hidden)')].map(s=>s.id)}; }, r);
    check(v===nReg(r) && st.pressed==='true' && st.others===0 && st.a!==st.b && st.state && st.secs.every(s=>s==='region-'+r), `${tag} region ${r} -> ${v} (expected ${nReg(r)}), active state shown, filter status + Clear visible, only its section shown`);
    if (w===390 && r==='ca') { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/redesign-after-filter-canada-390.png`}); }
    await page.click(`[data-chip=${r}]`); }
  check(await vis()===N_TOTAL && await page.getAttribute('[data-chip=all]','aria-pressed')==='true', `${tag} region toggled off -> all ${N_TOTAL}, "All" active`);
  // ---- topics (incl. empty) and every region+topic combination ----
  await openPanel();
  for (const t of TOP) { await page.click(`[data-tchip=${t}]`); const v = await vis();
    const em = await page.evaluate(()=>{ const e=document.getElementById('fempty'); return {shown:!e.classList.contains('hidden'), txt:e.textContent, btn:!!e.querySelector('#freset')}; });
    const n = await page.evaluate(t=>document.querySelector(`[data-tchip=${t}] .n`).textContent, t);
    check(v===nTop(t) && +n===nTop(t) && (v>0 ? !em.shown : (em.shown && em.btn && /No .+ stories in this edition/.test(em.txt))), `${tag} topic ${t} -> ${v} (expected ${nTop(t)}, chip count ${n})${v?'':' empty state: '+em.txt.slice(0,50)}`);
    await page.click(`[data-tchip=${t}]`); }
  if (w===390 || w===1280) { let bad=[];
    for (const r of REG) for (const t of TOP) { await page.click(`[data-chip=${r}]`); await page.click(`[data-tchip=${t}]`); const v=await vis(); const e=nRT(r,t);
      const em = await page.evaluate(()=>!document.getElementById('fempty').classList.contains('hidden'));
      const cnt = await page.evaluate(t=>+document.querySelector(`[data-tchip=${t}] .n`).textContent, t);
      if (v!==e || em!==(e===0) || cnt!==e) bad.push(`${r}+${t}:${v}/${e}`);
      await page.click('#fclear'); }
    check(bad.length===0, `${tag} all 25 region+topic combinations filter correctly, topic counts follow the region, empty state when 0 ${bad.slice(0,4).join(' ')}`); }
  // ---- search, unmatched search, reset; no stray glyphs in the accessibility tree ----
  const nQ = await page.evaluate(q=>[...document.querySelectorAll('[data-story]')].filter(c=>c.textContent.toLowerCase().includes(q)).length, SEARCH_Q);
  await page.fill('#q',SEARCH_Q); let v = await vis(); check(nQ>=1 && nQ<N_TOTAL && v===nQ, `${tag} search "${SEARCH_Q}" -> ${v} (expected ${nQ})`);
  await page.fill('#q','zzzzqqq');
  const E0 = await page.evaluate(()=>({shown:!document.getElementById('fempty').classList.contains('hidden'), txt:document.getElementById('femptytxt').textContent, cards:document.querySelectorAll('[data-story]:not(.hidden)').length,
    secs:[...document.querySelectorAll('section[data-region-sec]')].filter(__dd.shown).length, front:__dd.shown(document.getElementById('front'))}));
  const snap = await page.locator('main').ariaSnapshot();
  const stray = snap.split('\n').filter(l=>/(^|[\s:"'])[+−▾▴↗](\s|"|$)/.test(l));
  check(E0.shown && E0.cards===0 && E0.secs===0 && !E0.front && /No stories match/.test(E0.txt), `${tag} unmatched search: empty message + reset, no cards/sections left ("${E0.txt.slice(0,50)}")`);
  check(stray.length===0 && !/Read more|More \d/.test(snap.split('Past editions')[0]), `${tag} filtered accessibility snapshot has no stray + / − / arrow glyphs and no leaked expansion controls ${stray.slice(0,3).join(' | ')}`);
  if (w===390) { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/redesign-after-search-none-390.png`}); }
  await page.click('#freset'); v = await vis(); check(v===N_TOTAL && await page.inputValue('#q')==='', `${tag} reset -> ${v}/${N_TOTAL}, search cleared`);
  await page.fill('#q','zzzzqqq'); await page.click('#fclear'); v = await vis(); check(v===N_TOTAL, `${tag} "Clear filters" -> ${v}/${N_TOTAL}`);
  // full accessibility snapshot of the unfiltered page: decorative glyphs hidden
  { const s2 = await page.locator('body').ariaSnapshot(); const bad2 = s2.split('\n').filter(l=>/(^|[\s:"'])[+−▾▴↗→↑](\s|"|$)/.test(l)); check(bad2.length===0, `${tag} accessibility tree free of decorative glyphs ${bad2.slice(0,2).join(' | ')}`); }
  // ---- story expansion + sources ----
  await page.goto(base+'index.html');
  await page.locator('#lead-sec details.more > summary').click();
  const R = await page.evaluate(()=>{ const d=document.querySelector('#lead-sec details.more'); const a=[...d.querySelectorAll('.srcs a')]; return {open:d.open, links:a.filter(x=>x.getBoundingClientRect().height>0).length, n:a.length, basis:/Basis:/.test(d.textContent)}; });
  check(R.open && R.links>0 && R.links===R.n && R.basis, `${tag} lead expansion opens: ${R.links} source links visible, claim basis stated`);
  const S = await page.evaluate(()=>[...document.querySelectorAll('[data-story]')].map(c=>({id:c.id, src:!!c.querySelector('details.more .srcs a[href^="https://"]'), why:!!c.querySelector('.why .wl'), whyLbl:/Donna Daily analysis/.test(c.querySelector('.why')?.textContent||''), meta:!!c.querySelector('.meta'), ownsSummary:!!c.querySelector('details.more>summary')})));
  check(S.every(s=>s.src&&s.why&&s.whyLbl&&s.meta&&s.ownsSummary), `${tag} every story has attribution, an expandable view with sources, and "Why it matters" marked as Donna Daily analysis`);
  const L2 = await page.evaluate(()=>{ const all=[...document.querySelectorAll('[data-story] .meta .lab')].filter(__dd.shown).map(l=>l.textContent); return {rep:all.filter(t=>t==='Reported').length, n:all.length, alleg:document.querySelectorAll('[data-story] .meta .lab-alleg').length, sm:document.querySelectorAll('[data-story] .meta .lab-sm').length}; });
  check(L2.rep===0, `${tag} previews show only distinctive labels (${L2.n} shown: ${L2.alleg} allegation, ${L2.sm} state media; plain "Reported" moved to the expanded view)`);
  const fp = await page.evaluate(()=>[...document.querySelectorAll('.ph figcaption, .phcap')].filter(__dd.shown).map(c=>c.textContent));
  check(fp.length>0 && fp.every(t=>/^File photo/.test(t)||!/File/.test(t)), `${tag} ${fp.length} photo credit lines; file photos labelled "File photo[, year]"`);
  const topMore = page.locator('#top-sec details.more > summary').first(); await topMore.click();
  const TM = await page.evaluate(()=>{ const d=document.querySelector('#top-sec details.more'); return {open:d.open, why:__dd.shown(d.querySelector('.why')), src:d.querySelectorAll('.srcs a').length}; });
  check(TM.open && TM.why && TM.src>0, `${tag} supporting story expands to Why it matters + ${TM.src} sources`);
  if (w===390 || w===1280) { await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto'; document.querySelector('#top-sec details.more').open=false; const d=document.querySelector('#lead-sec details.more'); d.open=true; scrollTo(0,d.getBoundingClientRect().top+scrollY-(innerWidth<760?60:120));});
    await page.screenshot({path:`${shots}/redesign-after-expanded-${w}x${h}.png`}); }
  // ---- back to top (phones) ----
  if (phone) { await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';scrollTo(0,3000);}); await page.waitForTimeout(150);
    const T = await page.evaluate(()=>{ const t=document.getElementById('totop'); const r=t.getBoundingClientRect(); return {shown:getComputedStyle(t).display!=='none', h:r.height, w:r.width}; });
    check(T.shown && T.h>=44 && T.w<=200, `${tag} small "Regions" button after scrolling (${Math.round(T.w)}x${Math.round(T.h)})`);
    await page.click('#totop'); await page.waitForTimeout(250); const navTop = await page.evaluate(()=>document.getElementById('regions').getBoundingClientRect().top);
    check(Math.abs(navTop)<5, `${tag} it lands on the region bar (${Math.round(navTop)}px)`); }
  // ---- shareable URLs ----
  await page.goto(base+'index.html?region=ca&topic=politics'); v = await vis();
  check(v===nRT('ca','politics') && await page.getAttribute('#ftoggle','aria-expanded')==='true', `${tag} URL ?region=ca&topic=politics -> ${v} (expected ${nRT('ca','politics')}), panel open`);
  // ---- archive navigation ----
  await page.goto(base+'index.html'); await page.click('a[data-past]'); check(/editions\/index\.html$/.test(page.url()), `${tag} Past editions link opens the archive list`);
  await page.goto(base+'editions/index.html');
  const PE = await page.evaluate(()=>{ const g=id=>{const el=document.getElementById(id); return el?{h:el.querySelector('.sub')?.textContent||'', n:el.querySelectorAll('.arch a').length, hrefs:[...el.querySelectorAll('.arch a')].map(a=>a.getAttribute('href'))}:null};
    return {d:g('daily-editions'), s:g('special-editions'), chips:document.querySelectorAll('nav.regions .chip').length, order:(()=>{const a=document.getElementById('daily-editions'),b=document.getElementById('special-editions');return !!a&&!!b&&(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)>0})(),
      serif:/Georgia/.test(getComputedStyle(document.querySelector('.arch .t')).fontFamily)}; });
  const expDaily = DJ.editions.length-1 + (DJ.archives||[]).length;
  check(PE.d && PE.s && PE.order && PE.d.n===expDaily && PE.s.n===SPECIALS.length && PE.d.h.includes(`(${expDaily} edition`) && PE.s.h.includes(`(${SPECIALS.length} edition`) && PE.chips===6 && PE.serif,
    `${tag} Past editions page: Daily editions (${PE.d&&PE.d.n}) then Special editions (${PE.s&&PE.s.n}), counts in headings, region bar, new type`);
  check(PE.d && PE.d.hrefs.every(h=>!/\/index\.html$/.test(h)) && PE.s && PE.s.hrefs.every(h=>/\/index\.html$/.test(h)), `${tag} Past editions: no special in the Daily list and no daily edition in the Special list`);
  const dIds = PE.d? PE.d.hrefs.map(h=>h.replace(/\.html$/,'')) : []; check(dIds.join()===[...dIds].sort().reverse().join(), `${tag} Daily editions newest first: ${dIds.join(', ')}`);
  if (w===390||w===1280) await page.screenshot({path:`${shots}/redesign-after-past-editions-${w}x${h}.png`});
  if (desk) { const rw = await page.evaluate(()=>document.querySelector('main .wrap').getBoundingClientRect().width); check(rw<=880, `${tag} archive page reading column ${Math.round(rw)}px`); }
  check(errs.length===0, `${tag} no JS errors ${errs.join('|')}`);
  await ctx.close();
}

// ---------- special editions (e.g. editions/2026-10-review/index.html) ----------
console.log(`INFO special editions in data.json: ${SPECIALS.map(s=>s.id).join(', ')||'none'}`);
{ const home = fs.readFileSync(path.join(PUB,'index.html'),'utf8'), arch = fs.readFileSync(path.join(PUB,'editions/index.html'),'utf8');
  for (const sp of SPECIALS) {
    check(home.includes(`href="${sp.href}"`), `home page links to special ${sp.id}`);
    const sl = arch.match(/<ul class="arch arch-special">([\s\S]*?)<\/ul>/), dl = arch.match(/<ul class="arch arch-daily">([\s\S]*?)<\/ul>/);
    const rel = sp.href.replace(/^editions\//,'');
    check(!!sl && sl[1].includes(`href="${rel}"`) && !!dl && !dl[1].includes(`href="${rel}"`), `Past editions lists special ${sp.id} under Special editions only`);
    const hs = home.match(/<ul class="arch arch-special">([\s\S]*?)<\/ul>/), hd = home.match(/<ul class="arch arch-daily">([\s\S]*?)<\/ul>/);
    check(!!hs && hs[1].includes(`href="${sp.href}"`) && !!hd && !hd[1].includes(`href="${sp.href}"`), `front page archive lists special ${sp.id} under Special editions only`);
  }
  { const spIds = SPECIALS.map(s=>s.href.replace(/^editions\//,'')), sl = arch.match(/<ul class="arch arch-special">([\s\S]*?)<\/ul>/);
    const got = sl? [...sl[1].matchAll(/href="([^"]+)"/g)].map(m=>m[1]) : []; check(got.join()===spIds.join() && got.join()===[...got].sort().reverse().join(), `Special editions newest first: ${got.join(', ')}`); }
  for (const gone of ['2026-10-29-brief','2026-11-01-brief','2026-11-01-ed1']) check(!fs.existsSync(path.join(PUB,'editions',gone+'.html')) && !home.includes(gone) && !arch.includes(gone), `removed edition ${gone} is not built or linked`);
  check(DJ.current===CUR.id && !SPECIALS.some(sp=>sp.id===DJ.current), `daily front page stays ${DJ.current}; specials never replace it`);
  const ban = [...home.matchAll(/<a class="newer" href="([^"]+)"/g)].map(m=>m[1]);
  check(ban.length<=1 && ban.every(h=>SPECIALS.some(sp=>sp.href===h)) && home.includes('id="lead-sec"') && !/class="spb"/.test(home), `home page "Newer coverage" link: ${ban.join(', ')||'none'} (compact, no black promo banner; daily edition still the front page)`); }
for (const SP of SPECIALS) {
  const p = SP.href; const SECS=Object.keys(SP.sections||{news:1,life:1,opinion:1,culture:1}), SREG=Object.keys(SP.regions||{us:1,ca:1,hk:1,cn:1});
  // per-special test settings (data.json specials[].test); defaults are the October 2026 in Review values
  const TC = Object.assign({search:'alberta', combo:['opinion','cn'], share:['opinion','hk'], ourView:[2,3], columnsMin:4}, SP.test||{});
  const SHOT = SP.id==='2026-10-review' ? 'october' : SP.id;
  const nS = k => SP.stories.filter(s=>k==='all'||s.section===k).length, nR = r => SP.stories.filter(s=>r==='all'||s.regions.includes(r)).length;
  const nSR = (k,r) => SP.stories.filter(s=>(k==='all'||s.section===k)&&(r==='all'||s.regions.includes(r))).length;
  const N = SP.stories.length;
  for (const [w,h] of sizes.filter(([w,h])=>w!==1286)) {
    const phone = w<760;
    const ctx = await browser.newContext({viewport:{width:w,height:h}, deviceScaleFactor: phone?2:1, isMobile: phone, hasTouch: phone});
    const page = await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    const vis = () => page.locator('[data-story]:not(.hidden)').count();
    const glanceOk = () => page.evaluate(()=>{ const shown=e=>!!e&&e.offsetParent!==null&&getComputedStyle(e).display!=='none';
      const G=document.getElementById('glance'); const n=G?[...G.querySelectorAll('li')].filter(shown).length:0; return {ok:!shown(G)||n>0, n, shown:shown(G)}; });
    await page.goto(base+p); await page.waitForLoadState('load');
    const ov = await page.evaluate(()=>({sw:document.documentElement.scrollWidth, iw:innerWidth}));
    check(ov.sw<=ov.iw, `${w}px ${SP.id}: no horizontal overflow (${ov.sw}<=${ov.iw})`);
    const im = await page.evaluate(()=>{ const out={n:0,bad:[]};
      document.querySelectorAll('.ph img').forEach(i=>{ out.n++; const r=i.getBoundingClientRect(), pr=i.closest('article').getBoundingClientRect();
        if(r.left<-0.5||r.right>innerWidth+0.5||r.width>pr.width+1) out.bad.push(i.getAttribute('src'));
        const ratio=r.width/r.height; if(r.width>0&&(ratio<1.7||ratio>1.85)) out.bad.push(i.getAttribute('src')+' ratio '+ratio.toFixed(2));
        if(!i.getAttribute('width')||!i.getAttribute('height')||!i.getAttribute('alt')) out.bad.push(i.getAttribute('src')+' attrs');
        if(!i.closest('figure').querySelector('figcaption a[href^="https://"]')) out.bad.push(i.getAttribute('src')+' no credit link');
        if(!/Photo:/.test(i.closest('figure').textContent)) out.bad.push(i.getAttribute('src')+' no credit'); });
      return out; });
    check(im.n===SP.stories.filter(s=>s.image).length && im.bad.length===0, `${w}px ${SP.id}: ${im.n} photos inside their column, 16:9, credited + licence linked ${im.bad.join(' | ')}`);
    // ---- first screen: page title, controls and the lead headline + deck ----
    const F = await page.evaluate(()=>{ const r=s=>document.querySelector(s)?.getBoundingClientRect(); const a=document.querySelector('details.about'); const lastSec=[...document.querySelectorAll('[data-sec]')].pop();
      return {h1:r('.lead .lh')?.top, h1b:r('.lead .lh')?.bottom, deckB:r('.lead .deck')?.bottom, deckT:r('.lead .deck')?.top, title:r('.ttl h1')?.top, nav:r('#snav')?.top, img:r('.lead .ph')?.top,
        aboutClosed:!!a&&!a.open, aboutAfter:!!a&&!!lastSec&&(lastSec.compareDocumentPosition(a)&Node.DOCUMENT_POSITION_FOLLOWING)>0, prov:/Research pages were opened/.test(a?.textContent||''), legend:!!document.querySelector('details.guide .lab-ov')}; });
    check(F.title<F.nav && F.nav<F.h1 && (!F.img || F.deckB<=F.img+1), `${w}px ${SP.id}: title, then section/region controls, then lead headline + deck before its photo`);
    if (phone) check(F.h1b<=h && F.deckT<h, `${w}px ${SP.id}: lead headline (bottom ${Math.round(F.h1b)}px) and deck (top ${Math.round(F.deckT)}px, bottom ${Math.round(F.deckB)}px) on the first screen (<${h})`);
    if (w===390) check(F.deckB<=h, `390px ${SP.id}: lead deck fully visible on the first screen (${Math.round(F.deckB)}px)`);
    check(F.aboutClosed && F.aboutAfter && F.prov && F.legend, `${w}px ${SP.id}: collapsed About this edition (with provenance) after the sections, label legend incl. Our view`);
    if (SP.updatedAt) { const up = await page.evaluate(()=>{ const t=document.querySelector('.ttl .kick time'); return t?{txt:t.textContent, dt:t.getAttribute('datetime'), top:t.getBoundingClientRect().top}:null; });
      check(!!up && up.dt===SP.updatedAt && /Last updated .*E[SD]T/.test(up.txt) && up.top<h, `${w}px ${SP.id}: "last updated" time in ET shown at the top (${up&&up.txt})`); }
    if (w===390) await page.screenshot({path:`${shots}/${SHOT}-390.png`});
    // ---- controls: 5 section tabs + 5 region buttons visible, wrapping (no hidden scroll), counts ----
    const C = await page.evaluate(()=>{ const inView=e=>{const r=e.getBoundingClientRect();return e.offsetParent&&r.left>=0&&r.right<=innerWidth&&r.width>0;};
      const sc=e=>e.scrollWidth>e.clientWidth+1;
      return {tabs:[...document.querySelectorAll('[data-tab]')].filter(inView).map(e=>[e.dataset.tab,e.querySelector('.n').textContent]), regs:[...document.querySelectorAll('[data-reg]')].filter(inView).map(e=>[e.dataset.reg,e.querySelector('.n').textContent]),
        scroll:sc(document.querySelector('.tabs'))||sc(document.querySelector('.regs')), q:inView(document.getElementById('q'))}; });
    check(C.tabs.length===SECS.length+1 && C.regs.length===SREG.length+1 && !C.scroll && C.q, `${w}px ${SP.id}: ${SECS.length+1} section tabs + ${SREG.length+1} region buttons + search visible within the viewport, no hidden scroll`);
    check(C.tabs.every(([k,n])=>+n===nS(k)) && C.regs.every(([k,n])=>+n===nR(k)), `${w}px ${SP.id}: counts — sections ${C.tabs.map(x=>x.join(' ')).join(', ')}; regions ${C.regs.map(x=>x.join(' ')).join(', ')}`);
    const minT = phone ? 44 : 24;
    const small = await page.evaluate(m=>[...document.querySelectorAll('[data-tab],[data-reg],#q,.btn:not(.hidden),#glance a,details>summary,.wm,.mast .back,footer a')].filter(e=>e.offsetParent).map(e=>[e.textContent.slice(0,20),e.getBoundingClientRect().height]).filter(x=>x[1]<m), minT);
    check(small.length===0, `${w}px ${SP.id}: targets >=${minT}px (${small.length} small ${JSON.stringify(small.slice(0,3))})`);
    const fs16 = await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.sc .deck')).fontSize)); check(fs16>=16 && fs16<=19.5, `${w}px ${SP.id}: deck text ${fs16}px`);
    // ---- section tabs ----
    for (const k of SECS) { await page.click(`[data-tab=${k}]`); const v=await vis(); const g=await glanceOk();
      const st = await page.evaluate(k=>({pressed:document.querySelector(`[data-tab=${k}]`).getAttribute('aria-pressed'), others:[...document.querySelectorAll('[data-tab]')].filter(t=>t.dataset.tab!==k&&t.getAttribute('aria-pressed')==='true').length,
        secs:[...document.querySelectorAll('[data-sec]')].filter(s=>!s.classList.contains('hidden')).map(s=>s.dataset.sec), lead:!document.getElementById('leadbox').classList.contains('hidden')}), k);
      check(v===nS(k) && st.pressed==='true' && st.others===0 && st.secs.join()===k && g.ok, `${w}px ${SP.id}: ${k} tab -> ${v} (expected ${nS(k)}), only ${st.secs.join()} shown, lead ${st.lead?'shown':'hidden'}, glance ${g.shown?g.n+' items':'hidden'}`);
      if (k==='opinion' && w===390) { await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';const s=document.getElementById('sec-opinion');scrollTo(0,s.getBoundingClientRect().top+scrollY-8);}); await page.screenshot({path:`${shots}/${SHOT}-opinion-390.png`}); await page.evaluate(()=>scrollTo(0,0)); }
      if (k==='opinion') { const O = await page.evaluate(()=>({ov:document.querySelectorAll('[data-sub=ourview] [data-story]').length, cols:[...document.querySelectorAll('[data-sub=columns] [data-story]')].map(c=>({by:c.querySelector('.by')?.textContent||'', lab:c.querySelector('.lab')?.textContent})),
          ovLab:[...document.querySelectorAll('[data-sub=ourview] [data-story] .lab')].every(l=>l.textContent==='Our view')}));
        check(O.ov>=TC.ourView[0] && O.ov<=TC.ourView[1] && O.ovLab && O.cols.length>=TC.columnsMin && O.cols.every(c=>/^By .+ · .+/.test(c.by) && c.lab==='Opinion'), `${w}px ${SP.id}: Opinion has ${O.ov} "Our view" pieces and ${O.cols.length} named columnists (author · outlet, labelled Opinion)`); }
      await page.click(`[data-tab=${k}]`); }
    check(await vis()===N, `${w}px ${SP.id}: section tab toggles off -> all ${N}`);
    // ---- region filters ----
    for (const r of SREG) { await page.click(`[data-reg=${r}]`); const v=await vis(); const g=await glanceOk();
      const st = await page.evaluate(r=>{const c=document.querySelector(`[data-reg=${r}]`),o=document.querySelector('[data-reg=all]');return {pressed:c.getAttribute('aria-pressed'),bg:getComputedStyle(c).backgroundColor,obg:getComputedStyle(o).backgroundColor,
        tabs:[...document.querySelectorAll('[data-tab]')].map(t=>[t.dataset.tab,+t.querySelector('.n').textContent])};}, r);
      check(v===nR(r) && st.pressed==='true' && st.bg!==st.obg && g.ok && st.tabs.every(([k,n])=>n===nSR(k,r)), `${w}px ${SP.id}: region ${r} -> ${v} (expected ${nR(r)}), active, section counts follow (${st.tabs.map(x=>x.join(' ')).join(', ')}), glance ${g.shown?g.n:'hidden'}`);
      if (r===SREG[2] && w===390) { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/${SHOT}-${r}-390.png`}); }
      await page.click(`[data-reg=${r}]`); }
    // combined: Opinion + China (includes the cross-region Our view piece)
    await page.click(`[data-tab=${TC.combo[0]}]`); await page.click(`[data-reg=${TC.combo[1]}]`); let v=await vis(); check(v===nSR(TC.combo[0],TC.combo[1]) && (await glanceOk()).ok, `${w}px ${SP.id}: ${TC.combo[0]} + ${TC.combo[1]} -> ${v} (expected ${nSR(TC.combo[0],TC.combo[1])})`);
    await page.click('[data-reg=all]'); await page.click('[data-tab=all]'); check(await vis()===N, `${w}px ${SP.id}: All tab + All regions -> ${N}`);
    // ---- search ----
    const nQ = await page.evaluate(q=>[...document.querySelectorAll('[data-story]')].filter(c=>c.textContent.toLowerCase().includes(q)).length, TC.search);
    await page.fill('#q',TC.search); v=await vis(); check(nQ>=2 && nQ<N && v===nQ && (await glanceOk()).ok, `${w}px ${SP.id}: search "${TC.search}" -> ${v} (expected ${nQ})`);
    await page.fill('#q','zzzzqqq'); const g0=await glanceOk(); const E = await page.evaluate(()=>({shown:!document.getElementById('fempty').classList.contains('hidden'), txt:document.getElementById('femptytxt').textContent, secs:[...document.querySelectorAll('[data-sec]:not(.hidden)')].length, top:!document.getElementById('top').classList.contains('hidden')}));
    check(E.shown && /No stories match/.test(E.txt) && E.secs===0 && !E.top && !g0.shown, `${w}px ${SP.id}: no-results search shows a message + reset, hides every section, the lead and the at-a-glance list`);
    if (w===390) { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/${SHOT}-search-none-390.png`}); }
    await page.click('#freset'); v=await vis(); check(v===N && await page.inputValue('#q')==='', `${w}px ${SP.id}: reset -> ${v}/${N}`);
    // ---- Read more ----
    await page.locator('#leadbox details.more > summary').click();
    const R = await page.evaluate(()=>{ const d=document.querySelector('#leadbox details.more'); const a=[...d.querySelectorAll('.srcs a')]; return {open:d.open, links:a.filter(x=>x.offsetParent&&x.getBoundingClientRect().height>0).length, n:a.length}; });
    check(R.open && R.links>0 && R.links===R.n, `${w}px ${SP.id}: Read more expands (${R.links} source links)`);
    const full = await page.evaluate(()=>[...document.querySelectorAll('[data-story]')].every(c=>c.querySelector('details.more .srcs a') && c.querySelector('.why') && c.querySelector('.deck') && c.querySelector('.lab')));
    check(full, `${w}px ${SP.id}: every story has a deck, Why it matters, a label and sources inside Read more`);
    // ---- layout ----
    const L = await page.evaluate(()=>{ const lb=document.getElementById('leadbox').getBoundingClientRect(), g=document.getElementById('glance').getBoundingClientRect();
      const cols=[...document.querySelectorAll('[data-sec] .grid')].map(x=>getComputedStyle(x).gridTemplateColumns.split(' ').filter(Boolean).length);
      return {side: g.left>=lb.right-1 && g.top<lb.bottom, cols:Math.min(...cols), sticky:getComputedStyle(document.getElementById('snav')).position, wrapW:document.querySelector('main .wrap').getBoundingClientRect().width}; });
    if (w>=1024) { check(L.side && L.cols>=3 && L.sticky==='sticky' && L.wrapW<=1200, `${w}px ${SP.id}: desktop — lead with Month at a glance beside it, ${L.cols}-column grids, sticky section bar, ${Math.round(L.wrapW)}px content`);
      await page.evaluate(()=>{ document.querySelectorAll('details.more').forEach(d=>d.open=false); scrollTo(0,0); });
      if (w===1280) { await page.screenshot({path:`${shots}/${SHOT}-1280.png`});
        await page.evaluate(async()=>{ document.querySelectorAll('img[loading=lazy]').forEach(i=>i.loading='eager'); await Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))); });
        await page.screenshot({path:`${shots}/${SHOT}-1280-full.png`, fullPage:true}); } }
    else if (phone) check(L.cols<=1 && L.sticky!=='sticky', `${w}px ${SP.id}: phone single column, no sticky bar`);
    const T2 = await page.evaluate(()=>({h1:getComputedStyle(document.querySelector('.ttl h1')).fontFamily, acc:getComputedStyle(document.querySelector('.kick')).color, brand:getComputedStyle(document.querySelector('.mast')).borderTopColor}));
    check(/Georgia/.test(T2.h1) && T2.acc==='rgb(176, 16, 42)' && T2.brand==='rgb(200, 16, 46)', `${w}px ${SP.id}: Donna type system (serif headlines, deep-red accent, red brand rule)`);
    // ---- back to top ----
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';scrollTo(0,3000);}); await page.waitForTimeout(150);
    const T = await page.evaluate(()=>{ const t=document.getElementById('totop'); const r=t.getBoundingClientRect(); return {shown:getComputedStyle(t).display!=='none', h:r.height, fixed:getComputedStyle(t).position}; });
    check(T.shown && T.h>=44 && T.fixed==='fixed', `${w}px ${SP.id}: Back to top shown after scrolling`);
    await page.click('#totop'); await page.waitForTimeout(250); const nt = await page.evaluate(()=>document.getElementById('snav').getBoundingClientRect().top); check(Math.abs(nt)<5, `${w}px ${SP.id}: Back to top lands on the section bar (${Math.round(nt)}px)`);
    // ---- shareable URL ----
    await page.goto(base+p+`?section=${TC.share[0]}&region=${TC.share[1]}`); v=await vis(); check(v===nSR(TC.share[0],TC.share[1]), `${w}px ${SP.id}: ?section=${TC.share[0]}&region=${TC.share[1]} -> ${v} (expected ${nSR(TC.share[0],TC.share[1])})`);
    check(errs.length===0, `${w}px ${SP.id}: no JS errors ${errs.join('|')}`);
    // ---- home page link + screenshot ----
    if (w===390) { await page.goto(base+'index.html'); if (SP===SPECIALS[0]) await page.screenshot({path:`${shots}/home-390.png`});
      const hl = page.locator(`a[href="${SP.href}"]:visible`).first(); check(await hl.count()===1, `390px home links to "${SP.title}"`);
      await hl.click(); check(page.url().endsWith(SP.href), `390px home link opens ${SP.href}`); }
    await ctx.close();
  }
  { const ctx = await browser.newContext({viewport:{width:390,height:844}, javaScriptEnabled:false}); const page = await ctx.newPage(); await page.goto(base+p);
    const n = await page.locator('[data-story]:visible').count(); const t = await page.locator('[data-tab]:visible').count();
    check(n===N && t===SECS.length+1, `no-JS ${SP.id}: ${n} stories readable (expected ${N}), section links visible`);
    await page.locator('#leadbox details.more > summary').click(); check(await page.locator('#leadbox details.more .srcs a:visible').count()>0, `no-JS ${SP.id}: Read more expands`); await ctx.close(); }
}

// no-JS reading: every story readable, expansion works, region links jump to sections
{ const ctx = await browser.newContext({viewport:{width:390,height:844}, javaScriptEnabled:false}); const page = await ctx.newPage();
  await page.goto(base+'index.html'); const n = await page.locator('[data-story]:visible').count(); check(n===N_TOTAL, `no-JS: ${n} stories readable (expected ${N_TOTAL})`);
  check(await page.locator('#ftoggle:visible').count()===0 && await page.locator('[data-chip]:visible').count()===6, 'no-JS: filter toggle hidden, region links still shown');
  await page.locator('#lead-sec details.more > summary').click(); check(await page.locator('#lead-sec details.more .srcs a:visible').count()>0, 'no-JS: story expansion still works');
  await ctx.close(); }

// ---------- edge cases: long headline, missing images, empty region, empty topic (fixture build) ----------
{ const FX='/tmp/dd-fixture'; fs.rmSync(FX,{recursive:true,force:true}); fs.mkdirSync(FX+'/data',{recursive:true});
  fs.cpSync(path.join(ROOT,'data'), FX+'/data', {recursive:true});
  for (const f of fs.readdirSync(FX+'/data/editions')) if (f!==CUR.id+'.json') fs.rmSync(FX+'/data/editions/'+f);
  const ed = JSON.parse(fs.readFileSync(`${FX}/data/editions/${CUR.id}.json`,'utf8'));
  const L = ed.stories.find(s=>s.id===ed.leadId);
  L.headline = 'Polls open across the United States as voters in all fifty states decide control of the House and Senate in a closely fought midterm election that both parties call decisive';
  ed.stories = ed.stories.filter(s=>s.region!=='hk');                         // empty region
  for (const s of ed.stories) if (s.region==='world' || s.id===ed.leadId) delete s.image;   // missing images, incl. the lead
  ed.stories.forEach(s=>{ if (s.topic==='culture') s.topic='human'; });     // empty topic
  fs.writeFileSync(`${FX}/data/editions/${CUR.id}.json`, JSON.stringify(ed));
  let ok=true; try { execFileSync('node',[path.join(ROOT,'tools/build.mjs')],{env:{...process.env, DD_DATA:FX+'/data', DD_OUT:FX+'/public', DD_KEEP_UPD:'1'}, stdio:'pipe'}); } catch(e){ ok=false; console.log(String(e.stdout)+String(e.stderr)); }
  check(ok, `fixture build (long headline ${L.headline.length} chars, no Hong Kong stories, no culture stories, lead + World without photos)`);
  for (const [w,h] of [[360,844],[390,844],[768,1024],[1280,800]]) {
    const ctx = await browser.newContext({viewport:{width:w,height:h}, isMobile:w<760, hasTouch:w<760}); await ctx.addInitScript(PROBES); const page = await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.goto('file://'+FX+'/public/index.html');
    const X = await page.evaluate(()=>{ const h1=document.querySelector('#lead-sec h1'); const r=h1.getBoundingClientRect();
      return {sw:document.documentElement.scrollWidth, iw:innerWidth, h1B:r.bottom, clip:h1.scrollWidth>h1.clientWidth+1, broken:[...document.images].filter(i=>i.complete&&i.naturalWidth===0&&i.loading!=='lazy').length,
        leadNoPh:!document.querySelector('#lead-sec img'), hk:document.querySelector('#region-hk [data-empty-region]')?.textContent, worldThumbs:document.querySelectorAll('#region-world img').length}; });
    check(X.sw<=X.iw && !X.clip && X.broken===0, `fixture ${w}px: long headline wraps without overflow or clipping (${X.sw}<=${X.iw})`);
    if (w<760) check(X.h1B<=h, `fixture ${w}px: ${L.headline.length}-char lead headline still fully on the first screen (bottom ${Math.round(X.h1B)}px)`);
    check(X.leadNoPh && X.worldThumbs===0 && /No Hong Kong stories in this edition/.test(X.hk||''), `fixture ${w}px: text-only lead and cards render cleanly; empty region says "${X.hk}"`);
    await page.click('[data-chip=hk]'); const E = await page.evaluate(()=>({shown:!document.getElementById('fempty').classList.contains('hidden'), t:document.getElementById('femptytxt').textContent}));
    check(E.shown && /No Hong Kong stories in this edition/.test(E.t), `fixture ${w}px: Hong Kong filter shows an honest empty state ("${E.t}")`);
    await page.click('#freset'); await page.click('#ftoggle'); await page.click('[data-tchip=culture]');
    const E2 = await page.evaluate(()=>({shown:!document.getElementById('fempty').classList.contains('hidden'), t:document.getElementById('femptytxt').textContent}));
    check(E2.shown && /No Culture & entertainment stories in this edition/.test(E2.t), `fixture ${w}px: empty topic message ("${E2.t}")`);
    if (w===390) await page.screenshot({path:`${shots}/redesign-after-edgecase-390.png`});
    check(errs.length===0, `fixture ${w}px: no JS errors ${errs.join('|')}`); await ctx.close(); } }

await browser.close(); console.log(fail? `${fail} FAILURES`:'ALL PASS'); process.exit(fail?1:0);
