// Renders the built site at phone and desktop sizes and checks layout, navigation, filters and links.
// Usage: node tools/test.mjs [baseURL]
import { chromium } from 'playwright-core'; import path from 'path'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUB = path.join(ROOT,'public');
const base = process.argv[2] || 'file://' + PUB + '/';
const exe = ['/usr/bin/google-chrome','/usr/bin/chromium'].find(f=>fs.existsSync(f));
const browser = await chromium.launch({executablePath: exe, args:['--no-sandbox']});
const sizes = [[360,844],[390,844],[430,844],[1280,800],[1440,900]];   // phones <760px; desktop layout >=1024px
const REG = ['us','ca','hk','cn','world'], TOP = ['politics','business','culture','sports','human'];
// Expected counts come from the current edition in public/data.json.
const DJ = JSON.parse(fs.readFileSync(path.join(PUB,'data.json'),'utf8')); const CUR = DJ.editions.find(e=>e.id===DJ.current);
const nReg = r => CUR.stories.filter(s=>s.region===r).length, nTop = t => CUR.stories.filter(s=>s.topic===t).length;
const N_TOTAL = CUR.stories.length, N_SPORTS = nTop('sports');
const lead = CUR.stories.find(s=>s.id===CUR.leadId) || CUR.stories[0];
const words = h => h.split(/[^A-Za-z]+/).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length);
const SEARCH_Q = (words(lead.headline)[0] || CUR.stories.map(s=>words(s.headline)[0]).find(Boolean) || '').toLowerCase();
const EMPTY_TOPIC = TOP.find(t=>nTop(t)===0);   // e.g. culture with 0 stories (may be undefined)
let fail = 0; const shots = path.join(ROOT,'screenshots'); fs.mkdirSync(shots,{recursive:true});
const check = (c,msg)=>{ console.log((c?'PASS ':'FAIL ')+msg); if(!c) fail++; };
check(N_TOTAL>0 && !!SEARCH_Q, `current edition ${CUR.id} has ${N_TOTAL} stories, search term "${SEARCH_Q}", empty topic: ${EMPTY_TOPIC||'none'}`);
const edPages = fs.readdirSync(path.join(PUB,'editions')).filter(f=>f.endsWith('.html')).map(f=>'editions/'+f);
// special editions live in editions/<id>/index.html (kind:"special"; listed in data.json "specials")
const SPECIALS = DJ.specials || [];
const spPages = SPECIALS.map(sp=>sp.href);
const edEditionPages = edPages.filter(p=>{ const id=path.basename(p,'.html'); return DJ.editions.some(e=>e.id===id); });

// ---------- static link checks over every built page ----------
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
    check(!/class="lab [^"]*">Fact</.test(html), `${p} has no blanket "Fact" badge`);
  }
  check(bad.length===0, `links well-formed (${nExt} external https, ${nInt} internal resolve) ${bad.slice(0,8).join(' | ')}`); }

