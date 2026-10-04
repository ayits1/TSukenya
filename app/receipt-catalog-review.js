/* Receipt detail ingress only. Form, requests, comparison and recovery live in React. */
(function(){
'use strict';
window.TradeReceiptPricing={open(id,modal){
 if(!window.ReactReceiptPricing){throw Error('Модуль перегляду цін ще не завантажено. Оновіть сторінку та спробуйте знову.');}
 const dialog=modal('Перегляд цін із накладної','<div data-receipt-pricing-host></div>');
 const leave=window.ReactReceiptPricing.mount(dialog.querySelector('[data-receipt-pricing-host]'),{
  id:Number(id),
  onState(dirty,busy){dialog.dataset.dirty=dirty?'1':'';dialog.dataset.busy=busy?'1':'';},
  onClose(){if(dialog.dataset.busy==='1')return;if(dialog.dataset.dirty==='1'&&!confirm('Закрити перегляд без збереження новіших полів?'))return;dialog.dataset.dirty='';dialog.close();},
  onOpenLabels(key){if(dialog.dataset.busy==='1')return;if(dialog.dataset.dirty==='1'&&!confirm('Перейти до Studio? Новіші незбережені поля перегляду буде закрито.'))return;if(!window.CatalogPriceWorkflow)throw Error('Studio ще не завантажено.');dialog.dataset.dirty='';dialog.close();window.CatalogPriceWorkflow.open('import',key);},
 });
 dialog.addEventListener('close',leave,{once:true});
}};
})();
