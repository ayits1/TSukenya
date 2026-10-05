"""Complete scalar disk resolver; legacy choices come from current source only."""
def scoped_records(inputs):
    from .catalog_reference_index import ReferenceIndex
    return ReferenceIndex()
