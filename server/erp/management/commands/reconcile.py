import json
import uuid
from django.utils import timezone
from server.erp import reconcile_journal as journal
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from server.erp.reconcile import reconcile
from server.erp.services import BusinessError
class Command(BaseCommand):
    help='Read-only ledger reconciliation: stock lots, document totals, double posting, payroll and reversals. Exits non-zero on any mismatch.'
    def add_arguments(self,parser):
        parser.add_argument('--json',action='store_true',help='Print the report as JSON.')
        parser.add_argument('--receipt-json',action='store_true',help='Print only the compact technical receipt; requires --record.')
        parser.add_argument('--record',action='store_true',help='Store a technical result after the read-only snapshot completes.')
        parser.add_argument('--run-id',help='Immutable technical receipt UUID; exact retries reuse the saved result.')
        parser.add_argument('--source',choices=['manual','scheduler'],default='manual')
    def handle(self,*args,**options):
        # Reads only; the rollback is a safeguard so that nothing can be saved even by mistake.
        # PostgreSQL: one REPEATABLE READ snapshot for all checks, and READ ONLY makes the database itself refuse writes. SQLite: one transaction is already a consistent snapshot.
        # A nested caller must already provide the same stable, read-only snapshot.
        # READ COMMITTED creates a different snapshot for every SELECT and is unsafe here.
        outermost=not connection.in_atomic_block
        if options['receipt_json'] and (not options['record'] or options['json']):raise CommandError('--receipt-json потребує --record і не поєднується з --json.')
        if options['run_id'] and not options['record']:raise CommandError('--run-id потребує --record.')
        if options['record'] and not outermost:raise CommandError('Журнал не записується всередині іншої транзакції.')
        run_id=options['run_id'] or str(uuid.uuid4())
        try: saved=journal.previous(run_id,options['source']) if options['record'] else None
        except BusinessError as error:raise CommandError(str(error)) from error
        except Exception as error:raise CommandError('Не вдалося прочитати підтвердження звірки.') from error
        if not outermost and connection.vendor=='postgresql':
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');isolation=cursor.fetchone()[0]
                cursor.execute('SHOW transaction_read_only');read_only=cursor.fetchone()[0]
            if isolation not in {'repeatable read','serializable'} or read_only!='on':
                raise CommandError('Звірка всередині транзакції PostgreSQL потребує REPEATABLE READ або SERIALIZABLE та READ ONLY. Запустіть команду поза поточною транзакцією.')
        if saved:
            report=journal.saved_report(saved)
        else:
            started=timezone.now()
            try:
                with transaction.atomic():
                    if outermost and connection.vendor=='postgresql':
                        with connection.cursor() as cursor:cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                    report=reconcile();transaction.set_rollback(True)
            except Exception as error:
                if not options['record']:raise
                report={'checks':{},'issues':0,'counts':{},'error':'snapshot_failed'}
                saved=journal.record(run_id,options['source'],report,started,timezone.now(),'snapshot_failed')
                report=journal.saved_report(saved)
            if options['record'] and saved is None:
                saved=journal.record(run_id,options['source'],report,started,timezone.now())
                report=journal.saved_report(saved)
        if options['record']:self.stderr.write(f'Журнал звірки: {saved.pk}.')
        if options['receipt_json']:
            self.stdout.write(json.dumps({'contract':'reconciliation-receipt-v1','id':str(saved.pk),'source':saved.source,'status':saved.status,'checksVersion':saved.checks_version,'issues':saved.issue_count},separators=(',',':')))
            if saved.status != 'clean':raise CommandError('Звірка потребує уваги; дивіться технічний журнал.')
            return
        if saved and saved.error_code:raise CommandError('Запуск звірки не завершено; облік не виправлявся. Для нової спроби використайте новий ID.')
        if options['json']:self.stdout.write(json.dumps(report,ensure_ascii=False,indent=2))
        else:
            c=report['counts'];self.stdout.write(f"Звірка регістрів (лише читання): партій {c['lots']}, документів {c['vouchers']}, складських рухів {c['stock_entries']}, грошових рухів {c['cash_entries']}.")
            for check in report['checks'].values():
                found=check['issues'];self.stdout.write(f"{'ПОМИЛКА' if found else 'OK'}  {check['title']}"+(f': {len(found)}' if found else ''))
                for x in found:self.stdout.write(f"  - [{x['subject']}] {x['message']}")
            coverage=report.get('coverage')
            if coverage:
                self.stdout.write(f"Покриття хронології: відомих операцій {coverage['known_operations']}, невідомих {coverage['unknown_operations']}; некоректних подій періоду {coverage['invalid_period_events']}; заблокованих чернеток {coverage['protected_drafts']} (не доказ незаконного проведення).")
            self.stdout.write(f"Знайдено розбіжностей: {report['issues']}." if report['issues'] else 'Розбіжностей не знайдено.')
        if report['issues']:raise CommandError(f"Звірка виявила розбіжностей: {report['issues']}.")
