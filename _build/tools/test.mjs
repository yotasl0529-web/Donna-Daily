// Renders the built site at phone and desktop sizes, checks overflow and filters. Usage: node tools/test.mjs [baseURL]
import { chromium } from 'playwright-core'; import path from 'path'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const base = process.argv[2] || 'file://' + path.join(ROOT,'public') + '/';
const exe = ['/usr/bin/google-chrome','/usr/bin/chromium'].find(f=>fs.existsSync(f));
const browser = await chromium.launch({executablePath: exe, args:['--no-sandbox']});
const sizes = [[360,800],[390,844],[430,932],[1280,800]];
// Expected filter counts come from the current edition in public/data.json (exact matches, so filters are still fully checked).
const DJ = JSON.parse(fs.readFileSync(path.join(ROOT,'public','data.json'),'utf8')); const CUR = DJ.editions.find(e=>e.id===DJ.current);
const nReg = r => CUR.stories.filter(s=>s.region===r).length, nTop = t => CUR.stories.filter(s=>s.topic===t).length;
const N_TOTAL = CUR.stories.length, N_HK = nReg('hk'), N_CN = nReg('cn'), N_CA = nReg('ca'), N_SPORTS = nTop('sports');
const lead = CUR.stories.find(s=>s.id===CUR.leadId) || CUR.stories[0];
const SEARCH_Q = lead.headline.split(/[^A-Za-z]+/).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length)[0].toLowerCase();
const sanity = N_HK>0 && N_CN>0 && N_CA>0 && N_SPORTS>0 && N_TOTAL>0 && !!SEARCH_Q; let fail = 0; const shots = path.join(ROOT,'screenshots');
fs.mkdirSync(shots,{recursive:true});
const check = (c,msg)=>{ console.log((c?'PASS ':'FAIL ')+msg); if(!c) fail++; };
check(sanity, `current edition ${CUR.id} has HK/China/Canada/Sports stories and a search term (${N_HK}/${N_CN}/${N_CA}/${N_SPORTS}, q=${SEARCH_Q})`);
for (const [w,h] of sizes) {
  const ctx = await browser.newContext({viewport:{width:w,height:h}, deviceScaleFactor: w<800?2:1, isMobile: w<800, hasTouch: w<800});
  const page = await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const edPages = fs.readdirSync(path.join(ROOT,'public','editions')).filter(f=>f.endsWith('.html')).map(f=>'editions/'+f);
  for (const p of ['index.html', ...edPages]) {
    await page.goto(base+p); await page.waitForLoadState('load');
    const ov = await page.evaluate(()=>({sw:document.documentElement.scrollWidth, iw:innerWidth}));
    check(ov.sw<=ov.iw, `${w}px ${p} no horizontal overflow (${ov.sw}<=${ov.iw})`);
    // photos: inside the viewport and their column, 16:9-ish, files resolve, lead not lazy
    const im = await page.evaluate(()=>{ const out={n:0,bad:[],lazyLead:0,missingAttr:0,srcs:[]};
      document.querySelectorAll('.ph img').forEach(i=>{ out.n++; const r=i.getBoundingClientRect(), pr=i.closest('article').getBoundingClientRect();
        if(r.left<-0.5||r.right>innerWidth+0.5||r.width>pr.width+33) out.bad.push(i.getAttribute('src')+' '+Math.round(r.left)+'..'+Math.round(r.right));
        const ratio=r.width/r.height; if(r.width>0&&(ratio<1.3||ratio>1.9)) out.bad.push(i.getAttribute('src')+' ratio '+ratio.toFixed(2));
        if(!i.getAttribute('width')||!i.getAttribute('height')||!i.getAttribute('alt')) out.missingAttr++;
        if(i.closest('.ph-lead')&&i.loading==='lazy') out.lazyLead++; out.srcs.push(i.src); });
      return out; });
    check(im.bad.length===0, `${w}px ${p} ${im.n} photos inside viewport/column, 16:9 ${im.bad.join(' | ')}`);
    if (im.n) { check(im.missingAttr===0 && im.lazyLead===0, `${w}px ${p} photo width/height/alt set, lead eager`);
      const miss = base.startsWith('file://') ? im.srcs.filter(u=>!fs.existsSync(decodeURIComponent(new URL(u).pathname))) : [];
      check(miss.length===0, `${w}px ${p} photo files exist ${miss.join(' ')}`); }
  }
  await page.goto(base+'index.html'); await page.waitForLoadState('load');
  const leadOk = await page.evaluate(()=>{ const i=document.querySelector('.ph-lead img'); return !i || (i.complete && i.naturalWidth>0); });
  check(leadOk, `${w}px lead photo loaded`);
  await page.goto(base+'index.html');
  await page.screenshot({path:`${shots}/home-${w}x${h}.png`});
  if (w===390) { await page.screenshot({path:`${shots}/home-390-full.png`, fullPage:true});
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';document.getElementById('region-hk').scrollIntoView({behavior:'instant'});});
    await page.waitForFunction(()=>[...document.querySelectorAll('#region-hk .ph img')].slice(0,2).every(i=>i.complete&&i.naturalWidth>0),null,{timeout:5000}).catch(()=>{});
    await page.screenshot({path:`${shots}/region-hk-390.png`}); await page.evaluate(()=>{scrollTo(0,0);document.documentElement.style.scrollBehavior='';}); }
  const fs16 = await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.card p')).fontSize));
  check(fs16>=16 && fs16<=18, `${w}px body text ${fs16}px`);
  const small = await page.evaluate(()=>[...document.querySelectorAll('.chip,.srcs a,.latest a,.btn:not(.hidden),.tools input,.tools select,.arch a')].filter(e=>e.offsetParent).map(e=>e.getBoundingClientRect().height).filter(h=>h<44).length);
  check(small===0, `${w}px touch targets >=44px (${small} small)`);
  const total = await page.locator('[data-story]').count();
  await page.selectOption('#fr','hk'); let vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===N_HK, `${w}px region filter HK -> ${vis} (expected ${N_HK})`);
  await page.selectOption('#fr','all'); await page.selectOption('#ft','sports'); vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===N_SPORTS, `${w}px topic Sports -> ${vis} (expected ${N_SPORTS})`);
  await page.selectOption('#ft','all'); const nQ = await page.evaluate(q=>[...document.querySelectorAll('[data-story]')].filter(c=>c.textContent.toLowerCase().includes(q)).length, SEARCH_Q);
  await page.fill('#q',SEARCH_Q); vis = await page.locator('[data-story]:not(.hidden)').count(); check(nQ>=1 && nQ<total && vis===nQ, `${w}px search "${SEARCH_Q}" -> ${vis} (expected ${nQ} of ${total})`);
  await page.fill('#q','zzzzqqq'); check(await page.locator('#fempty:not(.hidden)').count()===1, `${w}px empty state`);
  await page.click('#fclear'); vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===total, `${w}px clear -> ${vis}/${total}`);
  await page.click('[data-chip=cn]'); vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===N_CN, `${w}px chip China -> ${vis} (expected ${N_CN})`);
  if (w===390) await page.screenshot({path:`${shots}/chip-china-390.png`});
  await page.click('[data-chip=cn]'); vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===total, `${w}px chip toggle off -> ${vis}`);
  await page.goto(base+'index.html?region=ca'); vis = await page.locator('[data-story]:not(.hidden)').count(); check(vis===N_CA, `${w}px URL ?region=ca -> ${vis} (expected ${N_CA})`);
  await page.goto(base+'editions/2026-10-29-brief.html'); if(w===390) await page.screenshot({path:`${shots}/archive-oct29-390.png`});
  check(errs.length===0, `${w}px no JS errors ${errs.join('|')}`);
  await ctx.close();
}
// no-JS reading
const ctx = await browser.newContext({viewport:{width:390,height:844}, javaScriptEnabled:false}); const page = await ctx.newPage();
await page.goto(base+'index.html'); const n = await page.locator('[data-story]:visible').count(); check(n===N_TOTAL, `no-JS: ${n} stories readable (expected ${N_TOTAL})`);
await page.screenshot({path:`${shots}/home-390-nojs.png`}); await ctx.close();
await browser.close(); console.log(fail? `${fail} FAILURES`:'ALL PASS'); process.exit(fail?1:0);
