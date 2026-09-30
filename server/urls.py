from django.urls import re_path
from server.erp.views import portal
urlpatterns = [re_path(r'^.*$', portal)]
