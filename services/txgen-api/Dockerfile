FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install uv --quiet
COPY packages/ ./packages/
COPY services/txgen-api/pyproject.toml ./pyproject.toml
RUN uv pip install --system -e packages/models -e packages/iso_mapper -r pyproject.toml

FROM python:3.12-slim AS runtime
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=builder /usr/local/bin /usr/local/bin
COPY packages/ ./packages/
COPY services/txgen-api/src/ ./src/
ENV PYTHONUNBUFFERED=1
RUN useradd --no-create-home txgen && chown -R txgen /app
USER txgen
EXPOSE 8002
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8002"]
