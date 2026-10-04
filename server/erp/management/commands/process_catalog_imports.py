from django.core.management.base import BaseCommand, CommandError
from server.erp.import_jobs import process_one, uuid_value, JobError

class Command(BaseCommand):
    help='Виконати обмежені кроки збережених імпортів каталогу.'
    def add_arguments(self,parser):
        parser.add_argument('--once',action='store_true')
        parser.add_argument('--run')
        parser.add_argument('--max-steps',type=int,default=1)
    def handle(self,*args,**options):
        if not 1<=options['max_steps']<=100000:raise CommandError('max-steps має бути 1–100000.')
        try:identifier=uuid_value(options['run']) if options['run'] else None
        except JobError as exc:raise CommandError(str(exc)) from exc
        n=0
        for _ in range(1 if options['once'] else options['max_steps']):
            if not process_one(identifier):break
            n+=1
        self.stdout.write(f'Виконано кроків: {n}')
