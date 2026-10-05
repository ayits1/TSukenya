/* Actual standalone action confirmation, then the existing detail/list continuation. */
module.exports=async function completeVoucherAction(page){
 const form=page.locator('#tradeActionForm');await form.waitFor();
 await form.locator('[data-action-send]').press('Enter');
 await form.locator('[data-action-status]').filter({hasText:'Початкова дія підтверджена'}).waitFor();
 await form.locator('[data-action-done]').press('Enter');
};
