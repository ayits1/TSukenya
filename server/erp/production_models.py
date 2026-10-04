"""Approved immutable manufacturing terms; the document separately records actual quantities."""
import uuid
from django.conf import settings
from django.db import models

class RecipeVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey('erp.Document', on_delete=models.PROTECT, related_name='recipe_versions')
    version = models.PositiveIntegerField()
    name = models.CharField(max_length=250)
    unit = models.CharField(max_length=30)
    output_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    expiry_policy = models.CharField(max_length=32, choices=[('unspecified','Не визначено'),('components_min','Найраніша сировина'),('minimum_with_shelf_life','Сировина та технологічний строк')])
    shelf_life_days = models.PositiveIntegerField(null=True, blank=True)
    reason = models.CharField(max_length=500)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    approved_at = models.DateTimeField(auto_now_add=True)
    request_fingerprint = models.CharField(max_length=64)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['product','version'], name='recipe_product_version'), models.CheckConstraint(condition=models.Q(output_quantity__gt=0), name='recipe_output_positive')]

class RecipeComponent(models.Model):
    recipe = models.ForeignKey(RecipeVersion, on_delete=models.PROTECT, related_name='components')
    product = models.ForeignKey('erp.Document', on_delete=models.PROTECT, related_name='recipe_components')
    name = models.CharField(max_length=250)
    unit = models.CharField(max_length=30)
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    position = models.PositiveIntegerField()
    class Meta:
        constraints = [models.UniqueConstraint(fields=['recipe','product'], name='recipe_component_unique'), models.CheckConstraint(condition=models.Q(quantity__gt=0), name='recipe_component_positive')]

class ProductionInput(models.Model):
    """Frozen material identities also protect legacy drafts after the live recipe changes."""
    voucher = models.ForeignKey('erp.Voucher', on_delete=models.CASCADE, related_name='production_inputs')
    product = models.ForeignKey('erp.Document', on_delete=models.PROTECT)
    name = models.CharField(max_length=250)
    unit = models.CharField(max_length=30)
    expected_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    lot = models.CharField(max_length=80, blank=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['voucher','product'], name='production_input_unique'), models.CheckConstraint(condition=models.Q(quantity__gte=0), name='production_input_nonnegative')]