for (const [w,h] of sizes) {
  const phone = w<760;
  const ctx = await browser.newContext({viewport:{width:w,height:h}, deviceScaleFactor: phone?2:1, isMobile: phone, hasTouch: phone});
  const page = await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const vis = () => page.locator('[data-story]:not(.hidden)').count();
  const openTools = () => page.evaluate(()=>{ const t=document.getElementById('ftools'); if(t) t.open=true; });
  // Latest (and the desktop rail) must be hidden or non-empty, never an empty heading
  const latestOk = () => page.evaluate(()=>{ const shown=e=>!!e&&e.offsetParent!==null&&getComputedStyle(e).display!=='none';
    const L=document.getElementById('latest'), R=document.querySelector('.rail');
    const nl=L?[...L.querySelectorAll('li')].filter(shown).length:0, nr=R?[...R.querySelectorAll('li')].filter(shown).length:0;
    return {ok:(!shown(L)||nl>0)&&(!shown(R)||nr>0), nl, nr, lshown:shown(L)}; });
  for (const p of ['index.html', ...edPages]) {
    await page.goto(base+p); await page.waitForLoadState('load');
    const ov = await page.evaluate(()=>({sw:document.documentElement.scrollWidth, iw:innerWidth}));
    check(ov.sw<=ov.iw, `${w}px ${p} no horizontal overflow (${ov.sw}<=${ov.iw})`);
    const im = await page.evaluate(()=>{ const out={n:0,bad:[],lazyLead:0,missingAttr:0,srcs:[]};
      document.querySelectorAll('.ph img').forEach(i=>{ out.n++; const r=i.getBoundingClientRect(), pr=i.closest('article').getBoundingClientRect();
        if(r.left<-0.5||r.right>innerWidth+0.5||r.width>pr.width+33) out.bad.push(i.getAttribute('src')+' '+Math.round(r.left)+'..'+Math.round(r.right));
        const ratio=r.width/r.height; if(r.width>0&&(ratio<1.3||ratio>1.9)) out.bad.push(i.getAttribute('src')+' ratio '+ratio.toFixed(2));
        if(!i.getAttribute('width')||!i.getAttribute('height')||!i.getAttribute('alt')) out.missingAttr++;
        if(i.closest('.ph-lead')&&i.loading==='lazy') out.lazyLead++; out.srcs.push(i.src);
        const fc=i.closest('figure').querySelector('figcaption a[href^="https://"]'); if(!fc) out.bad.push(i.getAttribute('src')+' no credit link'); });
      return out; });
    check(im.bad.length===0, `${w}px ${p} ${im.n} photos inside viewport/column, 16:9, credit linked ${im.bad.join(' | ')}`);
    if (im.n) { check(im.missingAttr===0 && im.lazyLead===0, `${w}px ${p} photo width/height/alt set, lead eager`);
      const miss = base.startsWith('file://') ? im.srcs.filter(u=>!fs.existsSync(decodeURIComponent(new URL(u).pathname))) : [];
      check(miss.length===0, `${w}px ${p} photo files exist ${miss.join(' ')}`); }
    const body = await page.evaluate(()=>({len:document.querySelector('main').innerText.length, title:document.title}));
    check(body.len>200 && /Donna Daily/.test(body.title), `${w}px ${p} renders (${body.len} chars of content)`);
  }
  // archive edition pages: the same front-page rules apply (regions, Read more, About this edition)
  for (const p of edEditionPages) { await page.goto(base+p);
    const a = await page.evaluate(()=>({chips:[...document.querySelectorAll('[data-chip]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent&&r.left>=0&&r.right<=innerWidth;}).length,
      more:document.querySelectorAll('details.more').length, about:!!document.querySelector('details.about'), banner:!!document.querySelector('.banner a[href="../index.html"]')}));
    check(a.chips===5 && a.more>0 && a.about && a.banner, `${w}px ${p} archive edition: 5 region controls, Read more, About, link to today`); }

  await page.goto(base+'index.html'); await page.waitForLoadState('load');
  const leadOk = await page.evaluate(()=>{ const i=document.querySelector('.ph-lead img'); return !i || (i.complete && i.naturalWidth>0); });
  check(leadOk, `${w}px lead photo loaded`);
  // ---- first screen ----
  const F = await page.evaluate(()=>{ const r=s=>document.querySelector(s)?.getBoundingClientRect();
    const h1=r('.lead h1'), dk=r('.lead .deck'), im=r('.lead .ph'); const about=document.querySelector('details.about');
    const secs=[...document.querySelectorAll('section[data-region-sec]:not(#lead-sec)')]; const lastSec=secs[secs.length-1];
    return {h1:h1.top, deckBottom:dk.bottom, deckBeforeImg: !im || dk.bottom<=im.top+1, h1BeforeImg: !im || h1.bottom<=im.top+1,
      aboutClosed: !!about && !about.open, aboutAfterStories: !!about && !!lastSec && (lastSec.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING)>0,
      noteBeforeLead: [...document.querySelectorAll('main .note')].some(n=>n.getBoundingClientRect().top < h1.top && !n.closest('details')),
      sourcing: /not every claim has been independently verified/i.test(about?.textContent||''), toolsTop: r('#ftools')?.top ?? 1e9, height: document.documentElement.scrollHeight }; });
  check(F.h1BeforeImg && F.deckBeforeImg, `${w}px lead headline and deck come before the lead photo`);
  check(F.aboutClosed && F.aboutAfterStories && !F.noteBeforeLead && F.sourcing, `${w}px production note is in a collapsed "About this edition" after the stories, with sourcing note`);
  check(F.toolsTop < F.h1, `${w}px search/filter control sits above the lead (top ${Math.round(F.toolsTop)}px)`);
  if (phone) { check(F.h1 < 844, `${w}px lead headline top ${Math.round(F.h1)}px within first screen (<844)`);
    if (w===390) { check(F.deckBottom <= 844, `390px lead headline + deck fully visible on first screen (deck bottom ${Math.round(F.deckBottom)}px)`);
      console.log(`INFO 390px page height ${F.height}px, lead h1 top ${Math.round(F.h1)}px`); } }
  if (phone) await page.screenshot({path:`${shots}/first-screen-${w}.png`});
  if (w===390) await page.screenshot({path:`${shots}/phone-390.png`});
  // ---- nav: five regions + Past editions visible, no horizontal scroll ----
  const N = await page.evaluate(()=>{ const nav=document.querySelector('nav.chips .wrap'); const ch=[...document.querySelectorAll('nav.chips .chip')].filter(e=>e.offsetParent);
    const inView=e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0&&e.scrollWidth<=e.clientWidth+1;};
    return {regions:[...document.querySelectorAll('[data-chip]')].filter(e=>e.offsetParent&&inView(e)).length, past:ch.some(e=>/Past editions|Archive/.test(e.textContent)&&inView(e)),
      scroll: nav.scrollWidth>nav.clientWidth+1, cs:getComputedStyle(nav).overflowX}; });
  check(N.regions===5 && N.past && !N.scroll, `${w}px all 5 region controls + Past editions visible within the viewport, no hidden scroll`);
  // ---- layout mode ----
  const L = await page.evaluate(()=>{ const vis=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
    const lead=document.querySelector('#lead-sec'), rail=document.querySelector('.rail'), nav=document.querySelector('nav.chips');
    const secs=[...document.querySelectorAll('section[data-region-sec]:not(#lead-sec)')];
    const cols=secs.map(s=>getComputedStyle(s).gridTemplateColumns.split(' ').filter(Boolean).length);
    const rowMax=Math.max(0,...secs.map(s=>{const t={};[...s.querySelectorAll(':scope>.card')].forEach(c=>{const y=Math.round(c.getBoundingClientRect().top);t[y]=(t[y]||0)+1;});return Math.max(0,...Object.values(t));}));
    const lr=lead.getBoundingClientRect(), rr=rail?rail.getBoundingClientRect():null;
    return {railVis:vis(rail), sideBySide: !!rr && rr.left>=lr.right-1 && rr.top<lr.bottom, leadW:lr.width, cols:Math.min(...cols), rowMax,
      sticky:getComputedStyle(nav).position, navBg:getComputedStyle(nav).backgroundColor, dtVisible:[...document.querySelectorAll('.dt-only')].filter(vis).length,
      sports:vis(document.querySelector('[data-tchip=sports]')), wrapW:document.querySelector('main .wrap').getBoundingClientRect().width}; });
  if (phone) check(!L.railVis && L.dtVisible===0 && L.sticky!=='sticky' && L.cols<=1, `${w}px phone layout (no desktop-only elements, single column, no sticky header)`);
  if (w>=1024) {
    check(L.railVis && L.sideBySide && L.leadW>=500, `${w}px desktop: lead (${Math.round(L.leadW)}px) with Top stories rail beside it`);
    check(L.cols>=3 && L.rowMax>=2, `${w}px desktop: region grids ${L.cols}+ columns, up to ${L.rowMax} cards per row`);
    check(L.sticky==='sticky' && L.navBg==='rgb(17, 17, 17)' && L.sports, `${w}px desktop: black sticky section nav with Sports`);
    check(L.wrapW<=1264 && L.wrapW>=900, `${w}px desktop: content width ${Math.round(L.wrapW)}px (<=1264)`);
    await page.click('[data-tchip=sports]'); let vs = await vis(); check(vs===N_SPORTS, `${w}px nav Sports -> ${vs} (expected ${N_SPORTS})`);
    let lo = await latestOk(); check(lo.ok, `${w}px Sports: Latest/rail hidden or non-empty (${lo.nl}/${lo.nr})`);
    await page.click('[data-tchip=sports]'); vs = await vis(); check(vs===N_TOTAL, `${w}px nav Sports toggle off -> ${vs}`);
    await page.evaluate(()=>scrollTo(0,0));
    if (w===1280) { await page.screenshot({path:`${shots}/desktop-1280.png`});
      await page.evaluate(async()=>{ document.querySelectorAll('img[loading=lazy]').forEach(i=>i.loading='eager'); await Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))); });
      await page.screenshot({path:`${shots}/desktop-1280-full.png`, fullPage:true}); }
  }
  const fs16 = await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.card p')).fontSize));
  check(fs16>=16 && fs16<=18, `${w}px body text ${fs16}px`);
  // ---- touch targets: phones 44px; desktop (mouse) 24px ----
  const minT = phone ? 44 : 24; await openTools();
  const small = await page.evaluate(m=>[...document.querySelectorAll('.chip,.latest a,.rail a,.btn:not(.hidden),.tools input,.tools select,.arch a,details>summary')].filter(e=>e.offsetParent).map(e=>[e.textContent.slice(0,20),e.getBoundingClientRect().height]).filter(x=>x[1]<m), minT);
  check(small.length===0, `${w}px targets >=${minT}px (${small.length} small ${JSON.stringify(small.slice(0,3))})`);
  // ---- counts on filter controls ----
  const C = await page.evaluate(()=>({reg:[...document.querySelectorAll('#fr option')].map(o=>[o.value,o.textContent]), top:[...document.querySelectorAll('#ft option')].map(o=>[o.value,o.textContent]),
    chips:[...document.querySelectorAll('[data-chip]')].map(c=>[c.dataset.chip,c.querySelector('.n')?.textContent])}));
  check(REG.every(r=>C.reg.find(o=>o[0]===r)?.[1].includes(`(${nReg(r)})`)) && TOP.every(t=>C.top.find(o=>o[0]===t)?.[1].includes(`(${nTop(t)}`)) && REG.every(r=>C.chips.find(c=>c[0]===r)?.[1]===String(nReg(r))),
    `${w}px region/topic controls show story counts (topics: ${C.top.map(o=>o[1]).join(', ')})`);
  // ---- region filters via chips: count, aria-pressed + visual state, Latest never empty ----
  for (const r of REG) { await page.click(`[data-chip=${r}]`); const v = await vis(); const lo = await latestOk();
    const st = await page.evaluate(r=>{ const c=document.querySelector(`[data-chip=${r}]`), o=document.querySelector('[data-chip]:not([data-chip='+r+'])');
      return {pressed:c.getAttribute('aria-pressed'), others:[...document.querySelectorAll('[data-chip]')].filter(x=>x!==c&&x.getAttribute('aria-pressed')==='true').length, bg:getComputedStyle(c).backgroundColor, obg:getComputedStyle(o).backgroundColor}; }, r);
    check(v===nReg(r) && st.pressed==='true' && st.others===0 && st.bg!==st.obg, `${w}px region ${r} -> ${v} (expected ${nReg(r)}), marked active (aria-pressed, ${st.bg})`);
    check(lo.ok, `${w}px region ${r}: Latest hidden or non-empty (${lo.nl} items${lo.lshown?'':', hidden'})`);
    if (w===390 && r==='ca') { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/filter-canada-390.png`}); }
    await page.click(`[data-chip=${r}]`); }
  check(await vis()===N_TOTAL, `${w}px chip toggle off -> all ${N_TOTAL}`);
  // ---- topic filters (incl. an empty topic) ----
  await openTools();
  for (const t of TOP) { await page.selectOption('#ft', t); const v = await vis(); const lo = await latestOk();
    const em = await page.evaluate(()=>{ const e=document.getElementById('fempty'); return {shown:!e.classList.contains('hidden'), txt:e.textContent, btn:!!e.querySelector('#freset')}; });
    check(v===nTop(t) && lo.ok && (v>0 ? !em.shown : (em.shown && em.btn && /No .+ stories in this edition|No stories match/.test(em.txt))), `${w}px topic ${t} -> ${v} (expected ${nTop(t)}), Latest ok (${lo.nl}), ${v?'no empty state':'empty state: "'+em.txt.slice(0,60)+'"'}`); }
  await page.selectOption('#ft','all');
  // ---- search ----
  const total = await page.locator('[data-story]').count();
  const nQ = await page.evaluate(q=>[...document.querySelectorAll('[data-story]')].filter(c=>c.textContent.toLowerCase().includes(q)).length, SEARCH_Q);
  await page.fill('#q',SEARCH_Q); let v = await vis(); check(nQ>=1 && nQ<total && v===nQ, `${w}px search "${SEARCH_Q}" -> ${v} (expected ${nQ} of ${total})`);
  check((await latestOk()).ok, `${w}px search: Latest hidden or non-empty`);
  await page.fill('#q','zzzzqqq'); const lo0 = await latestOk();
  check(await page.locator('#fempty:not(.hidden) #freset').count()===1 && lo0.ok && !lo0.lshown, `${w}px no-results search: message + reset shown, Latest hidden`);
  if (w===390) { await page.evaluate(()=>scrollTo(0,0)); await page.screenshot({path:`${shots}/search-no-results-390.png`}); }
  await page.click('#freset'); v = await vis(); check(v===total && await page.inputValue('#q')==='', `${w}px reset -> ${v}/${total}, search cleared`);
  await page.fill('#q','zzzzqqq'); await page.click('#fclear'); v = await vis(); check(v===total, `${w}px "Show all stories" in the filter panel -> ${v}/${total}`);
  // ---- Read more ----
  await page.goto(base+'index.html');
  const rm = page.locator('#lead-sec details.more > summary'); await rm.click();
  const R = await page.evaluate(()=>{ const d=document.querySelector('#lead-sec details.more'); const a=[...d.querySelectorAll('.srcs a')]; return {open:d.open, links:a.filter(x=>x.offsetParent&&x.getBoundingClientRect().height>0).length, n:a.length}; });
  check(R.open && R.links>0 && R.links===R.n, `${w}px Read more expands (${R.links} source links visible)`);
  const full = await page.evaluate(()=>[...document.querySelectorAll('[data-story]')].every(c=>c.querySelector('details.more .srcs a')));
  check(full, `${w}px every story keeps its sources inside Read more`);
  if (w===390) { await page.locator('#lead-sec details.more').scrollIntoViewIfNeeded(); await page.evaluate(()=>{const d=document.querySelector('#lead-sec details.more');scrollTo(0,d.getBoundingClientRect().top+scrollY-120);}); await page.screenshot({path:`${shots}/read-more-390.png`}); }
  // ---- back to top / regions (phones) ----
  if (phone) { await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';scrollTo(0,3000);}); await page.waitForTimeout(150);
    const T = await page.evaluate(()=>{ const t=document.getElementById('totop'); const r=t.getBoundingClientRect(); return {shown:getComputedStyle(t).display!=='none', h:r.height, w:r.width, fixed:getComputedStyle(t).position}; });
    check(T.shown && T.h>=44 && T.h<=60 && T.w<=200 && T.fixed==='fixed', `${w}px small Back to top/Regions button after scrolling (${Math.round(T.w)}x${Math.round(T.h)})`);
    await page.click('#totop'); await page.waitForTimeout(200); const navTop = await page.evaluate(()=>document.getElementById('regions').getBoundingClientRect().top);
    check(Math.abs(navTop)<5, `${w}px Back to top lands on the Regions nav (${Math.round(navTop)}px)`);
    await page.evaluate(()=>{scrollTo(0,0);}); const hiddenTop = await page.evaluate(()=>getComputedStyle(document.getElementById('totop')).display==='none'); check(hiddenTop, `${w}px Back to top hidden at the top of the page`); }
  await page.goto(base+'index.html?region=ca'); v = await vis(); check(v===nReg('ca') && (await latestOk()).ok, `${w}px URL ?region=ca -> ${v} (expected ${nReg('ca')}), Latest ok`);
  // ---- archive navigation ----
  await page.goto(base+'index.html'); await page.click('nav.chips .chip.red'); check(/editions\/index\.html$/.test(page.url()), `${w}px Past editions link opens the archive list`);
  const archLinks = await page.evaluate(()=>[...document.querySelectorAll('.arch a')].map(a=>a.getAttribute('href')));
  check(archLinks.length>=edPages.length-1, `${w}px archive list links to ${archLinks.length} editions`);
  const prevEd = edEditionPages.filter(p=>!p.endsWith(CUR.id+'.html'))[0];
  if (prevEd) { await page.goto(base+prevEd); if (w===390) await page.screenshot({path:`${shots}/archive-edition-390.png`});
    if (w===1280) await page.screenshot({path:`${shots}/archive-edition-1280.png`}); }
  await page.goto(base+'editions/2026-10-29-brief.html'); if(w===390) await page.screenshot({path:`${shots}/archive-oct29-390.png`});
  if (w>=1024) { const rw = await page.evaluate(()=>document.querySelector('main .wrap').getBoundingClientRect().width); check(rw<=920, `${w}px archive page reading column ${Math.round(rw)}px`); }
  check(errs.length===0, `${w}px no JS errors ${errs.join('|')}`);
  await ctx.close();
}
// ---------- special editions (e.g. editions/2026-10-review/index.html) ----------
console.log(`INFO special editions in data.json: ${SPECIALS.map(s=>s.id).join(', ')||'none'}`);
{ const home = fs.readFileSync(path.join(PUB,'index.html'),'utf8'), arch = fs.readFileSync(path.join(PUB,'editions/index.html'),'utf8');
  for (const sp of SPECIALS) {
    check(home.includes(`href="${sp.href}"`), `home page links to special ${sp.id}`);
    const first = arch.match(/<ul class="arch">[\s\S]*?<h2 class="sec">Earlier<\/h2><ul class="arch"><li[^>]*><a href="([^"]+)"/);
    check(SPECIALS[0]!==sp || (first && first[1]===sp.href.replace(/^editions\//,'')), `Past editions lists special ${sp.id} first (${first&&first[1]})`);
  }
  check(DJ.current===CUR.id && !SPECIALS.some(sp=>sp.id===DJ.current), `daily front page stays ${DJ.current}; specials never replace it`);
  const ban = [...home.matchAll(/<a class="spb" href="([^"]+)"/g)].map(m=>m[1]);
  check(ban.length<=1 && ban.every(h=>SPECIALS.some(sp=>sp.href===h)) && home.includes('id="lead-sec"'), `home page featured-special banner: ${ban.join(', ')||'none'} (current edition still shown)`); }
for (const SP of SPECIALS) {
  const p = SP.href; const SECS=Object.keys(SP.sections||{news:1,life:1,opinion:1,culture:1}), SREG=Object.keys(SP.regions||{us:1,ca:1,hk:1,cn:1});
  // per-special test settings (data.json specials[].test); defaults are the October 2026 in Review values
  const TC = Object.assign({search:'alberta', combo:['opinion','cn'], share:['opinion','hk'], ourView:[2,3], columnsMin:4}, SP.test||{});
  const SHOT = SP.id==='2026-10-review' ? 'october' : SP.id;
  const nS = k => SP.stories.filter(s=>k==='all'||s.section===k).length, nR = r => SP.stories.filter(s=>r==='all'||s.regions.includes(r)).length;
  const nSR = (k,r) => SP.stories.filter(s=>(k==='all'||s.section===k)&&(r==='all'||s.regions.includes(r))).length;
  const N = SP.stories.length;
  for (const [w,h] of sizes) {
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
    else check(L.cols<=1 && L.sticky!=='sticky', `${w}px ${SP.id}: phone single column, no sticky bar`);
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
      const hl = page.locator(`a.spl[href="${SP.href}"]:visible`); check(await hl.count()===1, `390px home shows a small "${SP.title.replace(/ \d{4}/,'')}" link`);
      await hl.click(); check(page.url().endsWith(SP.href), `390px home link opens ${SP.href}`); }
    await ctx.close();
  }
  { const ctx = await browser.newContext({viewport:{width:390,height:844}, javaScriptEnabled:false}); const page = await ctx.newPage(); await page.goto(base+p);
    const n = await page.locator('[data-story]:visible').count(); const t = await page.locator('[data-tab]:visible').count();
    check(n===N && t===SECS.length+1, `no-JS ${SP.id}: ${n} stories readable (expected ${N}), section links visible`);
    await page.locator('#leadbox details.more > summary').click(); check(await page.locator('#leadbox details.more .srcs a:visible').count()>0, `no-JS ${SP.id}: Read more expands`); await ctx.close(); }
}

// no-JS reading
const ctx = await browser.newContext({viewport:{width:390,height:844}, javaScriptEnabled:false}); const page = await ctx.newPage();
await page.goto(base+'index.html'); const n = await page.locator('[data-story]:visible').count(); check(n===N_TOTAL, `no-JS: ${n} stories readable (expected ${N_TOTAL})`);
const nl = await page.locator('#latest li:visible').count(); check(nl>0 && nl<=6, `no-JS: Latest shows ${nl} items`);
await page.locator('#lead-sec details.more > summary').click(); check(await page.locator('#lead-sec details.more .srcs a:visible').count()>0, 'no-JS: Read more still expands');
await ctx.close();
await browser.close(); console.log(fail? `${fail} FAILURES`:'ALL PASS'); process.exit(fail?1:0);
