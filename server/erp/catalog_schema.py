"""Catalogue exchange metadata. Price arithmetic and write policy stay in domain services."""
import json
from functools import lru_cache
from pathlib import Path
from django.http import FileResponse
from .services import require

ROOT=Path(__file__).resolve().parents[2]

@lru_cache(maxsize=1)
def schema():
    return json.loads((ROOT/'contracts/catalog-exchange.schema.json').read_text())

def columns(profile='export',private=True):
    definition=schema();fields={f['key']:f for f in definition['fields']}
    return [fields[key] for key in definition['profiles'][profile]['keys'] if private or not fields[key]['private']]

def template(user,params):
    from .catalog import EDIT_ROLES
    from .historical_reports import read_snapshot
    from .services import current_actor
    require(not params,'Шаблон не приймає параметрів.')
    with read_snapshot():
        user=current_actor(user)
        require(user.profile.role in EDIT_ROLES,'Недостатньо прав для шаблону імпорту.')
        response=FileResponse((ROOT/'data/catalogue-template-v1.xlsx').open('rb'),as_attachment=True,filename='catalogue-template-v1.xlsx')
        response['Cache-Control']='private, no-store'
        return response
