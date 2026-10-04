"""Durable bounded catalogue imports; technical plans/results never post inventory/cash."""
import uuid
from django.conf import settings
from django.db import models


def counts():return dict.fromkeys(('created','updated','skipped','conflicted','failed','invalid','pending'),0)
def planned():return dict.fromkeys(('create','update','skip'),0)


class CatalogImportRun(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    owner=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.PROTECT)
    mode=models.CharField(max_length=8,default='chunked')
    file_name=models.CharField(max_length=250,blank=True)
    expected_rows=models.PositiveIntegerField()
    uploaded_rows=models.PositiveIntegerField(default=0)
    input_bytes=models.PositiveIntegerField(default=0)
    metadata_hash=models.CharField(max_length=64)
    input_hash=models.CharField(max_length=64,blank=True)
    upload_hash=models.CharField(max_length=64,blank=True)
    plan_material=models.CharField(max_length=64,blank=True)
    default_markup=models.CharField(max_length=32,blank=True)
    source_hash=models.CharField(max_length=64,blank=True)
    generic_as=models.CharField(max_length=8,blank=True)
    pricing_config=models.JSONField(default=dict)
    pricing_revision=models.CharField(max_length=64,blank=True)
    plan_revision=models.CharField(max_length=64,blank=True)
    status=models.CharField(max_length=32,default='uploading')
    phase=models.CharField(max_length=16,default='uploading')
    phase_done=models.PositiveIntegerField(default=0)
    phase_total=models.PositiveIntegerField(default=0)
    catalog_cursor=models.CharField(max_length=160,blank=True)
    row_cursor=models.PositiveIntegerField(default=0)
    counts=models.JSONField(default=counts)
    planned=models.JSONField(default=planned)
    create_receipt=models.JSONField(default=dict)
    seal_receipt=models.JSONField(default=dict)
    apply_receipt=models.JSONField(default=dict)
    lease_token=models.UUIDField(null=True)
    lease_until=models.DateTimeField(null=True)
    error=models.JSONField(null=True)
    created_at=models.DateTimeField(auto_now_add=True)
    updated_at=models.DateTimeField(auto_now=True)
    started_at=models.DateTimeField(null=True)
    finished_at=models.DateTimeField(null=True)
    class Meta:
        indexes=[models.Index(fields=['owner','-created_at'],name='import_owner_history'),models.Index(fields=['status','lease_until'],name='import_worker_queue')]


class CatalogImportRow(models.Model):
    run=models.ForeignKey(CatalogImportRun,on_delete=models.CASCADE,related_name='rows')
    ordinal=models.PositiveIntegerField()
    line=models.PositiveIntegerField(null=True)
    input=models.JSONField(default=dict)
    input_hash=models.CharField(max_length=64)
    name_hash=models.CharField(max_length=64,blank=True)
    barcode=models.CharField(max_length=80,blank=True)
    status=models.CharField(max_length=16,default='uploaded')
    action=models.CharField(max_length=8,blank=True)
    product_path=models.CharField(max_length=160,blank=True)
    revision=models.CharField(max_length=64,blank=True)
    current_revision=models.CharField(max_length=64,blank=True)
    data=models.JSONField(default=dict)
    preview=models.JSONField(default=dict)
    effective_revision=models.CharField(max_length=64,blank=True)
    error=models.JSONField(null=True)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['run','ordinal'],name='import_row_ordinal')]
        indexes=[models.Index(fields=['run','line'],name='import_input_line'),models.Index(fields=['run','name_hash'],name='import_input_name'),models.Index(fields=['run','barcode'],name='import_input_barcode'),models.Index(fields=['run','status','ordinal'],name='import_pending_rows')]


class CatalogImportChunk(models.Model):
    run=models.ForeignKey(CatalogImportRun,on_delete=models.CASCADE)
    offset=models.PositiveIntegerField()
    digest=models.CharField(max_length=64)
    receipt=models.JSONField()
    class Meta:
        constraints=[models.UniqueConstraint(fields=['run','offset'],name='import_chunk_offset')]


class CatalogImportIndex(models.Model):
    run=models.ForeignKey(CatalogImportRun,on_delete=models.CASCADE)
    product_path=models.CharField(max_length=160)
    name_hash=models.CharField(max_length=64,blank=True)
    revision=models.CharField(max_length=64)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['run','product_path'],name='import_catalog_path')]
        indexes=[models.Index(fields=['run','name_hash'],name='import_catalog_name')]
