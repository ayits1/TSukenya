FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
RUN groupadd --gid 10001 tsukenya && useradd --uid 10001 --gid 10001 --no-create-home tsukenya
WORKDIR /app
COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ /app/app/
COPY server/ /app/server/
COPY manage.py /app/manage.py
COPY data/tovary-source-2026-09-29.csv /app/seed.csv
RUN chmod 755 /app/server/start.sh
ENV PYTHONUNBUFFERED=1 PORT=8080 DATA_DIR=/data
EXPOSE 8080
USER 10001:10001
CMD ["/app/server/start.sh"]
