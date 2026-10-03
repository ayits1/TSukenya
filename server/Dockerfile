FROM node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS frontend
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
COPY frontend/package.json frontend/package.json
COPY tools/api-contracts/package.json tools/api-contracts/package.json
RUN npm ci
COPY app/csv.js app/csv.js
COPY frontend/ frontend/
RUN npm run build:frontend

FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
RUN groupadd --gid 10001 tsukenya && useradd --uid 10001 --gid 10001 --no-create-home tsukenya
WORKDIR /app
COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ /app/app/
COPY server/ /app/server/
COPY manage.py /app/manage.py
COPY --from=frontend /build/frontend/dist /app/frontend/dist
COPY data/tovary-source-2026-09-29.csv /app/seed.csv
RUN chmod 755 /app/server/start.sh
ENV PYTHONUNBUFFERED=1 PORT=8080 DATA_DIR=/data TSUKENYA_REQUIRE_POSTGRES=1
EXPOSE 8080
USER 10001:10001
CMD ["/app/server/start.sh"]
