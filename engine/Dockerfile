FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MEHRAN_STUDIO_HOME=/data \
    MEHRAN_STUDIO_PORT=8765

WORKDIR /app
RUN groupadd --system --gid 10001 mehran && \
    useradd --system --uid 10001 --gid mehran --home-dir /data --no-create-home mehran && \
    mkdir -p /data && chown 10001:10001 /data

COPY --chown=10001:10001 engine/ /app/engine/
WORKDIR /app/engine
USER 10001:10001

EXPOSE 8765
CMD ["python", "server.py"]
