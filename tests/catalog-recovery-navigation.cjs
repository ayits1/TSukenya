/* Explicit fresh access and comparison; never bypasses a privacy gate or sends a mutation. */
const assert=require('node:assert/strict');
exports.access=async(page)=>{const d=page.getByRole('dialog'),access=d.getByRole('button',{name:'Перевірити доступ до чернетки',exact:true});if(await access.isVisible())await access.click();await d.locator('.tk-editor-grid,.tk-reference-grid').first().waitFor();return d;};
exports.compare=async(page)=>{const d=await exports.access(page);const button=d.getByRole('button',{name:'Порівняти актуальні зміни',exact:true});await button.click();};
exports.raw=async(page)=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tsukenya:draft:v1:catalog_')).map(k=>JSON.parse(sessionStorage.getItem(k)).payload));
exports.confirmedCurrent=async(page)=>{const d=await exports.access(page);await d.getByRole('button',{name:'Прочитати підтверджений запис',exact:true}).click();};
exports.assertHidden=async(page)=>{const d=page.getByRole('dialog');await d.getByRole('button',{name:'Перевірити доступ до чернетки',exact:true}).waitFor();assert.equal(await d.getByRole('textbox').count(),0);};
