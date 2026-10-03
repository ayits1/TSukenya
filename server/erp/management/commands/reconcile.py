import json
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from server.erp.reconcile import reconcile
class Command(BaseCommand):
    help='Read-only ledger reconciliation: stock lots, document totals, double posting, payroll and reversals. Exits non-zero on any mismatch.'
    def add_arguments(self,parser):parser.add_argument('--json',action='store_true',help='Print the report as JSON.')
    def handle(self,*args,**options):
        # Reads only; the rollback is a safeguard so that nothing can be saved even by mistake.
        # PostgreSQL: one REPEATABLE READ snapshot for all checks, and READ ONLY makes the database itself refuse writes. SQLite: one transaction is already a consistent snapshot.
        with transaction.atomic():
            if connection.vendor=='postgresql':
                with connection.cursor() as cursor:cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            report=reconcile();transaction.set_rollback(True)
        if options['json']:self.stdout.write(json.dumps(report,ensure_ascii=False,indent=2))
        else:
            c=report['counts'];self.stdout.write(f"Звірка регістрів (лише читання): партій {c['lots']}, документів {c['vouchers']}, складських рухів {c['stock_entries']}, грошових рухів {c['cash_entries']}.")
            for check in report['checks'].values():
                found=check['issues'];self.stdout.write(f"{'ПОМИЛКА' if found else 'OK'}  {check['title']}"+(f': {len(found)}' if found else ''))
                for x in found:self.stdout.write(f"  - [{x['subject']}] {x['message']}")
            self.stdout.write(f"Знайдено розбіжностей: {report['issues']}." if report['issues'] else 'Розбіжностей не знайдено.')
        if report['issues']:raise CommandError(f"Звірка виявила розбіжностей: {report['issues']}.")
