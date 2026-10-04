/* Route-level controls across the React migration boundary; never dispatch native actions. */
const labels={purchase_order:'Замовлення постачальнику',receipt:'Надходження',supplier_return:'Повернення постачальнику',opening:'Початкові залишки',transfer:'Переміщення',writeoff:'Списання',inventory:'Інвентаризація',production:'Виробництво',sale:'Продаж',customer_return:'Повернення покупця',customer_order:'Замовлення покупця'};
function documentButton(page,id){
 const key=String(id);if(!/^\d+$/.test(key))throw Error('Expected a document ID');
 return page.locator(`#main [data-document-id="${key}"], #main [data-trade=view][data-id="${key}"], #main button[aria-label$="№ ${key.padStart(6,'0')}"]`);
}
function newDocumentButton(page,kind){
 const native=page.locator(`#main [data-trade=new-voucher][data-kind="${kind}"]`);
 return labels[kind]?native.or(page.getByRole('button',{name:'+ '+labels[kind],exact:true})):native;
}
async function waitForTradingRoute(page,tab){
 if(tab==='sales'){await page.locator('[data-react-sales]').waitFor();await page.waitForFunction(()=>{const host=document.querySelector('[data-react-sales]');return host&&host.querySelector('.sales-create button:not(:disabled)')&&![...host.querySelectorAll('[role=status]')].some(el=>el.textContent.includes('Завантаження продажів'));});return;}
 if(tab!=='purchases'){await page.locator('#main .panel').first().waitFor();return;}
 await page.locator('[data-react-purchases]').waitFor();
 await page.waitForFunction(()=>{const host=document.querySelector('[data-react-purchases]');return host&&host.querySelector('.purchases-create button:not(:disabled)')&&![...host.querySelectorAll('[role=status]')].some(el=>el.textContent.includes('Завантаження закупівель'));});
}
module.exports={documentButton,newDocumentButton,waitForTradingRoute};
