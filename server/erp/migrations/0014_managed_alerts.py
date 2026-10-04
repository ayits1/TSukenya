from django.conf import settings
from django.db import migrations,models
import django.db.models.deletion

class Migration(migrations.Migration):
    dependencies=[('erp','0013_idea_projects'),migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations=[migrations.CreateModel(name='AlertTaskAction',fields=[
        ('id',models.UUIDField(primary_key=True,editable=False,serialize=False)),
        ('fingerprint',models.CharField(max_length=64)),
        ('applied_revision',models.CharField(max_length=32)),
        ('cycle',models.PositiveIntegerField()),
        ('created_at',models.DateTimeField(auto_now_add=True)),
        ('author',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,to=settings.AUTH_USER_MODEL)),
        ('task',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,to='erp.document')),
    ])]
