#!/bin/sh
set -eu
python manage.py migrate --noinput
python manage.py bootstrap --legacy /data/legacy-migration.sqlite3
exec gunicorn server.wsgi:application --no-control-socket --bind 0.0.0.0:8080 --workers 2 --threads 4 --timeout 60 --access-logfile - --error-logfile -
