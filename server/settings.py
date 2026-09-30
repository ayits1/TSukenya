import os
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'local-development-only-not-for-production')
DEBUG = os.environ.get('DEBUG', '') == '1'
ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', 'tsukernya.pp.ua,www.tsukernya.pp.ua,localhost,127.0.0.1,testserver').split(',')
INSTALLED_APPS = ['django.contrib.auth', 'django.contrib.contenttypes', 'server.erp']
MIDDLEWARE = ['server.erp.middleware.PortalMiddleware']
ROOT_URLCONF = 'server.urls'
WSGI_APPLICATION = 'server.wsgi.application'
if os.environ.get('DB_HOST'):
    if len(os.environ.get('DJANGO_SECRET_KEY','')) < 50:
        raise RuntimeError('A private DJANGO_SECRET_KEY is required for PostgreSQL deployments.')
    DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'HOST': os.environ['DB_HOST'], 'PORT': os.environ.get('DB_PORT', '5432'), 'NAME': os.environ.get('DB_NAME', 'tsukenya'), 'USER': os.environ.get('DB_USER', 'tsukenya'), 'PASSWORD': os.environ['DB_PASSWORD'], 'CONN_MAX_AGE': 60}}
else:
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': os.environ.get('ERP_DB_PATH', str(BASE_DIR / 'storage' / 'crm.sqlite3')), 'OPTIONS': {'timeout': 30}}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
LANGUAGE_CODE = 'uk'
TIME_ZONE = 'Europe/Kyiv'
USE_TZ = True
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
DATA_UPLOAD_MAX_MEMORY_SIZE = 1048576
PASSWORD_HASHERS = ['django.contrib.auth.hashers.ScryptPasswordHasher', 'django.contrib.auth.hashers.PBKDF2PasswordHasher']
