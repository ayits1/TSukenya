import django.db.models.deletion
from django.db import migrations, models


def backfill(apps,schema_editor):
    Voucher=apps.get_model('erp','Voucher');Allocation=apps.get_model('erp','PaymentAllocation');alias=schema_editor.connection.alias
    pending=[]
    for v in Voucher.objects.using(alias).filter(kind='payment',reference__kind__in=['sale','receipt','debt_opening']).iterator():
        pending.append(Allocation(settlement_id=v.pk,payment_id=v.pk,source_id=v.reference_id,amount=v.total))
        if len(pending)==1000:
            Allocation.objects.using(alias).bulk_create(pending,batch_size=1000);pending=[]
    if pending:Allocation.objects.using(alias).bulk_create(pending,batch_size=1000)


class Migration(migrations.Migration):
    dependencies=[('erp','0008_promotion_campaigns')]
    operations=[
        migrations.CreateModel(name='PaymentAllocation',fields=[
            ('id',models.BigAutoField(auto_created=True,primary_key=True,serialize=False,verbose_name='ID')),
            ('amount',models.DecimalField(decimal_places=2,max_digits=18)),
            ('payment',models.ForeignKey(on_delete=django.db.models.deletion.RESTRICT,related_name='funded_allocations',to='erp.voucher')),
            ('settlement',models.ForeignKey(on_delete=django.db.models.deletion.CASCADE,related_name='allocation_entries',to='erp.voucher')),
            ('source',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,related_name='settlement_allocations',to='erp.voucher')),
        ],options={'constraints':[models.UniqueConstraint(fields=('settlement','source'),name='allocation_event_source'),models.CheckConstraint(condition=models.Q(amount__gt=0),name='allocation_amount_positive')]}),
        migrations.RunPython(backfill,migrations.RunPython.noop),
        migrations.AlterField(model_name='voucher',name='kind',field=models.CharField(max_length=24,choices=[('purchase_order','Замовлення постачальнику'),('receipt','Надходження'),('opening','Початкові залишки'),('sale','Продаж'),('customer_return','Повернення покупця'),('supplier_return','Повернення постачальнику'),('transfer','Переміщення'),('writeoff','Списання'),('inventory','Інвентаризація'),('production','Виробництво'),('payment','Платіж / аванс'),('advance_allocation','Використання авансу'),('payment_refund','Повернення авансу'),('expense','Витрата'),('cash_opening','Початкові кошти'),('payroll','Нарахування зарплати'),('payroll_payment','Виплата зарплати / аванс'),('customer_order','Замовлення покупця'),('debt_opening','Початкова заборгованість'),('cash_transfer','Переміщення коштів'),('cash_difference','Касове розходження')]))
    ]
