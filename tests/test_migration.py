import json
import os
import sqlite3
import tempfile
from pathlib import Path
from django.test import TestCase
from django.core.management import call_command
from server.erp.models import Document, StockLot, CashEntry, Setting, PortalSession
from server.auth import hash_password, valid_password

class LegacyImportTests(TestCase):
    def test_all_documents_password_and_sessions_survive_idempotent_import(self):
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'legacy.sqlite3';db=sqlite3.connect(file)
            db.executescript('CREATE TABLE documents(path TEXT PRIMARY KEY,data TEXT);CREATE TABLE account(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,csrf TEXT,expires INTEGER);')
            docs={'products/p':{'name':'Original','price':12.5,'promotion':True,'barcode':'0123'},'settings/main':{'tag':{'styles':{'price':{'size':26}}}},'tasks/t':{'text':'Original task'}}
            for key,value in docs.items():db.execute('INSERT INTO documents VALUES (?,?)',(key,json.dumps(value)))
            db.execute('INSERT INTO account VALUES (?,?)',('password_hash',hash_password('changed-original-password')))
            db.execute('INSERT INTO sessions VALUES (?,?,?)',('a'*64,'oldcsrf',9999999999));db.commit();db.close()
            from io import StringIO
            call_command('bootstrap',legacy=str(file),stdout=StringIO())
            self.assertEqual(dict(Document.objects.values_list('path','data')),docs)
            self.assertTrue(valid_password('changed-original-password',Setting.objects.get(pk='owner_password').value))
            self.assertEqual(PortalSession.objects.get().csrf,'oldcsrf')
            self.assertEqual(StockLot.objects.count(),0);self.assertEqual(CashEntry.objects.count(),0)
            d=Document.objects.get(pk='products/p');d.data['price']=99;d.save()
            call_command('bootstrap',legacy=str(file),stdout=StringIO())
            self.assertEqual(Document.objects.get(pk='products/p').data['price'],99)
