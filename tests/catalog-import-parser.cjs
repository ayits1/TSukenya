/* File decoding only; no customer data or server calls. */
const assert = require('node:assert/strict');
const {parseRows,decimal} = require('../app/catalog-import.js');
const parse = rows => parseRows(rows,'synthetic.csv');
let result = parse([['Назва','Закупівля','Звичайна ціна','Акційна ціна','Акція','Категорія'],['Кава','0','20,00','18,00','Так',''],['Разом подарунок',10,'','','','']]);
assert.equal(result.rows.length,2);
assert.deepEqual(result.rows[0].values,{name:'Кава',cost:'0',price:'20.00',manualPrice:true,promotionPrice:'18.00',promotion:true});
assert.equal(Object.hasOwn(result.rows[1].values,'price'),false);
assert.equal(Object.hasOwn(result.rows[1].values,'promotion'),false);
assert.equal(result.rows[1].line,3);
for (const bad of ['abc','12oops','-1','1.234','1e3','Infinity']) {
  result = parse([['Назва','Закупівля'],['Товар',bad]]); assert.equal(result.rows[0].errors.length,1,bad);
}
result = parse([['Назва','Націнка','Одиниця','ID'],['Товар',0.35,'пляшка',"'abc"],['Інший','0.1234%','кг','']]);
assert.equal(result.rows[0].values.markup,'35'); assert.equal(result.rows[0].values.unit,'пляшка');assert.equal(result.rows[0].id,'abc');
assert.equal(result.rows[1].values.markup,'0.1234');assert.equal(decimal('0.5','Націнка',4),'0.5');
// Excel percent cells (0.07 = 7 %) move the decimal point exactly; float ×100 gave 7.000000000000001 and rejected the row.
for (const [cell,want] of [[0.07,'7'],['0,07','7'],[0.29,'29'],['0,29','29'],[0.075,'7.5'],['0.123456','12.3456'],['0.0001','0.01'],[0.57,'57'],['0.10','10']]) {
  assert.equal(decimal(cell,'Націнка',4,true),want,String(cell));
  const row = parse([['Назва','Націнка'],['Товар',cell]]).rows[0]; assert.deepEqual(row.errors,[],String(cell)); assert.equal(row.values.markup,want);
}
assert.throws(()=>decimal('0.0000001','Націнка',4,true),/максимум 4/);
assert(parse([['Назва','Акція'],['Товар','можливо']]).rows[0].errors.length);
assert(parse([['Назва','Закупівля'],['',10]]).rows[0].errors.length);
assert.equal(parse([['Назва','Закупівля'],['Разом',10],['Товар',10]]).rows.length,1);
assert.match(parse([['Назва','Закупівля'],...Array.from({length:1001},(_,i)=>['Товар '+i,10])]).error,/1000/);
assert.equal(parse([['Назва','Закупівля'],...Array.from({length:1000},(_,i)=>['Товар '+i,10])]).rows.length,1000);
console.log('PASS: import column presence, explicit zero, strict numbers/booleans, percentage compatibility incl. exact Excel percents, precise lines/ID, custom units, blank names, summary names, 1000-row boundary.');
