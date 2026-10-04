/* Shared focused proof: unavailable server bundles never activate the legacy editor. */
const assert=require('node:assert/strict');
module.exports=async function moduleCase(source,base){
 const page=await source.context().newPage(),requests=[];
 page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/api/'))requests.push(r.url());});
 try{
  await page.route('**/frontend/assets/**',r=>r.abort());
  for(const [route,title] of [['products','каталог'],['tags','студію цінників']]){
   await page.goto(base+'/#operations/'+route);
   await page.getByRole('heading',{name:'Не вдалося завантажити '+title,exact:true}).waitFor();
   assert.equal(await page.locator('#productForm,#newProd,#tagBuilder,[data-act=addProd]').count(),0);
   assert.equal(await page.getByText('Додайте товар або імпортуйте файл.',{exact:true}).count(),0);
  }
  assert.equal(requests.length,0,'Unavailable modules must not write');
  await page.unroute('**/frontend/assets/**');
  await page.getByRole('button',{name:'Повторити завантаження',exact:true}).focus();await page.keyboard.press('Enter');
  await page.locator('.tk-studio').waitFor();assert.equal(requests.length,0,'Retry only reloads GET resources');
  // Supported React boundary keeps both XSS and the opened revision coverage.
  const session=await(await source.request.get(base+'/api/v1/session')).json();
  const target=(await(await source.request.get(base+'/api/v1/catalog/products?limit=10')).json()).items[0];
  const hostile='"><img src=x onerror="window.__xss=1">';
  const patch=async(revision,values)=>{const r=await source.request.patch(base+'/api/v1/catalog/products/'+target.id,{headers:{Origin:base,'X-CSRF-Token':session.csrf},data:{revision,...values}});assert.equal(r.status(),200,await r.text());return r.json();};
  const edited=await patch(target.revision,{name:hostile});
  await page.goto(base+'/#operations/products');await page.getByRole('searchbox',{name:'Пошук товару'}).fill('onerror');
  await page.getByRole('button',{name:hostile,exact:true}).click();const form=page.getByRole('dialog',{name:'Редагувати товар'});
  assert.equal(await form.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.__xss),undefined);
  assert.equal(await form.getByRole('textbox',{name:'Назва товару'}).inputValue(),hostile);
  const current=await patch(edited.revision,{cost:'11.00'});
  await form.getByRole('textbox',{name:'Назва товару'}).fill('Чернетка зі старою версією');
  // Price-preview guards the opened revision before enabling save.
  await form.getByRole('button',{name:'Порівняти зміни',exact:true}).waitFor();
  assert(await form.getByRole('button',{name:'Зберегти товар',exact:true}).isDisabled());
  const stale=await source.request.patch(base+'/api/v1/catalog/products/'+target.id,{headers:{Origin:base,'X-CSRF-Token':session.csrf},data:{revision:edited.revision,name:'Чернетка зі старою версією'}});assert.equal(stale.status(),409);assert.equal((await stale.json()).code,'revision_conflict');
  const kept=await(await source.request.get(base+'/api/v1/catalog/products/'+target.id)).json();
  assert.equal(kept.name,hostile);assert.equal(kept.cost,current.cost);
  await patch(current.revision,{name:target.name,cost:target.cost});
  console.log('PASS unavailable catalogue/labels: explicit error/no fake empty editor/GET-only keyboard retry; React escaped stored text/opened revision conflict preserves remote edit.');
 }finally{await page.close();}
};
