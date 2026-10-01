/* Pure isolated scenarios: no browser, network, database or shared sheet writes. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const portal=fs.readFileSync(path.join(root,'app/portal.js'),'utf8');
const erp=fs.readFileSync(path.join(root,'app/erp.js'),'utf8');
const h=require('./sync-harness.js');
const ctx={S:{settings:{rounding:.5,defaultMarkup:30}},num:h.env.parseNum,C:{rounding:.5,defaultMarkup:30}};
vm.createContext(ctx);
vm.runInContext(portal.slice(portal.indexOf('  const defMarkup ='),portal.indexOf('  const marginOf ='))+'\n'+erp.match(/function retailPrice\(p\)\{[^\n]+/)[0],ctx);
for(const [p,want] of [
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:19.99},19.99],
 [{manualPrice:true,price:21.99,promotion:false,promotionPrice:19.99},21.99],
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:null},21.99],
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:25},21.99],
 [{cost:10,markup:100,regularPrice:15,promotion:true,promotionPrice:18},18],
 [{regularPrice:21.99,manualPrice:true,price:21.99,promotion:true,promotionPrice:19.99},19.99],
]){assert.equal(ctx.priceOf(p),want);assert.equal(ctx.retailPrice(p),want);}
const p={id:'p',name:'Товар',cost:10,markup:100,manualPrice:true,price:20,unit:'шт',promotion:true,promotionPrice:18,gsBase:{name:'Товар',type:'',category:'',pack:'',size:'',unit:'шт',cost:'10',markup:'100',price:'20'}};
const old=[['Назва','Закупівля, грн','Націнка, %','Ціна продажу, грн','ID'],['Товар',10,100,20,'p']];
const env={...h.env,priceOf:ctx.priceOf};
const migrate=h.planSync(old,[p],env);assert(!migrate.error);assert(migrate.header.includes('Акційна ціна, грн'));
const write=migrate.rowWrites[0].values,head=migrate.header;
assert.equal(write[head.indexOf('Акція')],'Так');assert.equal(write[head.indexOf('Акційна ціна, грн')],18);assert.equal(write[head.indexOf('Ціна на цінник, грн')],18);
assert.equal(migrate.dbUpdates[0].patch.gsBase.price,'20');
const p2={...p,...migrate.dbUpdates[0].patch},sheet=[head,write.map(x=>typeof x==="string"?x.replace(/^'/,""):x)];
const stable=h.planSync(sheet,[p2],env);assert(!stable.error);assert.equal(stable.dbUpdates.length+stable.rowWrites.length,0);
const discounted=structuredClone(sheet);discounted[1][head.indexOf('Акційна ціна, грн')]=17.5;
const update=h.planSync(discounted,[p2],env);assert(!update.error);assert.equal(update.dbUpdates[0].patch.promotionPrice,17.5);assert.equal(update.dbUpdates[0].patch.price,20);
const inactive=structuredClone(sheet);inactive[1][head.indexOf('Акція')]='Ні';const disable=h.planSync(inactive,[p2],env);assert.equal(disable.dbUpdates[0].patch.promotion,false);assert.equal(disable.dbUpdates[0].patch.promotionPrice,18);
const invalid=structuredClone(sheet);invalid[1][head.indexOf('Акційна ціна, грн')]=22;assert.match(h.planSync(invalid,[p2],env).error,/нижчою/);
invalid[1][head.indexOf('Акційна ціна, грн')]='oops';assert.match(h.planSync(invalid,[p2],env).error,/Некоректна/);
console.log('Legacy promotion: 6 effective-price cases × portal/ERP; sync migration, repeat, update, disable, invalid discount and invalid amount passed.');
Object.assign(ctx,{norm:env.norm,parseNum:env.parseNum,unitNorm:env.unitNorm,packNorm:env.packNorm,typeNorm:v=>v||'',packFromName:()=>'',sizeFromName:()=>'',today:()=>env.today});
ctx.S.products=[p];
vm.runInContext(portal.slice(portal.indexOf('  function parseSheet('),portal.indexOf('  function importInner(')),ctx);
const parsed=ctx.parseSheet([['Назва','Звичайна ціна, грн','Акційна ціна, грн','Діюча ціна, грн','Акція'],['Товар','20,00','18,00','18,00','Так']],'synthetic.csv');
assert.equal(parsed.rows[0].price,20);assert.equal(parsed.rows[0].promotionPrice,18);assert.equal(parsed.hasGeneric,false);
const imported=ctx.buildPlan(parsed);assert.equal(imported.items[0].data.price,20);assert.equal(imported.items[0].data.promotionPrice,18);
const omitted=ctx.buildPlan(ctx.parseSheet([['Назва','Ціна продажу, грн'],['Товар',22]],'synthetic.csv'));
assert.equal(Object.hasOwn(omitted.items[0].data,'promotionPrice'),false);
assert.equal(Object.hasOwn(omitted.items[0].data,'promotion'),false);
assert.match(ctx.parseSheet([['Назва','Звичайна ціна, грн','Акційна ціна, грн'],['Товар',20,'abc']],'synthetic.csv').error,/Некоректна/);
console.log('Legacy import: regular/discount/effective columns kept separate; omitted promotion preserved; malformed amount rejected.');

ctx.priceState=p=>ctx.priceOf(p)>0?'ok':'none';
vm.runInContext(portal.slice(portal.indexOf('  function printIssues('),portal.indexOf('  function clippedTag(')),ctx);
assert.equal(ctx.printIssues([{name:'Badge only',manualPrice:true,price:20,promotion:true}]).incompletePromotion[0],'Badge only');
assert.equal(ctx.printIssues([p]).incompletePromotion.length,0);
console.log('Legacy label output distinguishes an actual discount from an incomplete promotion.');
