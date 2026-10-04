/* Current recipe UI entrypoint: shared recovery replaces destructive legacy reload assertions.
   Every child creates its own synthetic SQLite/server. Ordinary development chooses one scope. */
const {execFileSync}=require('node:child_process'),path=require('node:path');
const scope=process.env.QA_RECIPES_FROM||'all';
const modes={validation:['QA_RECIPE_VALIDATION_ONLY'],conflict:[''],read:['QA_RECIPE_READ_ONLY'],layout:['QA_RECIPE_LAYOUT_ONLY'],ack:['QA_RECIPE_ACK_ONLY'],role:['QA_RECIPE_ROLE_ACK_ONLY'],all:['','QA_RECIPE_READ_ONLY','QA_RECIPE_VALIDATION_ONLY','QA_RECIPE_ACK_ONLY','QA_RECIPE_ROLE_ACK_ONLY']};
if(!Object.hasOwn(modes,scope))throw Error('Current recipe scopes: all, validation, conflict, read, layout, ack, role. Browser zoom remains in the shared directory/control quality checks.');
for(const mode of modes[scope]){const env={...process.env};for(const flag of ['QA_RECIPE_READ_ONLY','QA_RECIPE_VALIDATION_ONLY','QA_RECIPE_LAYOUT_ONLY','QA_RECIPE_ACK_ONLY','QA_RECIPE_ROLE_ACK_ONLY'])delete env[flag];if(mode)env[mode]='1';execFileSync(process.execPath,[path.join(__dirname,'recipe-conflict-ui.cjs')],{env,stdio:'inherit'});}
