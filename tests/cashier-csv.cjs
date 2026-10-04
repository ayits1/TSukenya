/* Exact authoritative report CSV; synthetic spool only, no database or browser. */
const {execFileSync}=require('node:child_process'),path=require('node:path');
const python=process.env.PYTHON_BIN||'python3';
const code=`
import os, csv, io
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from contextlib import contextmanager
from unittest.mock import patch
from server.erp import bounded_reports as reports
row={'name':'=Синтетичний касир','shifts':0,'hours':'0.0','revenue':'0.00','revenue_per_hour':None,'with_difference':0,'shortage':'0.00','surplus':'0.00','net':'0.00','late_return_bonus':'20.07'}
class Spool:
 def rows(self,section,q):yield 'synthetic',row
for salary in (False,True):
 @contextmanager
 def built(user,params):yield Spool(),{'counts':{'cashiers':1},'can_view_payroll':salary,'mode':'period','scope_name':'Synthetic','generated_at':'2026-10-04T00:00:00Z'}
 with patch.object(reports,'actor',return_value=object()),patch.object(reports,'built',built):
  response=reports.export_csv(object(),{'mode':'period','section':'cashiers'})
  text=b''.join(response.streaming_content).decode('utf-8-sig');response.close()
 records=list(csv.reader(io.StringIO(text),delimiter=';'));headers,values=records[1:]
 assert len(headers)==(10 if salary else 9) and len(values)==len(headers)
 assert values[headers.index('Виторг на годину')]==''
 assert values[0]=='\\t=Синтетичний касир'
 assert values[headers.index('З розходженням')]=='0'
 if salary:assert values[-1]=='20.07'
 else:assert not any('Бонус' in value for value in headers)
print('CASHIER CSV PASS: authoritative salary-visible/hidden fields, exact cents, empty hourly rate and guarded names; zero database reads')
`;
process.stdout.write(execFileSync(python,['-c',code],{cwd:path.join(__dirname,'..'),encoding:'utf8'}));
