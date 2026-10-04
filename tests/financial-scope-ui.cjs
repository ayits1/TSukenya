/* Isolated renderer proof: the audit affordance requires authoritative permission. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const line=fs.readFileSync('app/erp.js','utf8').split('\n').find(x=>x.startsWith('function setupView()'));
assert.ok(line,'Current production setup renderer');
const ctx={E:{role:'owner',stores:[],warehouses:[],accounts:[],parties:[]},
  alert:x=>x,esc:x=>String(x),button:(text,action)=>`<button data-action="${action}">${text}</button>`,
  table:()=>'',name:()=>''};vm.createContext(ctx);vm.runInContext(line,ctx);
for(const permission of [false,undefined,null]){ctx.E.canViewAudit=permission;assert.ok(!ctx.setupView().includes('data-action="audit"'));}
ctx.E.canViewAudit=true;assert.ok(ctx.setupView().includes('data-action="audit"'));
assert.ok(ctx.setupView().includes('data-action="discount-limit"'),'Shared owner pricing remains');
console.log('PASS: scoped audit affordance absent; network audit and shared pricing retained');
