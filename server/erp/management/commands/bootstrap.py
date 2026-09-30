"""Idempotent import of the owner's portal. Never invent stock or cash balances."""
import csv
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.conf import settings
from server.erp.models import *

class Command(BaseCommand):
    help='Initialize CRM and import legacy SQLite documents and owner credentials once.'
    def add_arguments(self,parser):
        parser.add_argument('--legacy',default='')
        parser.add_argument('--empty',action='store_true')
    @transaction.atomic
    def handle(self,*args,**options):
        name=os.environ.get('OWNER_USERNAME','pavlo')
        u,_=User.objects.get_or_create(username=name,defaults={'is_staff':True,'is_superuser':True})
        Profile.objects.get_or_create(user=u,defaults={'role':'owner'})
        LedgerLock.objects.get_or_create(pk=1)
        if Setting.objects.filter(pk='initialized').exists():
            self.stdout.write('CRM already initialized; no documents overwritten.');return
        password=os.environ.get('OWNER_PASSWORD_HASH','')
        if options['legacy']:
            file=Path(options['legacy'])
            if not file.is_file():raise CommandError('Legacy database does not exist.')
            db=sqlite3.connect(f'file:{file}?mode=ro',uri=True)
            try:
                rows=db.execute('SELECT path,data FROM documents ORDER BY path').fetchall()
                for path,raw in rows:Document.objects.create(path=path,data=json.loads(raw))
                row=db.execute("SELECT value FROM account WHERE key='password_hash'").fetchone()
                if row:password=row[0]
                for token,csrf,expires in db.execute('SELECT token_hash,csrf,expires FROM sessions'):
                    PortalSession.objects.get_or_create(pk=token,defaults={'csrf':csrf,'expires':expires,'user':u})
                expected=[(p,json.loads(d)) for p,d in rows]
                actual=list(Document.objects.order_by('path').values_list('path','data'))
                if expected!=actual:raise CommandError('Import verification failed; transaction rolled back.')
                checksum=hashlib.sha256(json.dumps(expected,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
                Setting.objects.create(key='legacy_import_checksum',value=checksum)
                self.stdout.write(f'Verified import: {len(rows)} documents, checksum {checksum}.')
            finally:db.close()
        elif not options['empty']:
            seed=settings.BASE_DIR/'seed.csv'
            if not seed.exists():seed=settings.BASE_DIR/'data/tovary-source-2026-09-29.csv'
            with seed.open(encoding='utf-8-sig',newline='') as source:
                for row in csv.DictReader(source):
                    def n(key):
                        x=row[key].replace('\u00a0','').replace(' ','').replace(',','.').strip()
                        return float(x) if x else None
                    cost,markup,price=(n(k) for k in ['Закупівля, грн','Націнка, %','Ціна продажу, грн'])
                    Document.objects.create(path='products/'+row['ID'].strip(),data={'name':row['Назва'].strip(),'type':row['Група'].strip(),'category':row['Категорія'].strip(),'pack':row['Пакування'].strip(),'size':row['Об’єм / вага'].strip(),'unit':row['Од.'].strip() or 'шт','cost':cost or 0,'markup':markup if markup is not None else 30,'manualPrice':price is not None,'price':price,'priceAt':row['Ціна оновлена'].strip()})
            Document.objects.create(path='settings/main',data={'chainName':'Цукерня','gsUrl':'https://docs.google.com/spreadsheets/d/134HsmPHl97xsbCjcEVrFqqjv2Z2_3Qc1Fdhs1kLfNow/edit'})
        if not password:raise CommandError('OWNER_PASSWORD_HASH is required for initialization.')
        Setting.objects.create(key='owner_password',value=password)
        store=Store.objects.create(name='Основний магазин')
        Warehouse.objects.create(store=store,name='Основний склад')
        CashAccount.objects.create(store=store,name='Каса',kind='cash')
        CashAccount.objects.create(store=store,name='Банк / термінал',kind='terminal')
        Setting.objects.create(key='initialized',value='crm-2')
        self.stdout.write('CRM initialized. Stock and cash balances are zero until entered by the owner.')
