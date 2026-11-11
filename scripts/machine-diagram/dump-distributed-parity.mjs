/** Run the reference gallery engine, never the application implementation.
 * Source: vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a (catalogue v2.1).
 * Usage: node scripts/machine-diagram/dump-distributed-parity.mjs gallery.html
 */
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
if (!process.argv[2])
  throw new Error("Usage: dump-distributed-parity.mjs gallery.html");
const source = fs
  .readFileSync(process.argv[2], "utf8")
  .split("<script>")[1]
  .split("/* ---------- cells ---------- */")[0];
const dump = `
function story(cell){const i=cell.si;if(!cell.S[i])cell.S[i]=cell.c.build(i===1,scName(cell.c,i));return cell.S[i];}
const round=n=>Math.round(n*1e4)/1e4;
function frame(c,S,t){
 const fade=1-sm(S.period-.6,S.period-.2,t), cards=[];
 S.cards.forEach((c,i)=>{const a=sm(c.born,c.born+.1,t)*(1-sm(c.dies,c.dies+.12,t))*fade;if(a<=0)return;
 const [x,y]=cardPos(c,t);let lean=0;for(const L of c.lean)lean+=sm(L-.22,L,t)*(1-sm(L,L+.3,t));
 cards.push({i,x:round(x),y:round(y),a:round(a),lean:round(lean*38),role:colorAt(c.col,t),tags:c.tags.filter(([,a,b])=>win(t,a,b)>0).map(([s,a,b,dy])=>[s,round(x),round(y+(dy||-22)),round(win(t,a,b)*fade)])});});
 const gates=(c.gates||[]).map(G=>{let open=0;for(const c of S.cards){if(c.dot)continue;for(let k=-3;k<=4;k++){const tt=t+k*.04;if(tt<c.born||tt>c.dies)continue;const p=cardPos(c,tt);open=Math.max(open,1-sm(10,30,Math.hypot(p[0]-G.x,p[1]-G.y)));}}return [round(open),(G.amber?G.amber(t):0)>.3];});
 let i=0;while(i+1<S.notes.length&&S.notes[i+1][0]<=t)i++;const cur=S.notes[i];
 return {t,fade:round(fade),cards,gates,note:cur.slice(1),prev:i>0&&t-cur[0]<.26?S.notes[i-1][1]:null};
}
const result={};for(const c of C.filter(c=>c.fam===8)){
 const cell={c,si:0,S:{}};
 const sc=c.sc.map((_,i)=>{cell.si=i;const S=story(cell);const times=new Set(Array.from({length:Math.floor(S.period*10)+1},(_,j)=>Math.round(j*0.1*1e6)/1e6));times.add(scStill(c,i));for(const st of STATES){const p=statePose(cell,st);if(cell.si===i)times.add(p.t);}return {name:scName(c,i),frames:[...times].sort((a,b)=>a-b).map(t=>frame(c,S,t))};});
 const pose={};for(const st of STATES){const p=statePose(cell,st);pose[st]={t:p.t,si:cell.si,frame:p.idle||p.absent?null:frame(c,story(cell),p.t)};}
 result[c.name]={sc,pose};
}
JSON.stringify(result);
`;
const result = JSON.parse(
  vm.runInNewContext(source + dump, {}, { timeout: 10000 }),
);
const path = new URL(
  "../../crates/gui/src/components/MachineDiagram/__fixtures__/galleryParity.json",
  import.meta.url,
);
const existing = JSON.parse(fs.readFileSync(path, "utf8"));
fs.writeFileSync(path, JSON.stringify({ ...existing, ...result }) + "\n");
console.log(
  `Dumped ${Object.keys(result).length} reference parts; source SHA-256 ${createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex")}`,
);
