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
module.exports={documentButton,newDocumentButton};
