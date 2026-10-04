from django.core.management.base import BaseCommand, CommandError
from server.erp.service_health import import_worker_status


class Command(BaseCommand):
    help='Перевірити живий worker імпорту без записів, імен файлів та даних користувачів.'
    def handle(self,*args,**options):
        state=import_worker_status()
        if state['status']!='available':raise CommandError('Worker імпорту недоступний або його heartbeat застарів.')
        self.stdout.write('Worker імпорту доступний.')
