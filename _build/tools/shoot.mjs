// Usage: node tools/shoot.mjs <baseURL> <prefix>  — home at 390x844, 1280x800, 1286x683 (+ past editions)
import { chromium } from 'playwright-core'; import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [base, prefix] = [process.argv[2], process.argv[3]||'shot'];
const exe = ['/usr/bin/google-chrome','/usr/bin/chromium'].find(f=>fs.existsSync(f));
const b = await chromium.launch({executablePath:exe,args:['--no-sandbox']});
for (const [w,h] of [[390,844],[1280,800],[1286,683]]) {
  const phone=w<760; const ctx=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:phone?2:1,isMobile:phone,hasTouch:phone}); const p=await ctx.newPage();
  await p.goto(base+'index.html',{waitUntil:'load'}); await p.waitForTimeout(400);
  const y = await p.evaluate(()=>{const e=document.querySelector('.lead h1, .lead h2'); const d=document.querySelector('.lead .deck'); return e?[Math.round(e.getBoundingClientRect().top), d?Math.round(d.getBoundingClientRect().bottom):null]:null;});
  console.log(`${prefix} ${w}x${h} lead headline top / deck bottom = ${y}`);
  await p.screenshot({path:`${ROOT}/screenshots/${prefix}-home-${w}x${h}.png`});
  if (w!==1286) { await p.goto(base+'editions/index.html',{waitUntil:'load'}); await p.screenshot({path:`${ROOT}/screenshots/${prefix}-past-editions-${w}x${h}.png`}); }
  await ctx.close();
}
await b.close();
