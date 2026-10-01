/* Layout regression: scrolling group headers and select indicators, isolated data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-layout-'));
const port=process.env.QA_BROWSER==='webkit'?18204:18203,python=process.env.PYTHON_BIN||'python3',base='http://localhost:'+port,password='layout-test-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("layout-test-password"))'],{cwd:root,encoding:'utf8'}).trim();
const server=spawn(python,['-m','server.main'],{cwd:root,env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash},stdio:'ignore'});
let browser,zoomContext,zoomProfile;
async function checkSelects(page){
 const controls=await page.locator('select:visible:not([multiple]):not([size])').evaluateAll(nodes=>nodes.map(el=>{const s=getComputedStyle(el);return{id:el.id||el.name,appearance:s.appearance,image:s.backgroundImage,position:s.backgroundPosition,padding:parseFloat(s.paddingRight),width:el.getBoundingClientRect().width};}));
 assert(controls.length,'visible selects');
 for(const c of controls){assert.equal(c.appearance,'none',c.id);assert.match(c.image,/svg/,c.id);assert.match(c.position,/12px.*50%/,c.id);assert(c.padding>=40&&c.width>54,c.id+' indicator space');}
}
(async()=>{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=process.env.QA_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('[name=username]').fill('tester');await page.locator('[name=password]').fill(password);await page.locator('[type=submit]').click();await page.waitForSelector('#main .stats');
 for(const theme of (process.env.QA_ZOOM_ONLY?[]:['light','dark']))for(const width of [1440,768,390,320]){
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
  await page.goto(base+'/#operations/tags');await page.waitForSelector('.pick-group');await checkSelects(page);
  assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(245, 246, 247)','single light theme');
  if(width<=390){
   assert(await page.locator('#activeField').isVisible());assert(!(await page.locator('.field-list').isVisible()));
   await page.locator('#activeField').selectOption('name');assert.equal(await page.locator('#fieldInspector h3').innerText(),'Назва товару');
   await page.locator('#navToggle').click();assert(await page.locator('#portalSidebar').isVisible());await page.keyboard.press('Escape');assert(!(await page.locator('#portalSidebar').isVisible()));assert(await page.locator('#navToggle').evaluate(el=>el===document.activeElement));
  }
  const combo=page.locator('#previewProduct');await combo.click();assert.equal(await combo.getAttribute('aria-expanded'),'true');
  const box=await page.locator('.ui-combo-popup').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=1001,'combobox viewport bounds: '+JSON.stringify(box));
  if(theme==='light'&&(width===1440||width===390))await page.locator('.builder-stage').screenshot({path:path.join(os.tmpdir(),'tsukenya-combo-'+width+'.png')});
  assert(await page.locator('.ui-combo-toggle').evaluate(el=>{const b=el.getBoundingClientRect(),i=el.parentElement.querySelector('input').getBoundingClientRect();return Math.abs(b.right-i.right)<=2&&Math.abs((b.y+b.height/2)-(i.y+i.height/2))<=1;}),'combobox indicator alignment');
  await combo.fill('Американо');await combo.press('Enter');assert.equal(await page.locator('#individualPreview [data-field=name]').innerText(),'Американо');
  await page.locator('.pick').scrollIntoViewIfNeeded();
  // Hit testing catches rows painting over the pinned header, including the old top gap.
  const result=await page.locator('.pick').evaluate(async pick=>{
   const group=[...pick.querySelectorAll('.pick-group')].find(g=>g.getBoundingClientRect().height>120),header=group.querySelector('.pick-grp');
   pick.scrollTop=0;pick.scrollTop=group.getBoundingClientRect().top-pick.getBoundingClientRect().top+12;
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const p=pick.getBoundingClientRect(),h=header.getBoundingClientRect();
   const covered=[p.left+3,(p.left+p.right)/2,p.right-20].every(x=>[p.top+2,h.top+h.height/2].every(y=>document.elementFromPoint(x,y)?.closest('.pick-grp')===header));
   return{covered,top:h.top,expected:p.top+pick.clientTop,bottom:h.bottom,groupBottom:group.getBoundingClientRect().bottom};
  });
  assert(result.covered,`${theme}/${width}: row visible over header`);assert(Math.abs(result.top-result.expected)<1,JSON.stringify(result));assert(result.bottom<=result.groupBottom+1,'header outside its group');
  if(width===1440||width===390)await page.locator('.pick').screenshot({path:path.join(os.tmpdir(),`tsukenya-pick-${theme}-${width}.png`)});
  // A heading must leave with its category instead of staying under later categories.
  const bounded=await page.locator('.pick').evaluate(async pick=>{pick.scrollTop=200;await new Promise(r=>requestAnimationFrame(r));return[...pick.querySelectorAll('.pick-group')].every(g=>g.querySelector('.pick-grp').getBoundingClientRect().bottom<=g.getBoundingClientRect().bottom+1);});assert(bounded,'category heading boundary');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow');
  await page.goto(base+'/#operations/products');await page.waitForSelector('.catalog-pagination');await checkSelects(page);
  await page.locator('[data-act=newProduct]').click();await checkSelects(page);await page.locator('[data-act=closeProduct]').first().click();
  await page.goto(base+'/#trade/sales');await page.locator('[data-trade=new-voucher][data-kind=sale]').waitFor();await page.locator('[data-trade=new-voucher][data-kind=sale]').click();await page.locator('#tradeVoucherForm').waitFor();await checkSelects(page);
  if(width===1440)await page.locator('.trade-dialog').screenshot({path:path.join(os.tmpdir(),`tsukenya-selects-${theme}.png`)});
 }
 // A delayed CRM response must never overwrite the next workspace.
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/#trade/setup');await page.locator('[data-trade=users]').waitFor();
 await page.route('**/api/erp/state',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
 const delayed=page.waitForResponse(r=>r.url().endsWith('/api/erp/state'));
 await page.goto(base+'/#trade/sales');await page.locator('#main [role=status]').waitFor();
 await page.goto(base+'/#operations/tags');await page.locator('#tagBuilder').waitFor();await delayed;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 assert(await page.locator('#tagBuilder').isVisible(),'late ERP response overwrote label builder');assert.equal(await page.locator('#main .trade-alert.error').count(),0);await page.unroute('**/api/erp/state');
 if(process.env.QA_BROWSER!=='webkit'){
  const touch=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,storageState:await page.context().storageState()});const t=await touch.newPage();
  await t.goto(base+'/#operations/tags');await t.locator('#activeField').waitFor();
  await t.locator('#previewProduct').tap();assert(await t.locator('.ui-combo-popup').isVisible());const touchChoice=await t.locator('#previewProductList [role=option]').nth(1).innerText();await t.locator('#previewProductList [role=option]').nth(1).tap();assert.equal(await t.locator('#previewProduct').inputValue(),touchChoice);assert.equal(await t.locator('#previewProduct').getAttribute('aria-expanded'),'false');
  const sizes=await t.locator('.ui-button:visible,.ui-select:visible,.ui-input:visible,.ui-combo-toggle:visible').evaluateAll(nodes=>nodes.map(el=>({name:el.id||el.name||el.textContent.trim(),h:el.getBoundingClientRect().height})));
  assert(sizes.every(x=>x.h>=44),'touch heights: '+JSON.stringify(sizes.filter(x=>x.h<44)));
  await t.emulateMedia({forcedColors:'active'});assert.equal(await t.locator('#activeField').evaluate(el=>getComputedStyle(el).appearance),'auto');assert.equal(await t.locator('#activeField').evaluate(el=>getComputedStyle(el).backgroundImage),'none');await touch.close();
  // Chrome's actual persisted page zoom, not CSS zoom or a simulated viewport.
  zoomProfile=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-zoom-'));fs.mkdirSync(path.join(zoomProfile,'Default'));
  fs.writeFileSync(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));
  zoomContext=await chromium.launchPersistentContext(zoomProfile,{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:null,args:['--window-size=1440,1000']});
  const zoom=zoomContext.pages()[0];await zoom.goto(base);assert.equal(await zoom.evaluate(()=>devicePixelRatio),2,'actual 200% page zoom');assert.equal(await zoom.evaluate(()=>innerWidth),720);
  await zoom.locator('[name=username]').fill('tester');await zoom.locator('[name=password]').fill(password);await zoom.locator('[type=submit]').click();await zoom.waitForSelector('#main .stats');
  for(const route of ['operations/products','operations/tags','trade/purchases','trade/stock','trade/sales','trade/finance','trade/staff','trade/customers','trade/reports','trade/setup']){
   await zoom.goto(base+'/#'+route);await zoom.waitForSelector('#main .panel');await zoom.waitForFunction(()=>!document.querySelector('#main > .panel > p[role=status]'));assert.equal(await zoom.locator('#main .trade-alert.error').count(),0,'route error: '+route);assert(await zoom.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% reflow: '+route);
  }
  await zoom.goto(base+'/#operations/products');await zoom.waitForSelector('.catalog-table');await zoom.locator('[data-act=newProduct]').click();assert(await zoom.locator('#productForm [type=submit]').isVisible());await zoom.locator('[data-act=closeProduct]').first().click();
  const cdp=await zoomContext.newCDPSession(zoom);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'tsukenya-zoom-200.png'),Buffer.from(shot.data,'base64'));await zoomContext.close();zoomContext=null;fs.rmSync(zoomProfile,{recursive:true,force:true});zoomProfile=null;
 }
 assert.deepEqual(errors,[]);console.log((process.env.QA_BROWSER||'Chrome')+': PASS: late response isolation, mobile field selection/navigation, single light theme; pinned headings mask rows and stay within categories; select indicators in portal/dialog/CRM; light/dark at 4 widths.'+(process.env.QA_BROWSER==='webkit'?'':' Actual 200% zoom, touch and forced colors passed in Chrome.'));
})().catch(async e=>{if(zoomContext){const p=zoomContext.pages()[0];await p.screenshot({path:path.join(os.tmpdir(),'tsukenya-zoom-error.png')});console.error('Failed route:',new URL(p.url()).hash);}console.error(e);process.exitCode=1;}).finally(async()=>{if(zoomContext)await zoomContext.close();if(zoomProfile)fs.rmSync(zoomProfile,{recursive:true,force:true});if(browser)await browser.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
