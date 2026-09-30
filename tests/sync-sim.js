const fs=require('fs'); const assert=require('node:assert/strict'); const {env, planSync}=require('./sync-harness.js');
const disp = v => v===null||v===undefined ? undefined : typeof v==="number" ? String(v).replace(".",",") : String(v).replace(/^'/,"");
function apply(sheet, prods, plan){
  if (plan.header) sheet[0]=plan.header.slice();
  for (const w of plan.rowWrites){ const r=sheet[w.row-1]||[]; w.values.forEach((v,i)=>{ const d=disp(v); if (d!==undefined) r[i]=d; }); sheet[w.row-1]=r; }
  for (const a of plan.appends) sheet.push(a.map(v=>disp(v)??""));
  for (const c of plan.clears) sheet[c-1]=[];
  for (const u of plan.dbUpdates){ const p=prods.find(x=>x.id===u.id); Object.assign(p, JSON.parse(JSON.stringify(u.patch))); }
  for (const a of plan.dbAdds) prods.push(Object.assign({id:a.id}, JSON.parse(JSON.stringify(a.data))));
}
const sum = p => `writes=${p.rowWrites.length} app=${p.appends.length} clr=${p.clears.length} dbUpd=${p.dbUpdates.length} adds=${p.dbAdds.length} changed=${p.changed} pushed=${p.pushed}`;
let sheet=JSON.parse(fs.readFileSync(__dirname+'/fixtures/sheet.json')), prods=JSON.parse(fs.readFileSync(__dirname+'/fixtures/products.json'));
const run=(label)=>{ const p=planSync(sheet, prods, env); console.log(label.padEnd(34), sum(p)); apply(sheet, prods, p); return p; };
run('1 перша синхронізація');
let steady=run('2 повтор (має бути 0)');
assert.equal(steady.rowWrites.length+steady.appends.length+steady.clears.length+steady.dbUpdates.length+steady.dbAdds.length,0,'повторна синхронізація не має записів');
// A: зміна в таблиці
let r=sheet.findIndex(x=>x[0]==='Coca-Cola 0,5 л'); sheet[r][6]='25'; sheet[r][8]='';
run('3 таблиця: закупівля Coca 0,5=25');
let p=prods.find(x=>x.name==='Coca-Cola 0,5 л'); console.log('   app:', p.cost, p.manualPrice, p.price, 'на цінник', env.priceOf(p), 'sheet L=', sheet[r][11]);
run('4 повтор');
// B: зміна в застосунку
p=prods.find(x=>x.id==='w01'); Object.assign(p,{cost:10, priceAt:'2026-09-30'});
let q=run('5 app: закупівля w01=10'); r=sheet.findIndex(x=>x[12]==='w01'); console.log('   sheet row:', JSON.stringify(sheet[r]));
run('6 повтор');
// C: конфлікт — обидва змінили ціну Джміль
r=sheet.findIndex(x=>x[0]==='Джміль'); sheet[r][8]='95'; p=prods.find(x=>x.name==='Джміль'); p.price=99;
run('7 конфлікт ціни Джміль'); console.log('   app price:', p.price, 'sheet:', sheet[r][8]);
// D: новий рядок у таблиці
sheet.push(['Халва соняшникова 250 г','Цукерки','Халва','Упаковка','250 г','шт','40','35']);
run('8 новий рядок у таблиці'); p=prods.find(x=>x.name.startsWith('Халва')); console.log('   new:', p.id, env.priceOf(p), 'sheet id:', sheet[sheet.length-1][12], 'L', sheet[sheet.length-1][11]);
run('9 повтор');
// E: видалення рядка в таблиці
r=sheet.findIndex(x=>x[0]==='Fanta 1 л'); sheet.splice(r,1);
run('10 рядок Fanta 1 л видалено'); console.log('   hidden:', prods.find(x=>x.name==='Fanta 1 л').hidden);
// F: видалення в застосунку
prods=prods.filter(x=>x.name!=='Sprite 1 л');
run('11 Sprite 1 л видалено в app'); console.log('   rows with Sprite 1 л:', sheet.filter(x=>x[0]==='Sprite 1 л').length);
// G: перейменування в таблиці
r=sheet.findIndex(x=>x[0]==='Допіо'); sheet[r][0]='Допіо (подвійне еспресо)';
run('12 перейменування в таблиці'); console.log('   app names Допіо*:', prods.filter(x=>x.name.startsWith('Допіо')).map(x=>x.name));
run('13 повтор');
// H: очищена націнка
r=sheet.findIndex(x=>x[0]==='Coca-Cola 0,5 л'); sheet[r][7]='';
run('14 очищена націнка'); run('15 повтор');

const duplicateIdSheet=[['Назва','Закупівля, грн','Націнка, %','ID'],['Товар','10','30','same-id'],['Товар','10','30','same-id']];
const duplicatePlan=planSync(duplicateIdSheet,[{id:'same-id',name:'Товар',cost:10,markup:30,unit:'шт'}],env);
assert.match(duplicatePlan.error,/повторюється/,'повторний ID має зупиняти синхронізацію');
console.log('16 повторний ID: синхронізацію зупинено');
