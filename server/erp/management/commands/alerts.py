import os
from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from server.erp.alerts import sync_alerts
class Command(BaseCommand):
    help='Update due-payment, low-stock and expiry tasks without duplicates.'
    def handle(self,*args,**kwargs):
        user=User.objects.get(username=os.environ.get('OWNER_USERNAME','pavlo'))
        self.stdout.write(str(sync_alerts(user)))
