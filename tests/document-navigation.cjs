/* Actual bounded document view. Editor/source/recovery reads keep their own DTOs. */
const headerPath=id=>'/api/v1/trading/documents/'+id;
async function ready(page){
 const dialog=page.locator('dialog.trade-dialog[open]');
 await dialog.locator('[data-document-details][aria-busy=false]').waitFor();
 await dialog.locator('[data-document-page-status]').waitFor();
 return dialog;
}
async function section(page,title){
 const dialog=await ready(page);
 await dialog.getByRole('tab',{name:new RegExp('^'+title+' ·')}).press('Enter');
 return ready(page);
}
module.exports={headerPath,ready,section};
