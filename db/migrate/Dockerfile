# Runs copy_telemetry.py: psycopg (pure Python) over trixie's libpq/OpenSSL 3.5, so the connection to
# the 4.41 store negotiates X25519MLKEM768 like the receiver does.
FROM python:3.12.14-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir psycopg==3.3.6
COPY copy_telemetry.py /usr/local/bin/copy_telemetry.py
ENTRYPOINT ["python", "/usr/local/bin/copy_telemetry.py"]
