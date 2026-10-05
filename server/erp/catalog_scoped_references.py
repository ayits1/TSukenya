"""Existing dictionary semantics with only the current request's legacy keys.

This is a bounded-memory scalar catalogue scan, not an indexed/O(1) lookup.
Unlike import ReferenceScope, new arbitrary text is never registered as a choice.
The path-ordered first legacy caption and explicit alias/archive rules stay intact.
"""
from time import monotonic
from .catalog_references import FIELDS, clean, find_reference, follow, identity, keys, legacy_item, reference_records
from .catalog_selection import BATCH, MAX_SECONDS, scalar_rows
from .models import Document
from .services import require


class ScopedRecords(dict):
    """Sort/index once per request, preserving exact-before-alias precedence."""
    def __init__(self, records):
        super().__init__(records)
        self.canonical, self.aliases = {}, {}
        for item in sorted(self.values(), key=lambda item: item['state'] != 'active'):
            self.canonical.setdefault(identity(item['field'], item['value'], item['parentType']), item)
            for key in keys(item): self.aliases.setdefault(key, item)

    def lookup(self, field, text, parent=''):
        key = identity(field, text, parent)
        item = self.canonical.get(key) or self.aliases.get(key)
        return follow(item, self) or item


def scoped_records(inputs):
    explicit, size = [], 0
    from .catalog_import import canonical
    from .catalog_snapshot import bounded_documents
    for document in bounded_documents(Document.objects.filter(path__startswith='catalog_refs/').order_by('path'), limit=5001, total_limit=2097152):
        size += len(canonical(document.data).encode())
        require(len(explicit) < 5000 and size <= 2097152, 'Довідники перевищують ліміт 5000 записів / 2 МіБ для цього запиту.')
        explicit.append(document)
    explicit_records = ScopedRecords(reference_records(explicit_records=explicit, legacy_values=[]))
    wanted, stored_ids, category_contexts = set(), set(), []
    for data in inputs:
        if not isinstance(data, dict): continue
        parent = data.get('type', '')
        parent = parent if isinstance(parent, str) else ''
        group = find_reference(explicit_records, 'type', parent) if parent else None
        parents = {parent, group['value'] if group else parent}
        for field, maximum in FIELDS.items():
            text = data.get(field)
            if not isinstance(text, str) or not clean(text) or len(clean(text)) > maximum: continue
            for context in parents if field == 'category' else ('',):
                wanted.add(identity(field, text, context))
            if field == 'category':
                for context in parents:
                    if clean(context): wanted.add(identity('type', context))
        bindings = data.get('referenceIds')
        if isinstance(bindings, dict):
            stored_ids.update(value for value in bindings.values() if isinstance(value, str))
            if isinstance(data.get('category'), str) and isinstance(bindings.get('type'), str):
                category_contexts.append((data['category'], bindings['type']))
    require(len(wanted) <= 12000 and len(stored_ids) <= 5000, 'Вибір містить забагато довідникових значень. Зменшіть запит.')
    stored_ids.difference_update(explicit_records)
    selected, retained_bytes, seen = [], 0, set()
    started = monotonic()
    def scan():
        nonlocal retained_bytes
        rows = scalar_rows(Document.objects.filter(path__startswith='products/'), tuple(FIELDS)).iterator(chunk_size=BATCH)
        try:
            for path, data in rows:
                require(monotonic() - started < MAX_SECONDS, 'Перевірка довідників перевищила ліміт часу. Повторіть менший запит.')
                require(data is not None, 'Довідникові поля товару перевищують ліміт 64 КіБ. Виправте запис перед збереженням.')
                parent = data.get('type', '')
                parent = parent if isinstance(parent, str) else ''
                retained = {}
                for field, maximum in FIELDS.items():
                    text = data.get(field)
                    if not isinstance(text, str) or not clean(text) or len(clean(text)) > maximum: continue
                    key = identity(field, text, parent)
                    if key in seen: continue
                    if key in wanted or stored_ids and legacy_item(field, text, parent)['id'] in stored_ids:
                        retained[field] = text
                        seen.add(key)
                if retained:
                    # Category identity requires the raw parent's spelling, even when
                    # its group is explicitly claimed and therefore not a legacy row.
                    if 'category' in retained: retained['type'] = parent
                    retained_bytes += len(canonical(retained).encode())
                    require(len(selected) < 12000 and retained_bytes <= 16777216, 'Перевірка довідників перевищила ліміт запиту. Зменшіть вибір.')
                    selected.append(Document(path=path, data=retained))
        finally:
            rows.close()
    scan()
    records = reference_records(explicit_records=explicit, legacy_values=selected)
    extra = set()
    for text, stored in category_contexts:
        group = follow(records.get(stored), records) or records.get(stored)
        if group and group['field'] == 'type': extra.add(identity('category', text, group['value']))
    # A historical stored group ID may intentionally differ from its raw caption.
    # Binding changes the category's parent; discover that exact key on one second
    # scalar pass rather than inventing a new choice or keeping all global groups.
    if extra - wanted:
        wanted.update(extra)
        require(len(wanted) <= 12000, 'Вибір містить забагато довідникових значень. Зменшіть запит.')
        scan()
        records = reference_records(explicit_records=explicit, legacy_values=selected)
    return ScopedRecords(records)
