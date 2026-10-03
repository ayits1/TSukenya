import os
from django.core.management.base import BaseCommand, CommandError
from django.contrib.auth.models import User
from server.erp.alerts import run_alerts, record_alert_error
class Command(BaseCommand):
    help='Update due-payment, low-stock and expiry tasks without duplicates; records the last success or error.'
    def handle(self,*args,**kwargs):
        try:user=User.objects.get(username=os.environ.get('OWNER_USERNAME','pavlo'))
        except User.DoesNotExist:
            error=CommandError('Власника для контролю не знайдено.');record_alert_error(None,'scheduler',error);raise error
        self.stdout.write(str(run_alerts(user,'scheduler')))
