/* Compatibility CLI for historical recipe scopes. The current assertions live in
   the real-editor durable recovery harness; private input is hidden on denied reads. */
const {execFileSync}=require('node:child_process'),path=require('node:path');
const scopes={QA_RECIPE_PAGING_ONLY:'paging',QA_RECIPE_COMPAT_ONLY:'compat',QA_RECIPE_ROLE_ACK_ONLY:'role',QA_RECIPE_ACK_ONLY:'ack',QA_RECIPE_VALIDATION_ONLY:'validation',QA_RECIPE_READ_ONLY:'read',QA_RECIPE_LAYOUT_ONLY:'layout'};
const flag=Object.keys(scopes).find(key=>process.env[key]);
execFileSync(process.execPath,[path.join(__dirname,'recipes-ui.cjs')],{env:{...process.env,QA_RECIPES_FROM:flag?scopes[flag]:'conflict'},stdio:'inherit'});
