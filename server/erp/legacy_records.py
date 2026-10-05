"""Versioned existing portal records; create receipts and managed lifecycle stay separate."""
import re
from django.contrib.auth.models import User
from .models import Document, IdeaProject, ProjectTask
from .services import require, Conflict, dec
from .managed_alerts import task_revision
from .task_scope import task_visible, task_permissions, alert_task
from .financial_scope import require_network_owner
from .historical_reports import read_snapshot
RESOURCES={'tasks','ideas','expenses'}
FIELDS={'tasks':{'title','status','dueDate','stage'},'ideas':{'title','text','reaction'},'expenses':{'name','group','category','amount'}}


def recovery_context(user, params):
    """Authorize a local editable snapshot without adopting a current revision.

    Missing records are an observation, not a deletion receipt. The supplied
    historical scope authorizes only the client's local fields, never a write.
    """
    require(set(params) <= {'collection', 'id', 'scope', 'store', 'ideaId'}, 'Некоректний контекст чернетки.')
    collection = params.get('collection')
    identifier = params.get('id') or None
    scope = params.get('scope') or None
    store = params.get('store') or None
    idea = params.get('ideaId') or None
    require(collection in RESOURCES, 'Невідомий тип чернетки.')
    require(identifier is None or re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier), 'Некоректний ID.')
    require(scope in {None, 'operations', 'development'}, 'Некоректний простір задачі.')
    require(store is None or isinstance(store, str) and re.fullmatch(r'[1-9][0-9]{0,18}', store) and int(store) <= 9223372036854775807, 'Некоректний магазин.')
    require(idea is None or re.fullmatch(r'[A-Za-z0-9_-]{1,120}', idea), 'Некоректна початкова ідея.')
    require(collection == 'tasks' or scope is None and store is None and idea is None, 'Некоректний контекст колекції.')
    with read_snapshot():
        from .services import current_actor
        user = current_actor(user)
        from .legacy_create_identity import authorize
        authorize(user, collection)
        metadata = {'scope': scope, 'store': int(store) if store else None, 'ideaId': idea}
        if collection == 'tasks':
            from .task_scope import authorize_task
            authorize_task(user, metadata)
            if idea:
                source = read_record(user, 'ideas', idea)
                require(source['initiative'] is None, 'Ідея змінюється в окремому робочому процесі.')
        exists = None
        writable = True
        if identifier:
            try:
                current = read_record(user, collection, identifier)
            except Conflict as error:
                if error.code != 'record_missing':
                    raise
                if collection == 'tasks' and user.profile.role != 'owner':
                    from .models import LegacyCreateReceipt
                    witness = LegacyCreateReceipt.objects.filter(document_path='tasks/' + identifier, collection='tasks').values_list('original', flat=True).first()
                    require(isinstance(witness, dict) and isinstance(witness.get('data'), dict), 'Немає доказу початкового магазину відсутньої задачі; доступ до локальної чернетки недоступний.')
                    authorize_task(user, witness['data'])
                exists = False
                writable = False
            else:
                exists = True
                writable = current['permissions']['canEdit'] and not current['managed'] and current['initiative'] is None
        return {'collection': collection, 'id': identifier, 'scope': scope,
                'store': metadata['store'], 'ideaId': idea, 'exists': exists,
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
                'canWrite': bool(writable)}


def read_record(user,collection,identifier):
    require(collection in RESOURCES and re.fullmatch(r'[A-Za-z0-9_-]{1,120}',identifier),'Некоректний запис.')
    with read_snapshot():
        user=User.objects.select_related('profile').filter(pk=user.pk,is_active=True).first()
        require(user is not None,'Недостатньо прав.')
        if collection=='expenses':require_network_owner(user)
        doc=Document.objects.filter(pk=collection+'/'+identifier).first()
        if doc is None:raise Conflict('Запис більше недоступний. Чернетка збережена.','record_missing')
        data=dict(doc.data)
        if collection=='tasks':
            require(task_visible(user,data),'Задача недоступна.')
            permissions=task_permissions(user,doc.path,data)
        else:
            require(user.profile.role=='owner' or collection=='ideas' and data.get('scope')=='operations','Запис недоступний.')
            permissions={'canEdit':user.profile.role=='owner','canDelete':user.profile.role=='owner'}
        link=ProjectTask.objects.filter(document=doc).select_related('project').first() if collection=='tasks' else None
        project=link.project if link else IdeaProject.objects.filter(idea=doc).first() if collection=='ideas' else None
        initiative=None
        if project:
            from .initiatives import access
            access(user,project)
            initiative=str(project.pk)
            permissions['canDelete']=False
            if link:permissions['canEdit']=False
        managed=collection=='tasks' and alert_task(doc.path,data)
        if managed:permissions={'canEdit':False,'canDelete':False}
        if collection=='expenses' and 'amount' in data:
            from .budget import validate_expense
            validated=validate_expense(data)
            data['amount']=str(dec(validated['amount']))
        return {'collection':collection,'id':identifier,'revision':task_revision(doc),'data':data,'permissions':permissions,'managed':managed,'initiative':initiative}


def validate_patch(collection,patch,previous):
    require(isinstance(patch,dict) and not(set(patch)-FIELDS[collection]),'Змінюйте лише поля редактора.')
    value={**previous,**patch}
    if collection=='tasks':
        if 'title' in patch:require(isinstance(patch['title'],str) and 1<=len(patch['title'].strip())<=250,'Назва задачі: від 1 до 250 символів.');value['title']=patch['title'].strip()
        if 'dueDate' in patch:
            due=patch['dueDate'];require(due is None or isinstance(due,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',due),'Оберіть дату терміну задачі.')
            if due is not None:
                from .services import day
                day(due)
        if 'stage' in patch:require(previous.get('scope') in (None,'development') and type(patch['stage']) is int and 1<=patch['stage']<=4,'Оберіть етап розвитку від 1 до 4.')
    if collection=='ideas':
        for field,maxlength in [('title',250),('text',4000)]:
            if field in patch:require(isinstance(patch[field],str) and len(patch[field])<=maxlength and (field!='title' or patch[field].strip()),'Перевірте назву та опис ідеї.')
        if 'reaction' in patch:require(patch['reaction'] is None or isinstance(patch['reaction'],str) and patch['reaction'] in {'yes','no'},'Оберіть реакцію на ідею.')
        if 'title' in patch:value['title']=patch['title'].strip()
    if collection=='expenses' and 'amount' in patch and isinstance(patch['amount'],str):
        require(re.fullmatch(r'\d{1,8}(?:\.\d{1,2})?',patch['amount']) is not None,'Вкажіть суму з точністю до копійок.')
        from .services import dec
        value['amount']=float(dec(patch['amount'],'Сума витрати'))
    return value
