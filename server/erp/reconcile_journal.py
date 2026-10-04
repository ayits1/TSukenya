"""Persist a completed read-only snapshot in a separate technical transaction."""
import hashlib
import json
import uuid
from django.db import connection, transaction, IntegrityError
from django.utils import timezone
from django.db.models.functions import TruncDate
from zoneinfo import ZoneInfo
from .models import ReconciliationRun, ReconciliationFinding
from .financial_scope import require_network_owner
from .services import require, BusinessError
from .browsing import page_number, page_bounds
from .financial_browsing import date_filter

CHECKS_VERSION = 1
SOURCES = {'manual', 'scheduler'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def key(value):
    try: return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError): raise BusinessError('Некоректний ID звірки.')


def fingerprint(source):
    require(source in SOURCES, 'Невідоме джерело звірки.')
    return digest({'source': source, 'checks_version': CHECKS_VERSION})


def previous(run_id, source):
    result = ReconciliationRun.objects.filter(pk=key(run_id)).first()
    if result:
        require(result.intent_hash == fingerprint(source), 'ID звірки вже використано іншим запитом.')
    return result


def saved_report(run):
    result = json.loads(json.dumps(run.summary))
    for name, check in result.get('checks', {}).items():
        check.pop('issues_count', None)
        check['issues'] = []
    for row in run.findings.order_by('ordinal'):
        result['checks'][row.check_name]['issues'].append({'check': row.check_name, 'subject': row.subject, 'message': row.message, 'expected': row.expected, 'actual': row.actual})
    return result


def record(run_id, source, report, started_at, finished_at, error_code=''):
    require(not connection.in_atomic_block, 'Журнал звірки записується лише після завершення транзакції знімка.')
    intent = fingerprint(source)
    existing = previous(run_id, source)
    if existing: return existing
    summary = json.loads(json.dumps(report))
    findings = []
    for name, check in summary.get('checks', {}).items():
        for row in check.pop('issues', []):
            findings.append(ReconciliationFinding(ordinal=len(findings)+1, check_name=name, subject=row['subject'], message=row['message'], expected=row.get('expected'), actual=row.get('actual')))
        check['issues_count'] = sum(1 for row in findings if row.check_name == name)
    try:
        with transaction.atomic():
            run = ReconciliationRun.objects.create(id=key(run_id), intent_hash=intent, report_hash=digest(report), source=source,
                status='failed' if error_code else 'discrepancies' if report['issues'] else 'clean', started_at=started_at,
                finished_at=finished_at, summary=summary, issue_count=len(findings), error_code=error_code)
            for row in findings: row.run = run
            ReconciliationFinding.objects.bulk_create(findings, batch_size=200)
        return run
    except IntegrityError:
        winner = previous(run_id, source)
        if winner is None: raise
        return winner


def run_json(run):
    return {'id': str(run.pk), 'source': run.source, 'status': run.status, 'checksVersion': run.checks_version,
            'startedAt': run.started_at.isoformat(), 'finishedAt': run.finished_at.isoformat(), 'recordedAt': run.recorded_at.isoformat(),
            'issues': run.issue_count, 'reportHash': run.report_hash, 'summary': run.summary, 'errorCode': run.error_code or None}


def runs(user, params):
    require_network_owner(user)
    query = ReconciliationRun.objects.annotate(local_day=TruncDate('recorded_at', tzinfo=ZoneInfo('Europe/Kyiv')))
    query = date_filter(query, params, 'local_day')
    for field, choices in [('status', {'clean', 'discrepancies', 'failed'}), ('source', SOURCES)]:
        value = params.get(field)
        if value:
            require(value in choices, 'Некоректний фільтр звірки.')
            query = query.filter(**{field: value})
    total = query.count(); page, pages, offset = page_bounds(total, page_number(params))
    return {'items': [run_json(row) for row in query.order_by('-recorded_at', '-pk')[offset:offset+30]], 'total': total, 'page': page, 'pages': pages}


def detail(user, run_id):
    require_network_owner(user)
    run = ReconciliationRun.objects.filter(pk=key(run_id)).first()
    require(run is not None, 'Запис звірки не знайдено.')
    return run


def findings(user, run_id, params):
    run = detail(user, run_id)
    query = run.findings.order_by('ordinal')
    if params.get('check'):
        require(params['check'] in run.summary.get('checks', {}), 'Невідома перевірка.')
        query = query.filter(check_name=params['check'])
    total = query.count(); requested = page_number(params)
    pages = max(1, (total+99)//100); page = min(requested, pages); offset = (page-1)*100
    return {'items': [{'ordinal': row.ordinal, 'check': row.check_name, 'subject': row.subject, 'message': row.message, 'expected': row.expected, 'actual': row.actual} for row in query[offset:offset+100]], 'total': total, 'page': page, 'pages': pages}
