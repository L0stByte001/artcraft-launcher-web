FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/artcraft

COPY server.py /opt/artcraft/updater/server.py

RUN useradd --system --uid 10001 --no-create-home artcraft

EXPOSE 8090

CMD ["python3", "/opt/artcraft/updater/server.py"]
