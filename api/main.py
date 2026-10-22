"""Ejecutar desde la raíz: python -m uvicorn api.main:app --host 127.0.0.1 --port 8000."""
from contextlib import asynccontextmanager
import csv
import io
import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from .schemas import Transaction, BatchRequest, Prediction, BatchResponse
from .service import ModelService, ModelUnavailable, ROOT

MAX_CSV_BYTES = 2 * 1024 * 1024
CSV_FIELDS = {'type', 'amount', 'oldbalanceOrg', 'oldbalanceDest'}


def create_app(service: ModelService | None = None) -> FastAPI:
    model_service = service or ModelService()

    @asynccontextmanager
    async def lifespan(app):
        model_service.load()
        if model_service.error:
            logging.getLogger(__name__).warning('No se cargó el modelo: %s', model_service.error)
        yield

    app = FastAPI(title='Umbral · API de detección de fraude', version='1.0.0', lifespan=lifespan,
                  description='Árbol de decisión con siete variables derivadas. Umbral fijo 0,50. Proyecto académico con datos sintéticos.')
    app.state.model_service = model_service

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # No copiar input: NaN/Infinity no se pueden serializar en JSON estándar.
        errors = [{key: error[key] for key in ('loc', 'msg', 'type')} for error in exc.errors()]
        return JSONResponse(status_code=422, content={'detail': errors})

    def run(rows):
        try:
            return model_service.predict(rows)
        except ModelUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get('/api/health', tags=['Modelo'])
    def health():
        return {'status': 'ok' if model_service.model is not None else 'model_unavailable',
                'model_ready': model_service.model is not None}

    @app.get('/api/model', tags=['Modelo'])
    def model():
        if model_service.report is None:
            raise HTTPException(503, 'Modelo no disponible. Entrená el modelo y reiniciá la API.')
        r = model_service.report
        return {k: r[k] for k in ['model_version', 'trained_at', 'config', 'features', 'tree', 'input_ranges', 'limitations']}

    @app.get('/api/model/tree', tags=['Modelo'])
    def tree_preview():
        """Primeros tres niveles del árbol entrenado, con reglas y conteos de entrenamiento."""
        try:
            return model_service.tree_preview()
        except ModelUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.get('/api/metrics', tags=['Modelo'])
    def metrics():
        if model_service.report is None:
            raise HTTPException(503, 'Todavía no hay métricas. Ejecutá train.py y reiniciá la API.')
        return model_service.report

    @app.get('/api/examples', tags=['Modelo'])
    def examples():
        if model_service.report is None:
            raise HTTPException(503, 'Modelo no disponible.')
        return model_service.report['examples']

    @app.post('/api/predict', response_model=Prediction, tags=['Predicciones'])
    def predict(transaction: Transaction):
        return run([transaction.model_dump()])[0]

    @app.post('/api/predict/batch', response_model=BatchResponse, tags=['Predicciones'])
    def predict_batch(batch: BatchRequest):
        results = run([t.model_dump() for t in batch.transactions])
        return {'results': results, 'total': len(results), 'alerts': sum(r['prediction'] for r in results)}

    @app.post('/api/predict/csv', response_model=BatchResponse, tags=['Predicciones'])
    async def predict_csv(request: Request):
        """Cuerpo CSV UTF-8 (text/csv). Hasta 1000 filas y 2 MiB. Validación atómica."""
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_CSV_BYTES:
                raise HTTPException(413, 'El CSV supera el límite de 2 MiB.')
        try:
            text = body.decode('utf-8-sig')
            reader = csv.DictReader(io.StringIO(text, newline=''), strict=True)
            if not reader.fieldnames or set(reader.fieldnames) != CSV_FIELDS or len(reader.fieldnames) != 4:
                raise ValueError('El CSV debe tener exactamente las columnas type,amount,oldbalanceOrg,oldbalanceDest (separadas por comas).')
            rows = []
            for row_number, row in enumerate(reader, 2):
                if len(rows) >= 1000:
                    raise ValueError('El CSV admite hasta 1000 casos.')
                try:
                    if set(row) != CSV_FIELDS or any(v is None for v in row.values()):
                        raise ValueError('Cantidad de columnas incorrecta.')
                    record = {k: (v if k == 'type' else float(v)) for k, v in row.items()}
                    rows.append(Transaction.model_validate(record).model_dump())
                except (ValueError, TypeError, ValidationError) as exc:
                    raise ValueError(f'Fila {row_number}: revisá tipo, monto y saldos; se requieren números finitos no negativos de hasta 1 billón.') from exc
            if not rows:
                raise ValueError('El CSV no contiene casos.')
        except (UnicodeDecodeError, ValueError, csv.Error) as exc:
            raise HTTPException(422, str(exc)) from exc
        results = run(rows)
        return {'results': results, 'total': len(results), 'alerts': sum(r['prediction'] for r in results)}

    @app.get('/', include_in_schema=False)
    def index():
        return FileResponse(ROOT / 'web' / 'index.html')

    @app.get('/favicon.svg', include_in_schema=False)
    def favicon():
        return FileResponse(ROOT / 'web' / 'favicon.svg', media_type='image/svg+xml')

    app.mount('/static', StaticFiles(directory=ROOT / 'web'), name='static')
    return app

app = create_app()
