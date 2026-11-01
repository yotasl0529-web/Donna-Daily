import fs from 'fs';
const src = fs.readFileSync(process.argv[2],'utf8');
const a = src.indexOf('const STORIES: Story[] = [');
const b = src.indexOf('];', src.indexOf('{ id: "w-mayon"'));
const arr = src.slice(a+'const STORIES: Story[] = '.length, b+1);
const stories = eval(arr);
fs.writeFileSync(process.argv[3], JSON.stringify(stories,null,1));
console.log(stories.length);
