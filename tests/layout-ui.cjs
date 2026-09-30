/* Layout regression: scrolling group headers and select indicators, isolated data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-layout-'));
const python=process.env.PYTHON_BIN||'python3',base='http://localhost:18203',password='layout-test-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("layout-test-password"))'],{cwd:root,encoding:'utf8'}).trim();
const server=spawn(python,['-m','server.main'],{cwd:root,env:{...process.env,DATA_DIR:data,PORT:'18203',HOST:'127.0.0.1',OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash},stdio:'ignore'});
let browser;
async function checkSelects(page){
 const controls=await page.locator('select:visible:not([multiple]):not([size])').evaluateAll(nodes=>nodes.map(el=>{const s=getComputedStyle(el);return{id:el.id||el.name,appearance:s.appearance,image:s.backgroundImage,position:s.backgroundPosition,padding:parseFloat(s.paddingRight),width:el.getBoundingClientRect().width};}));
 assert(controls.length,'visible selects');
 for(const c of controls){assert.equal(c.appearance,'none',c.id);assert.match(c.image,/svg/,c.id);assert.match(c.position,/10px.*50%/,c.id);assert(c.padding>=34&&c.width>44,c.id+' indicator space');}
}
(async()=>{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('[name=username]').fill('tester');await page.locator('[name=password]').fill(password);await page.locator('[type=submit]').click();await page.waitForSelector('#main .stats');
 for(const theme of ['light','dark'])for(const width of [1440,768,390,320]){
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
  await page.goto(base+'/#operations/tags');await page.waitForSelector('.pick-group');await checkSelects(page);
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
 assert.deepEqual(errors,[]);console.log('PASS: pinned headings mask rows and stay within categories; select indicators in portal/dialog/CRM; light/dark at 4 widths.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
