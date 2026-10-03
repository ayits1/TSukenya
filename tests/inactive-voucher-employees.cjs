/* Actual voucher choice helper: keep historical selection, restrict new ones. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app/erp.js'),'utf8');
const helper=source.split('\n').find(line=>line.startsWith('function voucherEmployees('));
const employees=[{id:1,store_id:10,active:false,name:'Старий касир'},{id:2,store_id:10,active:true,name:'Новий касир'},{id:3,store_id:10,active:false,name:'Інший неактивний'},{id:4,store_id:20,active:false,name:'Інший магазин'}];
const choose=(store,selected,kind)=>JSON.parse(JSON.stringify(vm.runInNewContext(helper+';voucherEmployees(store,selected,kind)',{E:{employees},store,selected,kind})));
assert.deepEqual(choose(10,'1','sale').map(e=>e.id),[1,2],'selected inactive draft employee is preserved');
assert.equal(choose(10,'1','sale')[0].name,'Старий касир (неактивний)','inactive selection is explained');
assert.deepEqual(choose(10,'','sale').map(e=>e.id),[2],'new sale offers active employees only');
assert.deepEqual(choose(10,'2','sale').map(e=>e.id),[2],'explicit replacement does not restore old inactive employee');
assert.deepEqual(choose(20,'1','sale'),[],'store change cannot keep a foreign employee');
assert.deepEqual(choose(10,'1','payroll').map(e=>e.id),[1,2,3],'worked payroll remains payable to inactive employees');
assert.equal(employees[0].name,'Старий касир','labels never mutate source entities');
assert(source.includes("select('employee',voucherEmployees(v.store,v.employee,kind),v.employee"));
assert(source.includes('option(voucherEmployees(st,form.elements.employee.value,editing.kind),form.elements.employee.value)'));
console.log('INACTIVE VOUCHER EMPLOYEES PASS: draft preservation, explicit replacement, store scope and worked payroll');
