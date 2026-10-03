"""Promotion rules and price history are separate from raw legacy product fields."""
import uuid
from django.conf import settings
from django.db import models


class PromotionCampaign(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=160)
    starts_on = models.DateField()
    ends_on = models.DateField()
    active = models.BooleanField(default=True)
    archived = models.BooleanField(default=False)
    scope = models.CharField(max_length=12, default='network')
    stores = models.ManyToManyField('erp.Store', blank=True)
    reason = models.CharField(max_length=500)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_fingerprint = models.CharField(max_length=64)
    revision = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class PromotionPrice(models.Model):
    campaign = models.ForeignKey(PromotionCampaign, on_delete=models.CASCADE, related_name='prices')
    product = models.ForeignKey('erp.Document', on_delete=models.PROTECT)
    price = models.DecimalField(max_digits=14, decimal_places=2)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['campaign', 'product'], name='campaign_product_price'),
                       models.CheckConstraint(condition=models.Q(price__gt=0), name='campaign_price_positive')]


class PriceObservation(models.Model):
    """Last observed price terms for one product/context; reads never write this register."""
    key = models.CharField(max_length=200, primary_key=True)
    product_path = models.CharField(max_length=160)
    store = models.ForeignKey('erp.Store', null=True, blank=True, on_delete=models.PROTECT)
    terms = models.JSONField(default=dict)
    observed_at = models.DateTimeField(auto_now=True)


class PriceChange(models.Model):
    # A retained path keeps history readable after an unused product is removed.
    product_path = models.CharField(max_length=160, db_index=True)
    store = models.ForeignKey('erp.Store', null=True, blank=True, on_delete=models.PROTECT)
    before = models.JSONField(default=dict)
    after = models.JSONField(default=dict)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    source = models.CharField(max_length=80)
    reason = models.CharField(max_length=500)
    at = models.DateTimeField(auto_now_add=True)
