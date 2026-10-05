/* Test-only enumeration; production pickers read one bounded page or selected IDs. */
module.exports=async function references(page){return page.evaluate(async()=>{
 const result={items:[],archivedItems:[],canEdit:false};
 for(const field of ['type','category','pack','size','unit']) for(const state of ['active','archived']){
  let number=1;
  while(true){const response=await fetch('/api/v1/catalog/references/page?'+new URLSearchParams({field,state,q:'',page:String(number)}));if(!response.ok)throw Error('Reference page '+response.status);const data=await response.json();result.canEdit=data.canEdit;result[state==='active'?'items':'archivedItems'].push(...data.items);if(number>=data.pages)break;number++;}
 }return result;
});};
