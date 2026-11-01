// Converts an archived Grok canvas TSX (the old "Headlines" briefs) into a JSON block tree.
import fs from 'fs'; import { transformSync } from 'esbuild';
const [,, inFile, outFile, id, title, date, updated, dropIds=''] = process.argv;
let src = fs.readFileSync(inFile,'utf8');
src = src.slice(src.indexOf('import {'), src.lastIndexOf('}')+1).replace(/^import .*$/mg,'');
const js = transformSync(src, {loader:'tsx', jsxFactory:'h', jsxFragment:'"frag"', format:'cjs'}).code;
const h = (type, props, ...children) => ({type: typeof type==='function'? type.name : type, props: props||{}, children: children.flat().filter(c=>c!=null&&c!==false)});
const names = ['Page','Section','Text','Rows','Properties','LinkCards','NumberedList','Callout','TableOfContents','BulletList'];
const comps = Object.fromEntries(names.map(n=>[n, {[n]: function(){}}[n]]));
const mod = {exports:{}};
new Function('h','module','exports',...names, js)(h, mod, mod.exports, ...names.map(n=>comps[n]));
const App = mod.exports.default;
let tree = App();
const drop = new Set(dropIds.split(',').filter(Boolean));
function clean(n){ if(typeof n!=='object') return n; if(n.type==='TableOfContents') return null;
  if(n.type==='Section' && drop.has(n.props.id)) return null;
  return {...n, children:n.children.map(clean).filter(Boolean)}; }
tree = clean(tree);
fs.writeFileSync(outFile, JSON.stringify({id, kind:'archive', title, date, updatedLabel: updated, summary: tree.props.summary, blocks: tree.children, droppedSections:[...drop]}, null, 1));
console.log('ok', outFile);
