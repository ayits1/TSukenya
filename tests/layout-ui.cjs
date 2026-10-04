const {waitForTradingRoute}=require('./trading-document-controls.cjs');
/* Layout regression: shared control indicators, React studio rows and reflow; isolated data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-layout-'));
const port=process.env.QA_BROWSER==='webkit'?18204:18203,python=process.env.PYTHON_BIN||'python3',base='http://localhost:'+port,password='layout-test-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("layout-test-password"))'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),PORT:String(port),HOST:'127.0.0.1',OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const layoutWidths=process.env.QA_LAYOUT_WIDTH?[Number(process.env.QA_LAYOUT_WIDTH)]:[1440,768,390,320];
const layoutThemes=process.env.QA_LAYOUT_THEME?[process.env.QA_LAYOUT_THEME]:['light','dark'];
assert(layoutWidths.every(width=>Number.isInteger(width)&&width>=320),'QA_LAYOUT_WIDTH must be an integer >=320');
assert(layoutThemes.every(theme=>['light','dark'].includes(theme)),'QA_LAYOUT_THEME must be light or dark');
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});
let browser,zoomContext,zoomProfile;
async function checkSelects(page){
 const controls=await page.locator('select:visible:not([multiple]):not([size])').evaluateAll(nodes=>nodes.filter(el=>!el.closest('[aria-hidden=true]')).map(el=>{const s=getComputedStyle(el);return{id:el.id||el.name,appearance:s.appearance,image:s.backgroundImage,position:s.backgroundPosition,padding:parseFloat(s.paddingRight),width:el.getBoundingClientRect().width};}));
 const reactControls=await page.locator('.tk-select-trigger:visible,.tk-combo-toggle:visible').evaluateAll(nodes=>nodes.map(el=>{const b=el.getBoundingClientRect(),arrow=el.querySelector('svg').getBoundingClientRect();return{height:b.height,center:Math.abs((b.y+b.height/2)-(arrow.y+arrow.height/2)),inset:b.right-arrow.right};}));
 assert(controls.length+reactControls.length,'visible selects');
 for(const c of reactControls){assert(c.height>=44&&c.center<=1&&c.inset>=10,'React indicator geometry');}
 for(const c of controls){assert.equal(c.appearance,'none',c.id);assert.match(c.image,/svg/,c.id);assert.match(c.position,/12px.*50%/,c.id);assert(c.padding>=40&&c.width>54,c.id+' indicator space');}
}
(async()=>{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=process.env.QA_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({ headless: true });
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await require('./browser-login.cjs')(page,base,password);
 for(const theme of (process.env.QA_ZOOM_ONLY?[]:layoutThemes))for(const width of layoutWidths){
  console.log(`Layout case: ${process.env.QA_BROWSER||'chromium'} ${theme} ${width}px`);
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
  await page.goto(base+'/#operations/tags');await page.locator('.tk-studio').waitFor();
  const combo=page.getByRole('combobox',{name:'Товар для перегляду',exact:true});await combo.waitFor();await checkSelects(page);
  assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(245, 246, 247)','single light theme');
  if(width<=390){
   const picker=page.locator('.tk-studio-mobile-field .tk-select-trigger');assert(await picker.isVisible());assert(!(await page.locator('.tk-studio-layer-list').isVisible()));
   await picker.click();await page.getByRole('option',{name:'Ціна',exact:true}).click();assert.equal(await page.locator('.tk-studio-properties h3').innerText(),'Ціна');
   await page.locator('#navToggle').click();assert(await page.locator('#portalSidebar').isVisible());await page.keyboard.press('Escape');assert(!(await page.locator('#portalSidebar').isVisible()));assert(await page.locator('#navToggle').evaluate(el=>el===document.activeElement));
  }
  await combo.click();await page.locator('.tk-popover:visible').waitFor();assert.equal(await combo.getAttribute('aria-expanded'),'true');
  const box=await page.locator('.tk-popover:visible').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=1001,'combobox viewport bounds: '+JSON.stringify(box));
  if(theme==='light'&&(width===1440||width===390))await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-react-studio-combo-'+width+'.png')});
  assert(await page.locator('.tk-studio-preview-picker .tk-combo-toggle').evaluate(el=>{const b=el.getBoundingClientRect(),i=el.parentElement.querySelector('input').getBoundingClientRect();return b.left>=i.right-1&&Math.abs((b.y+b.height/2)-(i.y+i.height/2))<=1;}),'combobox indicator alignment');
  await combo.fill('Американо');await page.getByRole('option',{name:'Американо',exact:true}).waitFor();await combo.press('ArrowDown');await combo.press('Enter');assert.equal(await page.locator('.tk-studio-canvas [data-field=name]').innerText(),'Американо');
  await page.getByRole('tab',{name:/^Товари/}).click();await page.locator('.tk-studio-product-row').first().waitFor();
  // The paginated list has no pinned category headings. Hit testing detects overlapping rows.
  await page.locator('.tk-studio-product-list').scrollIntoViewIfNeeded();
  const rows=await page.locator('.tk-studio-product-row').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return{top:b.top,bottom:b.bottom};}));
  assert(rows.every((row,index)=>index===0||row.top>=rows[index-1].bottom-1),'product rows overlap');
  const firstRow=page.locator('.tk-studio-product-row').first();
  // Sticky navigation legitimately covers content at the viewport edge. Center the row
  // before checking row-on-row paint; scrollIntoViewIfNeeded does not account for overlays.
  await firstRow.evaluate(row=>row.scrollIntoView({block:'center',behavior:'instant'}));
  const hit=await firstRow.evaluate(row=>{
   const bounds=el=>{if(!el)return null;const b=el.getBoundingClientRect(),s=getComputedStyle(el);return{tag:el.tagName,id:el.id,class:el.className,top:b.top,bottom:b.bottom,left:b.left,right:b.right,height:b.height,position:s.position,zIndex:s.zIndex};};
   const b=row.getBoundingClientRect(),x=b.left+Math.min(60,b.width/2),y=b.top+b.height/2,painted=document.elementFromPoint(x,y);
   return{passed:painted?.closest('.tk-studio-product-row')===row,x,y,scrollY,viewport:{width:innerWidth,height:innerHeight},row:bounds(row),painted:bounds(painted),tabs:bounds(document.querySelector('.tk-studio-tabs'))};
  });
  if(!hit.passed){
   const artifact=path.join(os.tmpdir(),`tsukenya-layout-hit-${process.env.QA_BROWSER||'chromium'}-${theme}-${width}`);
   fs.writeFileSync(artifact+'.json',JSON.stringify(hit,null,2));await page.screenshot({path:artifact+'.png'});console.error('Hit test diagnostic:',JSON.stringify(hit));
  }
  console.log('Row paint geometry:',JSON.stringify(hit));
  assert(hit.passed,`product row painted beneath another layer (${theme} ${width}px): ${JSON.stringify(hit)}`);
  {
   // Native focus scrolling must reveal the checkbox below the sticky tabs.
   await firstRow.evaluate(row=>window.scrollTo({top:scrollY+row.getBoundingClientRect().top,behavior:'instant'}));
   await firstRow.getByRole('checkbox').focus();
   const focusHit=await firstRow.getByRole('checkbox').evaluate(input=>{const label=input.closest('.tk-studio-check'),mark=label.querySelector('.tk-studio-check-box'),b=mark.getBoundingClientRect(),painted=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{focused:document.activeElement===input,visible:painted?.closest('.tk-studio-check')===label,top:b.top,bottom:b.bottom,painted:painted?.className,tabsBottom:document.querySelector('.tk-studio-tabs').getBoundingClientRect().bottom};});
   console.log('Keyboard focus diagnostic:',JSON.stringify(focusHit));
   if(!focusHit.focused||!focusHit.visible){
    const artifact=path.join(os.tmpdir(),`tsukenya-layout-focus-${process.env.QA_BROWSER||'chromium'}-${theme}-${width}`);
    fs.writeFileSync(artifact+'.json',JSON.stringify(focusHit,null,2));await page.screenshot({path:artifact+'.png'});
   }
   assert(focusHit.focused&&focusHit.visible,`checkbox focus hidden by sticky navigation (${theme} ${width}px): ${JSON.stringify(focusHit)}`);
  }
  if(width===1440||width===390)await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-react-studio-products-${theme}-${width}.png`)});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow');
  await page.goto(base+'/#operations/products');await page.waitForSelector('.tk-catalog-pagination');await checkSelects(page);
  await page.getByRole('button',{name:'Додати товар'}).click();await checkSelects(page);await page.getByRole('button',{name:'Закрити редактор'}).click();
  await page.goto(base+'/#trade/sales');await page.getByRole('button',{name:'+ Продаж',exact:true}).waitFor();await page.getByRole('button',{name:'+ Продаж',exact:true}).click();await page.locator('#tradeVoucherForm').waitFor();await checkSelects(page);
  if(width===1440)await page.locator('.trade-dialog').screenshot({path:path.join(os.tmpdir(),`tsukenya-selects-${theme}.png`)});
 }
 if(process.env.QA_LAYOUT_ONLY){assert.deepEqual(errors,[]);console.log('PASS: targeted layout cases '+JSON.stringify({widths:layoutWidths,themes:layoutThemes}));return;}
 // A delayed CRM response must never overwrite the next workspace.
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/#trade/setup');await page.locator('[data-trade=users]').waitFor();
 await page.route('**/api/erp/state',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
 const delayed=page.waitForResponse(r=>r.url().endsWith('/api/erp/state'));
 await page.goto(base+'/#trade/sales');await page.locator('#main [role=status]').waitFor();
 await page.goto(base+'/#operations/tags');await page.locator('.tk-studio').waitFor();await page.getByRole('combobox',{name:'Товар для перегляду',exact:true}).waitFor();await delayed;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 assert(await page.locator('.tk-studio').isVisible(),'late ERP response overwrote label builder');assert.equal(await page.locator('#main .trade-alert.error').count(),0);await page.unroute('**/api/erp/state');
 if(process.env.QA_BROWSER!=='webkit'){
  const touch=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,storageState:await page.context().storageState()});const t=await touch.newPage();
  await t.goto(base+'/#operations/tags');await t.locator('.tk-studio-mobile-field .tk-select-trigger').waitFor();
  const touchCombo=t.getByRole('combobox',{name:'Товар для перегляду',exact:true});await touchCombo.tap();await t.locator('.tk-popover:visible').waitFor();const touchChoice=await t.getByRole('option').nth(1).innerText();await t.getByRole('option').nth(1).tap();assert.equal(await touchCombo.inputValue(),touchChoice);assert.equal(await touchCombo.getAttribute('aria-expanded'),'false');
  const sizes=await t.locator('.tk-studio .tk-button:visible,.tk-studio .tk-select-trigger:visible,.tk-studio .tk-input:visible,.tk-studio .tk-combo-toggle:visible').evaluateAll(nodes=>nodes.map(el=>({name:el.id||el.name||el.textContent.trim(),h:el.getBoundingClientRect().height})));
  assert(sizes.length&&sizes.every(x=>x.h>=44),'touch heights: '+JSON.stringify(sizes.filter(x=>x.h<44)));
  await t.emulateMedia({forcedColors:'active'});const forcedPicker=t.locator('.tk-studio-mobile-field .tk-select-trigger');await t.keyboard.press('Tab');await forcedPicker.focus();assert(await forcedPicker.evaluate(el=>parseFloat(getComputedStyle(el).outlineWidth)>=2),'forced-colors visible focus');await checkSelects(t);await t.screenshot({path:path.join(os.tmpdir(),'tsukenya-react-studio-forced-colors.png')});await touch.close();
  // Chrome's actual persisted page zoom, not CSS zoom or a simulated viewport.
  zoomProfile=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-zoom-'));fs.mkdirSync(path.join(zoomProfile,'Default'));
  fs.writeFileSync(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));
  zoomContext=await chromium.launchPersistentContext(zoomProfile,{ headless: true, viewport:null, args:['--window-size=1440,1000'] });
  const zoom=zoomContext.pages()[0];await zoom.goto(base);assert.equal(await zoom.evaluate(()=>devicePixelRatio),2,'actual 200% page zoom');assert.equal(await zoom.evaluate(()=>innerWidth),720);
  await zoom.locator('[name=username]').fill('tester');await zoom.locator('[name=password]').fill(password);await zoom.locator('[type=submit]').click();await zoom.waitForSelector('#main .stats');
  for(const route of ['operations/products','operations/tags','trade/purchases','trade/stock','trade/sales','trade/finance','trade/staff','trade/customers','trade/reports','trade/setup']){
   await zoom.goto(base+'/#'+route);if(['trade/purchases','trade/sales'].includes(route))await waitForTradingRoute(zoom,route.split('/')[1]);else await zoom.waitForSelector(route==='operations/products'?'.tk-catalog':route==='operations/tags'?'.tk-studio':'#main .panel');if(route==='operations/tags')await zoom.getByRole('combobox',{name:'Товар для перегляду',exact:true}).waitFor();await zoom.waitForFunction(()=>!document.querySelector('#main > .panel > p[role=status]'));assert.equal(await zoom.locator('#main .trade-alert.error').count(),0,'route error: '+route);assert(await zoom.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% reflow: '+route);
  }
  await zoom.goto(base+'/#operations/products');await zoom.waitForSelector('.tk-product-table');await zoom.getByRole('button',{name:'Додати товар'}).click();assert(await zoom.getByRole('dialog').getByRole('button',{name:'Зберегти товар'}).isVisible());await zoom.getByRole('button',{name:'Закрити редактор'}).click();
  const cdp=await zoomContext.newCDPSession(zoom);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'tsukenya-zoom-200.png'),Buffer.from(shot.data,'base64'));await zoomContext.close();zoomContext=null;fs.rmSync(zoomProfile,{recursive:true,force:true});zoomProfile=null;
 }
 assert.deepEqual(errors,[]);console.log((process.env.QA_BROWSER||'Chrome')+': PASS: '+(process.env.QA_ZOOM_ONLY?'targeted late response isolation, actual 200% zoom, touch and forced-colors checks.':'late response isolation, mobile field selection/navigation, single light theme; React studio rows have no overlap; select/combobox indicators in portal/dialog/CRM; light/dark at 4 widths.'+(process.env.QA_BROWSER==='webkit'?'':' Actual 200% zoom, touch and forced colors passed in Chrome.')));
})().catch(async e=>{if(zoomContext){const p=zoomContext.pages()[0];await p.screenshot({path:path.join(os.tmpdir(),'tsukenya-zoom-error.png')});console.error('Failed route:',new URL(p.url()).hash);}console.error(e);process.exitCode=1;}).finally(async()=>{if(zoomContext)await zoomContext.close();if(zoomProfile)fs.rmSync(zoomProfile,{recursive:true,force:true});if(browser)await browser.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
