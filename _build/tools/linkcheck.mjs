// Checks every source link in the CURRENT edition (or the edition or special-edition id given as argv[2]).
// Exit 1 if any hard failure (404/410). 401/402/403/406/429 = bot-blocked/paywalled and network errors are WARN
// (an access limit, not evidence of a broken link or false reporting; verify by browser/WebFetch).
// Writes the result to data/checks/<edition-id>-links.json (rendered as "Automated link check" lines; it checks that links open, not what they say).
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(ROOT,'data','editions');
const eds = fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))).filter(e=>e.kind==='edition').sort((a,b)=>a.id<b.id?1:-1);
// Special editions (data/specials/*.json, kind:"special") can be checked by id too: node tools/linkcheck.mjs 2026-10-review
const sdir = path.join(ROOT,'data','specials');
const specs = fs.existsSync(sdir) ? fs.readdirSync(sdir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(sdir,f),'utf8'))).filter(e=>e.kind==='special') : [];
const ed = process.argv[2] ? [...eds, ...specs].find(e=>e.id===process.argv[2]) : eds[0];
if(!ed){ console.error(`no edition or special with id ${process.argv[2]}`); process.exit(1); }
const urls = [...new Set(ed.stories.flatMap(s=>s.sources.map(l=>l.href)))];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// ISO 8601 time with the America/New_York offset, e.g. 2026-11-02T09:41:05-05:00
function isoNY(d=new Date()){ const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
  const asUTC=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); const off=Math.round((asUTC-d.getTime())/60000); const s=off<0?'-':'+', a=Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`; }
let hard=0; const results=[]; const ranAt=isoNY();
await Promise.all(urls.map(async u=>{ try{ const r = await fetch(u,{redirect:'follow',headers:{'user-agent':UA},signal:AbortSignal.timeout(25000)});
  const tag = r.ok?'OK':[401,402,403,406,429].includes(r.status)?'WARN':'FAIL'; if(tag==='FAIL') hard++; console.log(tag.padEnd(4), r.status, u); results.push({url:u,status:r.status,tag,checkedAt:isoNY()});
 }catch(e){ console.log('WARN', 'ERR', u, e.cause?.code||e.name); results.push({url:u,status:'ERR',tag:'WARN',error:String(e.cause?.code||e.name),checkedAt:isoNY()}); }}));
fs.mkdirSync(path.join(ROOT,'data','checks'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'data','checks',`${ed.id}-links.json`), JSON.stringify({edition:ed.id, ranAt, method:'HTTP GET with a mobile browser user-agent; follows redirects', results:results.sort((a,b)=>urls.indexOf(a.url)-urls.indexOf(b.url))},null,1));
console.log(`${ed.id}: ${urls.length} links, ${hard} hard failures`); process.exit(hard?1:0);
