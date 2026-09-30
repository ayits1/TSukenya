"""Local development entrypoint; production runs Gunicorn / Django WSGI."""
import os
from pathlib import Path
from server.auth import hash_password, valid_password

if __name__ == '__main__':
    data = Path(os.environ.get('DATA_DIR', 'storage'))
    data.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('ERP_DB_PATH', str(data / 'crm.sqlite3'))
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
    import django
    django.setup()
    from django.core.management import call_command
    call_command('migrate', interactive=False, verbosity=0)
    call_command('bootstrap')
    call_command('runserver', f"{os.environ.get('HOST','127.0.0.1')}:{os.environ.get('PORT','8080')}", use_reloader=False)
