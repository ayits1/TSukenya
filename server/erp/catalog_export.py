"""Complete filtered exchange CSV, scalar SQL in one fresh read snapshot.

Prepare a private bounded disk file before HTTP headers. A scalar/disk/deadline
refusal therefore cannot masquerade as a successful truncated CSV download.
No persistent export, global product graph, pricing cache or public baseline.
"""
import csv
import io
import tempfile
from itertools import islice
from decimal import Decimal,ROUND_HALF_UP
from django.http import FileResponse
from .catalog_budget import bounded,check
from .catalog_projection import projected_documents
from .catalog_selection import Selection,MAX_DISK
from .catalog import defaults,decimal,plain
from .catalog_schema import columns,schema
from .csv_format import MARKER,guarded
from .historical_reports import read_snapshot
from .services import require,current_actor
from .models import Document
from .promotion_prices import PriceResolver,context_store,kyiv_day


@bounded
def catalogue_csv(user,params):
    allowed={'includeHidden','visibility','store','q','type','category','pack','promotion'}
    require(not(set(params)-allowed) and all(len(params.getlist(key))==1 for key in params),'Некоректні параметри експорту.')
    require(len(params.get('q',''))<=250,'Пошук експорту задовгий.')
    hidden=params.get('includeHidden','false');require(hidden in {'true','false'},'Некоректний параметр прихованих товарів.')
    require(not(hidden=='true' and 'visibility' in params),'Виберіть один режим експорту прихованих товарів.')
    visibility=params.get('visibility','active');require(visibility in {'active','hidden'},'Некоректний стан експорту.')
    output=tempfile.TemporaryFile(mode='w+b',prefix='tsukenya-catalog-export-')
    text=io.StringIO(newline='');writer=csv.writer(text,delimiter=';',quoting=csv.QUOTE_ALL,lineterminator='\r\n')
    def row(values,*,first=False):
        check();text.seek(0);text.truncate(0)
        writer.writerow([('\t'+str(value)) if guarded(str(value)) else str(value) for value in values])
        encoded=(('\ufeff' if first else '')+text.getvalue()).encode('utf-8')
        require(output.tell()+len(encoded)<=MAX_DISK,'Експорт перевищує ліміт тимчасового диска. Зменшіть фільтр.')
        output.write(encoded)
    try:
        with read_snapshot():
            user=current_actor(user)
            require(not(hidden=='true' or visibility=='hidden') or user.profile.role=='owner','Приховані товари доступні для експорту лише власнику.')
            private=user.profile.role!='cashier';day=kyiv_day()
            with Selection(user,params,visibility,effective_day=day) as selected:
                config=selected.config;store=selected.store
                export_fields=columns(private=private);headers=[field['label'] for field in export_fields]
                headers[0]+=schema()['marker']+MARKER;row(headers,first=True)
                # Compatibility includeHidden=true exports both states, in the
                # original path order; current UI supplies explicit visibility.
                if hidden=='true':
                    require(not any(params.get(key) for key in ('q','type','category','pack','promotion')),'Для фільтрованого експорту виберіть явний стан товарів.')
                    paths=Document.objects.filter(path__startswith='products/').order_by('path').values_list('path',flat=True).iterator(chunk_size=200)
                else:paths=selected.iter_ids()
                try:
                    while batch:=list(islice(paths,200)):
                        check();documents={doc.path:doc for doc in projected_documents(batch)}
                        resolver=PriceResolver(config,store,day,product_paths=batch)
                        for path in batch:
                            check();document=documents[path];p=document.data;prices=resolver.resolve(document)
                            values={k:p.get(k,'') or '' for k in ('name','type','category','pack','size','unit','barcode')}
                            values.update(cost=format(decimal(p['cost']),'.2f') if p.get('cost') is not None else '',markup=plain(decimal(p['markup'])) if p.get('markup') is not None else '',
                                manualPrice='Ручна' if p.get('manualPrice') else 'Автоматична',
                                price=format(decimal(p.get('price')),'.2f') if p.get('manualPrice') and p.get('price') is not None else '',
                                promotion='Так' if p.get('promotion') else 'Ні',promotionPrice=format(decimal(p.get('promotionPrice')),'.2f') if p.get('promotionPrice') is not None else '',
                                regularPrice=prices['regularPrice'],salePrice=prices['salePrice'],effectivePromotion='Так' if prices['effectivePromotion'] else 'Ні',
                                per100=format((decimal(prices['salePrice'])/10).quantize(Decimal('.01'),rounding=ROUND_HALF_UP),'.2f') if p.get('unit')=='кг' else '',
                                priceAt=p.get('priceAt') or '',hidden='Так' if p.get('hidden') else 'Ні',id=path.split('/',1)[1])
                            row([values[field['key']] for field in export_fields])
                finally:paths.close()
                check()
        output.seek(0)
        result=FileResponse(output,content_type='text/csv; charset=utf-8',as_attachment=True,filename='catalogue.csv')
        result['Cache-Control']='private, no-store'
        return result
    except BaseException:output.close();raise
