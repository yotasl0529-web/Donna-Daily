// Checks every source link in the CURRENT edition. Exit 1 if any hard failure (404/410/DNS). 401/402/403/406/429 = bot-blocked/paywalled, reported as WARN (verify by browser/WebFetch).
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(ROOT,'data','editions');
const eds = fs.readdirSync(dir).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))).filter(e=>e.kind==='edition').sort((a,b)=>a.id<b.id?1:-1);
const ed = process.argv[2] ? eds.find(e=>e.id===process.argv[2]) : eds[0];
const urls = [...new Set(ed.stories.flatMap(s=>s.sources.map(l=>l.href)))];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
let hard=0;
await Promise.all(urls.map(async u=>{ try{ const r = await fetch(u,{redirect:'follow',headers:{'user-agent':UA},signal:AbortSignal.timeout(25000)});
  const tag = r.ok?'OK  ':[401,402,403,406,429].includes(r.status)?'WARN':'FAIL'; if(tag==='FAIL') hard++; console.log(tag, r.status, u);
 }catch(e){ console.log('WARN', 'ERR', u, e.cause?.code||e.name); }}));
console.log(`${ed.id}: ${urls.length} links, ${hard} hard failures`); process.exit(hard?1:0);
