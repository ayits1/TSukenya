/* Shared serialization contract; all data is synthetic. */
const assert = require('node:assert/strict');
const csv = require('../app/csv.js');
const {parseRows} = require('../app/catalog-import.js');
const text = ['=1+1', '+SUM(A1:A2)', '@name', '-товар', '  =1+1', '\t=1', '\r=1', '\n=1', '\u200b=1', '＝1', '＋1', '－1', '＠1', "'Назва", '\tЗвичайна назва', 'Лапки " ; кома ,\nдругий рядок', 'Звичайний товар'];
const columns = [{label:'Назва',kind:'text'},{label:'Сума, грн',kind:'number'}];
const exact = '-99999999999999999999.1234';
for (const delimiter of [';',',']) {
 const exported=csv.serialize(columns,text.map(name=>[name,exact]),{delimiter,reversible:true});
 const parsed=csv.parse(exported);
 assert.deepEqual(parsed[0],['Назва','Сума, грн']);
 assert.deepEqual(parsed.slice(1),text.map(name=>[name,exact]));
 assert(exported.includes('"\t=1+1"'),'text guarded');assert(exported.includes('"'+exact+'"'),'negative numeric not escaped');
 assert.equal(csv.serialize(columns,[['Товар','1 234,50']],{delimiter,bom:false}).split('\r\n')[1],['"Товар"','"1234.50"'].join(delimiter));
}
for (const value of ['NaN','Infinity','1 2','1.2.3','=1','1e3',true]) assert.throws(()=>csv.serialize(columns,[['Товар',value]]),/числ/);
assert.deepEqual(csv.parse('"Склад, область, місто, район";"ID"\r\n"Київ";"A"'),[['Склад, область, місто, район','ID'],['Київ','A']]);
assert.deepEqual(csv.parse('"Назва";"Сума"\r\n"\t=1";"-2.50"'),[['Назва','Сума'],['\t=1','-2.50']],'external files not unescaped');
assert.throws(()=>csv.parse('"Назва [TSukenya CSV 2]";"Сума"'),/не підтримується/);
for (const malformed of ['"Назва";"Сума"\r\n"Кава;10','"Назва"x;"Сума"','На"зва;Сума']) assert.throws(()=>csv.parse(malformed),/лап/);
const xlsxRows=[['Назва [TSukenya CSV 1]','Закупівля'],['\t=1+1',12.50]];
assert.deepEqual(csv.decode(xlsxRows),[['Назва','Закупівля'],['=1+1',12.50]],'Excel numeric cells preserved');
const parsed=parseRows(xlsxRows,'synthetic.xlsx');assert.equal(parsed.rows[0].values.name,'=1+1');assert.equal(parsed.rows[0].values.cost,'12.5');
const native=csv.serialize([{label:'Назва',kind:'text'},{label:'Закупівля',kind:'number'}],[["'Чесна назва",'12.00'],['=1+1','2.99']],{reversible:true});
assert.deepEqual(parseRows(csv.parse(native),'synthetic.csv').rows.map(r=>r.values.name),["'Чесна назва",'=1+1']);
console.log('PASS: text escaping/reversible Unicode/quotes/newlines, exact negative numbers, malformed numbers/CSV/versions, external preservation and catalogue CSV/XLSX import.');
const fs=require('node:fs'),vm=require('node:vm');
const portal=fs.readFileSync(require('node:path').join(__dirname,'../app/portal.js'),'utf8');
const ctx={CatalogSchema:require('../app/catalog-schema.js'),window:{TSukenyaCsv:csv},priceOf:p=>p.promotionPrice||p.price,regularPriceOf:p=>p.price,hasDiscount:p=>!!p.promotionPrice,money:n=>Number(n).toLocaleString('uk-UA',{minimumFractionDigits:2,maximumFractionDigits:2}),num:Number,dec:n=>String(n),typeOf:p=>p.type,NOTYPE:'none',defMarkup:()=>30};vm.createContext(ctx);
vm.runInContext(portal.match(/  const per100 = [^\n]+/)[0].replace('const ','var ')+'\n'+portal.slice(portal.indexOf('  function csv(list)'),portal.indexOf('  async function save(filename'))+portal.slice(portal.indexOf('  function baseCsv(list)'),portal.indexOf('  const timeText =')),ctx);
const product={name:'=1+1',category:'+SUM(A1:A2)',unit:'шт',type:'-Група',cost:12.34,manualPrice:true,price:34.50,promotionPrice:21.99,promotion:true};
const legacy=ctx.csv([product]),nativeBase=ctx.baseCsv([product]);assert(legacy.includes('"\t=1+1"'));assert.deepEqual(csv.parse(legacy)[1],['=1+1','+SUM(A1:A2)','шт','34.50','21.99','21.99','','Так']);assert(nativeBase.includes('"\t-Група"'));assert.deepEqual(csv.parse(nativeBase)[1].slice(6),['12.34','','34.5','21.99','Так','21.99']);
// Price per 100 g is whole kopecks, half-up: 12,35 грн/кг → 1,24 (float division printed 1,23).
const weighed={name:'Цукерки',category:'',unit:'кг',type:'',manualPrice:true,price:12.35};assert.equal(csv.parse(ctx.csv([weighed]))[1][6],'1.24');assert.equal(csv.parse(ctx.baseCsv([weighed]))[1][9],'12.35');
for(const [kg,want] of [[12.35,1.24],[12.34,1.23],[0.05,0.01],[0.04,0],[189,18.9],[99.95,10]])assert.equal(ctx.per100(kg),want,String(kg));
console.log('PASS: actual legacy labels/native base export functions share text/numeric schema, preserve promotion fields and round price per 100 g half-up in kopecks (no connector writes).');
