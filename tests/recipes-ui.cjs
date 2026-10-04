/* Current real recipe editors, each scope owns its isolated SQLite/headless server.
   Old live-only expectations were replaced by explicit durable recovery transitions. */
const {execFileSync}=require('node:child_process'),path=require('node:path');
const scope=process.env.QA_RECIPES_FROM||'all';
const modes={
 paging:['protocol'],validation:['inputs','validation'],conflict:['legacy','version','frozen'],
 read:['protocol','confirmed','guards','cancel','preflight','identity'],layout:['raw'],ack:['version','confirmed'],
 role:['privacy','guards'],compat:['compat'],reload:['raw','cold'],
 all:['raw','legacy','version','validation','confirmed','frozen','privacy','cold','guards','inputs','compat','protocol','cancel','preflight','identity'],
};
if(!Object.hasOwn(modes,scope))throw Error('Unknown QA_RECIPES_FROM: use all, paging, validation, conflict, read, layout, ack, role, compat, reload');
for(const stage of modes[scope]){
 const env={...process.env,QA_RECIPE_DRAFT_FROM:stage};
 for(const key of ['QA_RECIPE_READ_ONLY','QA_RECIPE_VALIDATION_ONLY','QA_RECIPE_LAYOUT_ONLY','QA_RECIPE_ACK_ONLY','QA_RECIPE_ROLE_ACK_ONLY','QA_RECIPE_COMPAT_ONLY','QA_RECIPE_COMPAT_FROM','QA_RECIPE_PAGING_ONLY'])delete env[key];
 execFileSync(process.execPath,[path.join(__dirname,'recipe-draft-reload-ui.cjs')],{env,stdio:'inherit'});
}
