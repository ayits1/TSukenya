/* Pure isolated scenarios: no browser, network, database or shared sheet writes. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const portal=fs.readFileSync(path.join(root,'app/portal.js'),'utf8');
const erp=fs.readFileSync(path.join(root,'app/erp.js'),'utf8');
const h=require('./sync-harness.js');
const ctx={dialog:null,editing:null,S:{settings:{rounding:.5,defaultMarkup:30}},num:h.env.parseNum,C:{rounding:.5,defaultMarkup:30}};
vm.createContext(ctx);
vm.runInContext(portal.slice(portal.indexOf('  const defMarkup ='),portal.indexOf('  const marginOf ='))+'\n'+erp.match(/function retailPrice\(p\)\{[^\n]+/)[0],ctx);
for(const [p,want] of [
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:19.99},19.99],
 [{manualPrice:true,price:21.99,promotion:false,promotionPrice:19.99},21.99],
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:null},21.99],
 [{manualPrice:true,price:21.99,promotion:true,promotionPrice:25},21.99],
 [{regularPrice:21.99,manualPrice:true,price:21.99,promotion:true,promotionPrice:19.99},19.99],
 [{regularPrice:21.99,promotion:true,promotionPrice:'19.995'},21.99],
]){assert.equal(ctx.priceOf(p),want);assert.equal(ctx.retailPrice({...p,salePrice:want.toFixed(2)}),want.toFixed(2),'sale editor uses confirmed Decimal DTO');}
// The server has resolved the requested store before the DTO reaches the editor.
// Legacy matrix/context values cannot override that confirmed price in the browser.
const contextual={manualPrice:true,price:20,regularPrice:'20.00',promotion:true,promotionPrice:'9.00',salePrice:'15.00',storeSalePrices:{'2':'12.30','3':'13.40'}};
assert.equal(ctx.retailPrice(contextual),'15.00','network authoritative price');
ctx.dialog={querySelector:()=>({value:'2'})};
assert.equal(ctx.retailPrice(contextual),'15.00','browser context cannot override the confirmed DTO');
assert.equal(ctx.retailPrice({...contextual,salePrice:'12.30'}),'12.30','explicit selected-store DTO');
ctx.dialog=null;ctx.editing={store:3};
assert.equal(ctx.retailPrice({...contextual,salePrice:'13.40'}),'13.40','explicit saved-store DTO');
ctx.editing=null;
for(const salePrice of [undefined,null,12,'19.9','19.995','-1.00','=1+1','']){
 assert.throws(()=>ctx.retailPrice({cost:10,markup:30,regularPrice:'20.00',promotion:true,promotionPrice:'9.00',salePrice}),/не підтверджено/,'unconfirmed/malformed server price never falls back to a local formula');
}
// Money is counted in kopecks: no 0.30000000000000004 for roles that see cost, at every rounding step.
for(const rounding of [.01,.1,.5,1]){ctx.S.settings.rounding=ctx.C.rounding=rounding;const p={cost:0.1,markup:200};assert.equal(ctx.priceOf(p),rounding===1?1:rounding===.5?0.5:0.3);assert.equal(ctx.retailPrice({...p,salePrice:rounding===1?'1.00':rounding===.5?'0.50':'0.30'}),rounding===1?'1.00':rounding===.5?'0.50':'0.30');assert.equal(ctx.retailPrice({...p,regularPrice:0.3,salePrice:'0.30'}),'0.30');}
ctx.S.settings.rounding=ctx.C.rounding=.5;
assert.equal(ctx.priceOf({cost:12.34,markup:30}),16.5);assert.equal(ctx.priceOf({cost:'7,5',markup:'33.3333'}),10);assert.equal(ctx.priceOf({manualPrice:true,price:12.345}),12.35);
// Confirmed salePrice wins in ERP; legacy served-product regularPrice still protects portal drafts.
const servedProduct={cost:10,markup:100,regularPrice:15,salePrice:'15.00',promotion:true,promotionPrice:18};
assert.equal(ctx.retailPrice(servedProduct),'15.00');assert.equal(ctx.priceOf(servedProduct),18,'an edited draft still prices its own inputs');
ctx.served=servedProduct;vm.runInContext('served.add(globalThis.served)',ctx);assert.equal(ctx.priceOf(servedProduct),15);assert.equal(ctx.priceOf({...servedProduct,cost:5}),10);
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
console.log('Legacy promotion: portal effective-price/kopeck rounding preserved; ERP confirmed scoped Decimal prices/malformed rejection; sync migration, repeat, update, disable and invalid values passed.');
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
