// Run with bundled @oai/artifact-tool dependencies; no repository dependency changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const schema=JSON.parse(await fs.readFile(path.join(root,'contracts/catalog-exchange.schema.json'),'utf8'));
const fields=schema.profiles.exchange.keys.map(key=>schema.fields.find(f=>f.key===key));
const wb=Workbook.create(),sheet=wb.worksheets.add('Товари'),info=wb.worksheets.add('Як заповнити');
sheet.getRange('A1:N1').values=[fields.map((f,i)=>f.label+(i===0?schema.marker:''))];
sheet.getRange('A2:N3').values=[
 ['Приклад: чай','Напої','Чай','Упаковка','100 г','шт','0012345678901',10,30,'Автоматична',null,'Ні',null,null],
 ['Приклад: печиво','Печиво','Печиво','Упаковка','300 г','шт',null,0,0.5,'Ручна',49,'Так',39,null],
];
sheet.getRange('A1:N101').format.font={name:'Arial',size:11};
sheet.getRange('A1:N1').format={fill:'#263746',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},wrapText:true,rowHeight:58,verticalAlignment:'center'};
sheet.getRange('A2:N101').format.rowHeight=24;
sheet.getRange('A:N').format.columnWidth=24;
sheet.getRange('A:A').format.columnWidth=32;
sheet.getRange('J:J').format.columnWidth=30;
sheet.getRange('A2:G101').format.numberFormat='@';
sheet.getRange('N2:N101').format.numberFormat='@';
sheet.getRange('H2:H101').format.numberFormat='0.00';
sheet.getRange('I2:I101').format.numberFormat='0.0000';
sheet.getRange('K2:K101').format.numberFormat='0.00';
sheet.getRange('M2:M101').format.numberFormat='0.00';
sheet.getRange('J2:J101').dataValidation={rule:{type:'list',values:Object.keys(fields.find(f=>f.key==='manualPrice').values)}};
sheet.getRange('L2:L101').dataValidation={rule:{type:'list',values:['Так','Ні']}};
sheet.dataValidations.add({range:'H2:I101',rule:{type:'decimal',operator:'greaterThanOrEqual',formula1:0}});
sheet.dataValidations.add({range:'K2:K101',rule:{type:'decimal',operator:'greaterThan',formula1:0}});
sheet.dataValidations.add({range:'M2:M101',rule:{type:'decimal',operator:'greaterThan',formula1:0}});
sheet.tables.add('A1:N101',true,'CatalogueExchange');
sheet.freezePanes.freezeRows(1);sheet.freezePanes.freezeColumns(1);
info.getRange('A1:B10').values=[
 ['Схема каталогу 1','Шаблон імпорту CSV/XLSX'],
 ['Приклади','Два рядки синтетичні. Замініть або видаліть їх перед імпортом.'],
 ['Порожня клітинка','Зберігає чинне значення. Явний нуль закупівлі/націнки не є порожнім.'],
 ['Автоматична ціна','Спосіб: Автоматична. Ручну ціну залиште порожньою; Django рахує з закупівлі/націнки.'],
 ['Ручна ціна','Спосіб: Ручна. Вкажіть додатну ручну ціну продажу.'],
 ['Акція товару','Так/Ні та окрема додатна акційна ціна нижче звичайної. Кампанії тут не редагуються.'],
 ['ID','Порожній для нового товару. Для оновлення — чинний ID і відповідна назва; не змінюйте ID.'],
 ['Штрихкод','Текст. Початкові нулі зберігаються.'],
 ['Націнка','Число процентних пунктів: 0.5 означає 0.5%. Не форматуйте стовпець Excel як відсоток.'],
 ['Довідкові поля','Розраховані ціни, чинна кампанія, дата й прихованість з експорту не імпортуються.'],
];
info.getRange('A1:B10').format.font={name:'Arial',size:11};
info.getRange('A1:B1').format={fill:'#263746',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'}};
info.getRange('A:A').format.columnWidth=25;info.getRange('B:B').format.columnWidth=95;
info.getRange('A1:B10').format.wrapText=true;info.getRange('A1:B10').format.autofitRows();
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'Товари!A1:N3',tableMaxRows:3,tableMaxCols:14,maxChars:4500})).ndjson);
const exported=await SpreadsheetFile.exportXlsx(wb);await exported.save(path.join(root,'data/catalogue-template-v1.xlsx'));
if(process.env.CATALOG_TEMPLATE_PROOF){
 const output=process.env.CATALOG_TEMPLATE_PROOF;await fs.mkdir(output,{recursive:true});
 for(const [name,range] of [['template-prices','Товари!H1:N3'],['template-instructions','Як заповнити!A1:B10']]){
  const [sheetName,area]=range.split('!');const blob=await wb.render({sheetName,range:area,scale:1});await fs.writeFile(path.join(output,name+'.png'),new Uint8Array(await blob.arrayBuffer()));
 }
}
