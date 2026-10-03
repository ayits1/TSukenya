import uuid
from django.db import models
from django.contrib.auth.models import User

class Document(models.Model):
    path = models.CharField(max_length=160, primary_key=True)
    data = models.JSONField(default=dict)

class Setting(models.Model):
    key = models.CharField(max_length=80, primary_key=True)
    value = models.TextField()

class PortalSession(models.Model):
    token_hash = models.CharField(max_length=64, primary_key=True)
    csrf = models.CharField(max_length=80)
    expires = models.BigIntegerField()
    user = models.ForeignKey(User, on_delete=models.CASCADE)

class LedgerLock(models.Model):
    """Single-company posting lock. All stock, cash and payroll posts share it."""
    closed_through = models.DateField(null=True, blank=True)

class Store(models.Model):
    name = models.CharField(max_length=160, unique=True)
    active = models.BooleanField(default=True)

class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    role = models.CharField(max_length=20, default='cashier')
    store = models.ForeignKey(Store, null=True, blank=True, on_delete=models.PROTECT)

class Warehouse(models.Model):
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    name = models.CharField(max_length=160)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['store', 'name'], name='warehouse_name_in_store')]

class Counterparty(models.Model):
    name = models.CharField(max_length=160)
    kind = models.CharField(max_length=20)
    phone = models.CharField(max_length=80, blank=True)
    email = models.EmailField(blank=True)
    notes = models.TextField(blank=True)
    active = models.BooleanField(default=True)

class CashAccount(models.Model):
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    name = models.CharField(max_length=160)
    kind = models.CharField(max_length=20, default='cash')
    class Meta:
        constraints = [models.UniqueConstraint(fields=['store', 'name'], name='account_name_in_store')]

class Employee(models.Model):
    name = models.CharField(max_length=160)
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    shift_rate = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    bonus_percent = models.DecimalField(max_digits=7, decimal_places=3, default=0)
    bonus_basis = models.CharField(max_length=20, default='store')
    active = models.BooleanField(default=True)

class CashShift(models.Model):
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    account = models.ForeignKey(CashAccount, on_delete=models.PROTECT)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT)
    opened_by = models.ForeignKey(User, on_delete=models.PROTECT)
    opened_at = models.DateTimeField(auto_now_add=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    opening_cash = models.DecimalField(max_digits=18, decimal_places=2)
    expected_cash = models.DecimalField(max_digits=18, decimal_places=2, null=True)
    counted_cash = models.DecimalField(max_digits=18, decimal_places=2, null=True)
    note = models.TextField(blank=True)

class Voucher(models.Model):
    KIND = [('purchase_order','Замовлення постачальнику'),('receipt','Надходження'),('opening','Початкові залишки'),('sale','Продаж'),('customer_return','Повернення покупця'),('supplier_return','Повернення постачальнику'),('transfer','Переміщення'),('writeoff','Списання'),('inventory','Інвентаризація'),('production','Виробництво'),('payment','Оплата боргу'),('expense','Витрата'),('cash_opening','Початкові кошти'),('payroll','Нарахування зарплати'),('payroll_payment','Виплата зарплати / аванс'),('customer_order','Замовлення покупця'),('debt_opening','Початкова заборгованість'),('cash_transfer','Переміщення коштів'),('cash_difference','Касове розходження')]
    kind = models.CharField(max_length=24, choices=KIND)
    status = models.CharField(max_length=12, default='draft')
    date = models.DateField()
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    warehouse = models.ForeignKey(Warehouse, null=True, blank=True, on_delete=models.PROTECT, related_name='+')
    target = models.ForeignKey(Warehouse, null=True, blank=True, on_delete=models.PROTECT, related_name='+')
    party = models.ForeignKey(Counterparty, null=True, blank=True, on_delete=models.PROTECT)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT)
    account = models.ForeignKey(CashAccount, null=True, blank=True, on_delete=models.PROTECT)
    shift = models.ForeignKey(CashShift, null=True, blank=True, on_delete=models.PROTECT)
    reference = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT)
    payload = models.JSONField(default=dict)
    total = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    cost = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    note = models.TextField(blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    posted_at = models.DateTimeField(null=True)
    reversed_at = models.DateTimeField(null=True)
    idempotency_key = models.CharField(max_length=80, unique=True, default=uuid.uuid4)
    class Meta:
        indexes = [models.Index(fields=['store', 'date', 'status']), models.Index(fields=['kind', 'status'])]

class VoucherLine(models.Model):
    voucher = models.ForeignKey(Voucher, on_delete=models.CASCADE, related_name='lines')
    product = models.ForeignKey(Document, on_delete=models.PROTECT)
    name = models.CharField(max_length=250)
    unit = models.CharField(max_length=30)
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    price = models.DecimalField(max_digits=18, decimal_places=4)
    amount = models.DecimalField(max_digits=18, decimal_places=2)
    cost = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    lot = models.CharField(max_length=80, blank=True)
    expiry = models.DateField(null=True, blank=True)
    reference_line = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT)

class StockLot(models.Model):
    warehouse = models.ForeignKey(Warehouse, on_delete=models.PROTECT)
    product = models.ForeignKey(Document, on_delete=models.PROTECT)
    code = models.CharField(max_length=80)
    expiry = models.DateField(null=True)
    quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    value = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['warehouse', 'product', 'code'], name='stock_lot_key'), models.CheckConstraint(condition=models.Q(quantity__gte=0), name='stock_nonnegative'), models.CheckConstraint(condition=models.Q(value__gte=0), name='stock_value_nonnegative')]

class StockEntry(models.Model):
    voucher = models.ForeignKey(Voucher, on_delete=models.PROTECT, related_name='stock_entries')
    lot = models.ForeignKey(StockLot, on_delete=models.PROTECT)
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    value = models.DecimalField(max_digits=18, decimal_places=2)
    is_reversal = models.BooleanField(default=False)

class CashEntry(models.Model):
    voucher = models.ForeignKey(Voucher, on_delete=models.PROTECT, related_name='cash_entries')
    account = models.ForeignKey(CashAccount, on_delete=models.PROTECT)
    amount = models.DecimalField(max_digits=18, decimal_places=2)
    is_reversal = models.BooleanField(default=False)

class WorkShift(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT)
    store = models.ForeignKey(Store, on_delete=models.PROTECT)
    date = models.DateField()
    cash_shift = models.ForeignKey(CashShift, null=True, blank=True, on_delete=models.PROTECT)
    units = models.DecimalField(max_digits=6, decimal_places=2, default=1)
    shift_rate = models.DecimalField(max_digits=14, decimal_places=2)
    bonus_percent = models.DecimalField(max_digits=7, decimal_places=3)
    bonus_basis = models.CharField(max_length=20)
    basis_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    accrued = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    payroll = models.ForeignKey(Voucher, null=True, blank=True, on_delete=models.PROTECT)
    note = models.TextField(blank=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['employee', 'date'], name='one_work_shift_per_employee_day')]

class AuditEvent(models.Model):
    at = models.DateTimeField(auto_now_add=True)
    user = models.ForeignKey(User, on_delete=models.PROTECT)
    action = models.CharField(max_length=40)
    subject = models.CharField(max_length=160)
    detail = models.JSONField(default=dict)

class LoginThrottle(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    attempts = models.PositiveIntegerField(default=0)
    until = models.BigIntegerField()
