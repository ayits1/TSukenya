/* Strict read-only settlement projections. Decimal arithmetic stays on Django. */
(()=>{'use strict';
 const fail=()=>{const e=Error('Сервер повернув некоректну звірку. Повторіть читання.');e.status=200;e.code='protocol';throw e;};
 const check=v=>{if(!v)fail();},obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:fail();
 const keys=(v,list)=>check(Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k)));
 const int=(v,min=0)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
 const text=v=>typeof v==='string',cash=v=>text(v)&&v.length<=40&&/^-?\d+\.\d{2}$/.test(v);
 const date=v=>text(v)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 function decodeStatement(raw,expected,policy){
  const v=obj(raw);keys(v,['items','total','page','pages','party','party_name','direction','from','to','basis','opening_balance','closing_balance','debit','credit','debt_total','advance_total','age','reconciliation','contract','policy','query']);
  check(v.contract==='trading-settlement-statement-v1'&&v.basis==='accounting_dates'&&v.party===Number(expected.party)&&text(v.party_name)&&typeof v.direction==='string'&&['customer','supplier'].includes(v.direction)&&v.from===expected.from&&v.to===expected.to&&date(v.from)&&date(v.to));
  const p=obj(v.policy);keys(p,['role','store']);check(typeof p.role==='string'&&['owner','manager','accountant'].includes(p.role)&&(p.store===null||int(p.store,1)));
  if(p.role!==policy.role||p.store!==policy.store){const e=Error('Права доступу змінилися. Оновіть розділ.');e.status=403;throw e;}
  const q=obj(v.query);keys(q,['party','store','from','to']);check(q.party===v.party&&q.store===(expected.store?Number(expected.store):null)&&q.from===v.from&&q.to===v.to);
  for(const k of ['opening_balance','closing_balance','debit','credit','debt_total','advance_total'])check(cash(v[k]));
  const age=obj(v.age);keys(age,['no_due','not_due','1_30','31_60','61_90','over_90']);Object.values(age).forEach(x=>check(cash(x)));
  const r=obj(v.reconciliation);keys(r,['net_documents_and_advances','matches']);check(cash(r.net_documents_and_advances)&&typeof r.matches==='boolean');
  check(int(v.total)&&int(v.page,1)&&int(v.pages,1)&&v.pages===Math.max(1,Math.ceil(v.total/30))&&v.page<=v.pages&&Array.isArray(v.items)&&v.items.length===Math.min(30,Math.max(0,v.total-(v.page-1)*30)));
  const seen=new Set();for(const x of v.items){const item=obj(x);keys(item,['voucher','number','kind','date','store','amount','reversal','balance']);check(int(item.voucher,1)&&item.number===String(item.voucher).padStart(6,'0')&&typeof item.kind==='string'&&['sale','receipt','debt_opening','payment','advance_allocation','payment_refund','customer_return','supplier_return'].includes(item.kind)&&date(item.date)&&item.date>=v.from&&item.date<=v.to&&int(item.store,1)&&(p.store===null||item.store===p.store)&&(q.store===null||item.store===q.store)&&cash(item.amount)&&cash(item.balance)&&typeof item.reversal==='boolean');const id=item.voucher+':'+item.reversal;check(!seen.has(id));seen.add(id);}
  return v;
 }
 function decodeSummary(raw){
  const v=obj(raw);keys(v,['today','days','overdue','payments','payments_count','payments_total']);check(date(v.today)&&v.days===14&&int(v.payments_count)&&cash(v.payments_total)&&Array.isArray(v.payments)&&v.payments.length===Math.min(5,v.payments_count));
  const o=obj(v.overdue);keys(o,['to_us','by_us']);for(const side of Object.values(o)){keys(obj(side),['amount','count']);check(cash(side.amount)&&int(side.count));}
  const seen=new Set();for(const x of v.payments){keys(obj(x),['voucher','number','store','party','due_date','amount']);check(int(x.voucher,1)&&x.number===String(x.voucher).padStart(6,'0')&&int(x.store,1)&&text(x.party)&&date(x.due_date)&&cash(x.amount)&&!seen.has(x.voucher));seen.add(x.voucher);}
  return v;
 }
 window.SettlementReads={decodeStatement,decodeSummary};
})();
