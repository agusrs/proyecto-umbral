"""Transformación compartida por entrenamiento e inferencia; replica la notebook 03."""
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.tree import DecisionTreeClassifier

TYPES = ('CASH_IN', 'CASH_OUT', 'DEBIT', 'PAYMENT', 'TRANSFER')
BASE_NUMERIC = ['amount', 'oldbalanceOrg', 'oldbalanceDest']
DERIVED = [
    'saldo_estimado_origen', 'saldo_estimado_destino',
    'proporcion_saldo_salida', 'monto_supera_saldo', 'cuenta_casi_vacia',
    'origen_sin_saldo', 'destino_sin_informacion',
]
NUMERIC = BASE_NUMERIC + DERIVED
INPUTS = BASE_NUMERIC + ['type']
CONFIG = dict(max_depth=20, min_samples_leaf=10, class_weight=None, random_state=42)
THRESHOLD = 0.50
REMAINDER = 0.01


def crear_variables(datos: pd.DataFrame, fraccion_remanente: float = REMAINDER) -> pd.DataFrame:
    x = datos[INPUTS].copy()
    if not x['type'].isin(TYPES).all():
        raise ValueError('Tipo de operación desconocido.')
    if not np.isfinite(x[BASE_NUMERIC].to_numpy()).all() or not x[BASE_NUMERIC].ge(0).all().all():
        raise ValueError('Los montos y saldos deben ser números finitos no negativos.')
    if not 0 <= fraccion_remanente <= 1:
        raise ValueError('La fracción remanente debe estar entre 0 y 1.')
    es_ingreso = x['type'].eq('CASH_IN')
    es_salida = ~es_ingreso
    saldo_positivo = x['oldbalanceOrg'].gt(0)
    direccion_origen = np.where(es_ingreso, 1.0, -1.0)
    x['saldo_estimado_origen'] = (x['oldbalanceOrg'] + direccion_origen * x['amount']).round(2)
    x['destino_sin_informacion'] = x['type'].eq('PAYMENT').astype('int8')
    x['saldo_estimado_destino'] = (x['oldbalanceDest'] - direccion_origen * x['amount']).round(2)
    x.loc[x['destino_sin_informacion'].eq(1), 'saldo_estimado_destino'] = 0.0
    x['proporcion_saldo_salida'] = 0.0
    puede_dividir = es_salida & saldo_positivo
    x.loc[puede_dividir, 'proporcion_saldo_salida'] = (
        x.loc[puede_dividir, 'amount'] / x.loc[puede_dividir, 'oldbalanceOrg']
    )
    x['monto_supera_saldo'] = (es_salida & x['amount'].gt(x['oldbalanceOrg'])).astype('int8')
    x['cuenta_casi_vacia'] = (
        es_salida & saldo_positivo & x['amount'].gt(0)
        & x['amount'].le(x['oldbalanceOrg'])
        & x['proporcion_saldo_salida'].ge(1 - fraccion_remanente)
    ).astype('int8')
    x['origen_sin_saldo'] = x['oldbalanceOrg'].eq(0).astype('int8')
    # sklearn convierte a float32. Evita overflow y proporciones no representables.
    values = x[NUMERIC].to_numpy(dtype=float)
    if not np.isfinite(values).all() or (np.abs(values) > np.finfo(np.float32).max).any():
        raise ValueError('La relación entre monto y saldo excede el rango numérico del modelo.')
    return x[NUMERIC + ['type']]


def construir_modelo() -> Pipeline:
    preparacion = ColumnTransformer([
        ('numericas', 'passthrough', NUMERIC),
        ('tipo', OneHotEncoder(handle_unknown='ignore', sparse_output=False), ['type']),
    ])
    return Pipeline([
        ('preparacion', preparacion),
        ('clasificador', DecisionTreeClassifier(**CONFIG)),
    ])
