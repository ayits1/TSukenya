from django.core.management.base import BaseCommand, CommandError
from server.erp.import_jobs import process_one, uuid_value, JobError

class Command(BaseCommand):
    help='Виконати обмежені кроки збережених імпортів каталогу.'
    def add_arguments(self,parser):
        parser.add_argument('--continuous',action='store_true',help='Працювати до SIGTERM/SIGINT, завершуючи поточний bounded пакет.')
        parser.add_argument('--poll-seconds',type=float,default=2,help='Технічна пауза між bounded кроками (0.5–60s).')
        parser.add_argument('--once',action='store_true')
        parser.add_argument('--run')
        parser.add_argument('--max-steps',type=int,default=1)
    def handle(self,*args,**options):
        if not 1<=options['max_steps']<=100000:raise CommandError('max-steps має бути 1–100000.')
        try:identifier=uuid_value(options['run']) if options['run'] else None
        except JobError as exc:raise CommandError(str(exc)) from exc
        if options['continuous']:
            if identifier is not None:raise CommandError('continuous обробляє всю чергу й не поєднується з run. Для одного імпорту використайте bounded режим.')
            if options['once'] or options['max_steps']!=1:raise CommandError('continuous не поєднується з once/max-steps.')
            if not .5<=options['poll_seconds']<=60:raise CommandError('poll-seconds має бути 0.5–60.')
            from server.erp.import_worker import ImportWorker
            ImportWorker(identifier=identifier,poll_seconds=options['poll_seconds'],output=self.stdout.write).run()
            return
        n=0
        for _ in range(1 if options['once'] else options['max_steps']):
            if not process_one(identifier):break
            n+=1
        self.stdout.write(f'Виконано кроків: {n}')
