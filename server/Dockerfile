FROM python:3.12-slim
RUN groupadd --gid 10001 tsukenya && useradd --uid 10001 --gid 10001 --no-create-home tsukenya
WORKDIR /app
COPY app/ /app/app/
COPY server/ /app/server/
COPY data/tovary-source-2026-09-29.csv /app/seed.csv
ENV PYTHONUNBUFFERED=1 PORT=8080 DATA_DIR=/data
EXPOSE 8080
USER 10001:10001
CMD ["python", "-m", "server.main"]
