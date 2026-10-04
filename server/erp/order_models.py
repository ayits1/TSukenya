"""Order control and physical stock holds; no accounting entries are created here."""
from django.conf import settings
from django.db import models


class OrderControl(models.Model):
    order = models.OneToOneField('erp.Voucher', primary_key=True, on_delete=models.PROTECT, related_name='order_control')
    revision = models.PositiveIntegerField(default=1)
    closed_at = models.DateTimeField(null=True)
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT)
    reason = models.TextField(blank=True)
    expected_date = models.DateField(null=True)
    minimum_amount = models.DecimalField(max_digits=18, decimal_places=2, null=True)


class StockReservation(models.Model):
    order_line = models.ForeignKey('erp.VoucherLine', on_delete=models.PROTECT, related_name='reservations')
    lot = models.ForeignKey('erp.StockLot', on_delete=models.PROTECT, related_name='reservations')
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_on = models.DateField()
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    used = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    released = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(quantity__gt=0,used__gte=0,released__gte=0,quantity__gte=models.F('used')+models.F('released')),name='reservation_quantities_valid')]
        indexes = [models.Index(fields=['lot','expires_on'], name='reservation_lot_expiry')]


class ReservationUse(models.Model):
    reservation = models.ForeignKey(StockReservation, on_delete=models.PROTECT, related_name='uses')
    line = models.ForeignKey('erp.VoucherLine', on_delete=models.PROTECT, related_name='reservation_uses')
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    reversed_at = models.DateTimeField(null=True)
    released_on_reverse = models.BooleanField(default=False)
    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(quantity__gt=0),name='reservation_use_positive')]


class OrderOperation(models.Model):
    key = models.UUIDField(primary_key=True)
    order = models.ForeignKey('erp.Voucher', on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    payload_hash = models.CharField(max_length=64)
    result = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)
