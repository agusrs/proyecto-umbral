# Umbral · API y aplicación web de detección de fraude

Aplicación web para probar el **árbol de decisión final con variables derivadas** del trabajo. Backend Python con FastAPI y scikit-learn; frontend HTML, CSS y JavaScript, servido por la misma API. No requiere Node.js, compilación del frontend ni servicios externos para funcionar.

## Instalar en un equipo

Python 3.12 o superior; se verificó con Python 3.14.5. Desde la raíz del proyecto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Las versiones están fijadas, incluida la de scikit-learn con la que se guardó el modelo. Copiar también `artifacts/model.joblib` y `artifacts/metrics.json`. No hace falta tener el CSV para hacer predicciones.

## Funciones de la web

- **Simulador:** cuatro entradas, ejemplos del dataset, puntaje, clasificación y umbral fijo. Muestra las siete variables derivadas y el recorrido real del caso por las reglas del árbol. Permite exportar el caso completo a JSON.
- **Historial:** hasta 20 evaluaciones en memoria de la pestaña; se puede recuperar un caso para modificar sus entradas. Se borra al recargar y no se almacena en el servidor.
- **Rendimiento:** métricas de entrenamiento, validación y prueba; matriz de confusión, importancias, distribución del dataset y comparación de umbrales sobre validación.
- **Evaluación por lote:** carga de CSV, resultados paginados, inspección individual y exportación a CSV. Hasta 1.000 casos y 2 MiB por archivo; si alguna fila es inválida, se rechaza el lote completo indicando la fila.
- **El modelo:** configuración, visualización de los primeros tres niveles del árbol entrenado (raíz y dos niveles siguientes), fórmulas, metodología y contexto del experimento.

## Configuración del modelo final

| Parámetro | Valor |
|---|---:|
| `max_depth` | 20 |
| `min_samples_leaf` | 10 |
| `class_weight` | `None` |
| Umbral | 0,50 |
| `random_state` | 42 |
| Fracción remanente | 0,01 |

Partición estratificada utilizada en la evaluación: primero 80/20 y luego 75/25 del 80% restante. Resultado: **60% entrenamiento, 20% validación y 20% prueba**. No se reentrena con validación ni prueba. Se conservan todas las filas y todos los tipos; sin balanceo ni muestreo.

El árbol aprendido tiene **profundidad 14, 39 hojas y 77 nodos**. `max_depth=20` es un límite, no la profundidad que debe alcanzar obligatoriamente.

### Resultados reproducidos

Resultados de la configuración final `sin_pesos`, entrenada y evaluada sobre un dataset de 1.362.621 operaciones y 8.213 fraudes.

| Partición | Operaciones | Fraudes | Detectados | Sin detectar | Falsas alarmas |
|---|---:|---:|---:|---:|---:|
| Entrenamiento | 817.572 | 4.928 | 4.901 | 27 | 0 |
| Validación | 272.524 | 1.642 | 1.638 | 4 | 0 |
| Prueba | 272.525 | 1.643 | 1.640 | 3 | 0 |

En prueba: precisión **100%**, recall **99,8174%**, F1 **0,999086** y AP **0,998774**. Las métricas que consume la web se calculan durante el entrenamiento y se guardan junto al artefacto; no están simuladas en el frontend.

`metrics.json` registra configuración, hashes SHA-256 del CSV, la notebook y el modelo, versiones de bibliotecas, métricas por partición, importancias, rangos de entrada de entrenamiento y ejemplos. La API verifica la correspondencia entre modelo y métricas al arrancar.

## Contrato de entrada

Solo se aceptan estas cuatro variables, disponibles **antes** de completar la operación:

| Campo | Tipo | Valores |
|---|---|---|
| `type` | string | `CASH_IN`, `CASH_OUT`, `DEBIT`, `PAYMENT`, `TRANSFER` |
| `amount` | número JSON | Finito, no negativo, hasta 10^12 |
| `oldbalanceOrg` | número JSON | Saldo previo del origen; mismo rango |
| `oldbalanceDest` | número JSON | Saldo previo del destino; mismo rango |

La API rechaza tipos desconocidos, campos adicionales, negativos, strings numéricos en JSON, valores no finitos y relaciones monto/saldo que no se pueden representar en el modelo. El límite 10^12 es una validación de la API, no un rango aprendido. Los casos fuera del rango observado en entrenamiento reciben una advertencia en el resultado.

`step`, los identificadores, `newbalanceOrig`, `newbalanceDest` e `isFlaggedFraud` están excluidos. No se acepta `isFraud` como entrada.

### Variables derivadas

Las fórmulas se implementan en un único módulo compartido por entrenamiento e inferencia: `api/features.py`.

1. `saldo_estimado_origen`: saldo previo + monto en `CASH_IN`, o saldo previo − monto en los demás tipos. Redondeo a dos decimales.
2. `saldo_estimado_destino`: saldo previo − monto en `CASH_IN`, o + monto en los otros tipos. Para `PAYMENT`, marcador 0 por información no disponible. Redondeo a dos decimales.
3. `proporcion_saldo_salida`: monto / saldo de origen solo para salidas con saldo positivo; 0 en ingresos y con saldo cero.
4. `monto_supera_saldo`: indicador de salida cuyo monto supera el saldo previo de origen.
5. `cuenta_casi_vacia`: indicador de salida positiva con saldo previo positivo, monto no mayor al saldo, y proporción de salida ≥ 0,99.
6. `origen_sin_saldo`: indicador de saldo previo de origen igual a 0.
7. `destino_sin_informacion`: indicador de `PAYMENT`.

No se usan saldos posteriores. Los saldos estimados negativos se conservan y expresan un déficit teórico. `type` se transforma con `OneHotEncoder` ajustado únicamente en entrenamiento. El árbol recibe 10 columnas numéricas y 5 columnas de tipo.

## Endpoints

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/health` | Estado y disponibilidad del modelo |
| GET | `/api/model` | Configuración y estructura del árbol |
| GET | `/api/model/tree` | Primeros tres niveles, reglas y conteos de entrenamiento |
| GET | `/api/metrics` | Informe completo calculado en entrenamiento |
| GET | `/api/examples` | Casos de ejemplo del dataset, solo cuatro entradas y etiqueta real informativa |
| POST | `/api/predict` | Predicción individual con explicación |
| POST | `/api/predict/batch` | JSON con `transactions`, de 1 a 1.000 casos |
| POST | `/api/predict/csv` | Cuerpo CSV UTF-8; no multipart/form-data |

El score se obtiene con `predict_proba` para la clase 1. `prediction=1` si `score >= 0.50`, incluso en el límite exacto. La explicación muestra los nodos visitados con los valores float32 que compara scikit-learn y la cantidad de ejemplos de entrenamiento en la hoja final.

Predicción individual con PowerShell:

```powershell
$caso = @{
    type = 'TRANSFER'
    amount = 1000
    oldbalanceOrg = 1000
    oldbalanceDest = 0
} | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:8000/api/predict -Method Post -ContentType 'application/json' -Body $caso
```

Lote CSV:

```powershell
$csv = @"
type,amount,oldbalanceOrg,oldbalanceDest
TRANSFER,1000,1000,0
PAYMENT,150,5000,0
"@
Invoke-RestMethod -Uri http://127.0.0.1:8000/api/predict/csv -Method Post -ContentType 'text/csv' -Body $csv
```

JSON por lote:

```json
{
  "transactions": [
    {"type":"TRANSFER","amount":1000,"oldbalanceOrg":1000,"oldbalanceDest":0},
    {"type":"PAYMENT","amount":150,"oldbalanceOrg":5000,"oldbalanceDest":0}
  ]
}
```

El CSV requiere exactamente `type,amount,oldbalanceOrg,oldbalanceDest`, en cualquier orden, con encabezado. Usar comas como separador, punto decimal y números sin separador de miles. Se admite BOM UTF-8.

Los errores de validación devuelven 422; CSV demasiado grande, 413; modelo ausente o inconsistente, 503. Si faltan artefactos, la web abre y muestra el problema de disponibilidad; no genera predicciones ficticias.

## Verificación realizada

Se verificaron las fórmulas de las variables derivadas, la configuración del modelo, las métricas de evaluación, el recorrido del árbol y la equivalencia entre predicciones individuales y por lote. También se comprobaron las validaciones de entradas y los límites de carga.

En navegador se comprobaron las predicciones con y sin alerta, la edición de casos, el selector de partición, la carga y exportación de CSV y la visualización del árbol en escritorio y celular.

## Archivos principales

```text
api/
  __init__.py
  features.py       # Variables derivadas y construcción del modelo
  schemas.py        # Validación de entradas y contrato de respuestas
  service.py        # Carga, predicción y explicación
  main.py           # Endpoints y archivos web
web/
  index.html
  styles.css
  app.js
  favicon.svg
artifacts/
  model.joblib      # Pipeline entrenado
  metrics.json      # Métricas y trazabilidad del entrenamiento
requirements.txt    # Dependencias de la aplicación
.gitignore
README.md
```

La web y la API comparten origen: no hace falta configurar CORS ni una URL externa. El comando de ejecución local utiliza `127.0.0.1:8000`. La aplicación también puede desplegarse en un servicio compatible con FastAPI.

## Interpretación

La notebook documenta un sesgo temporal de selección, por lo que se excluye `step`; la prueba ya fue consultada durante el desarrollo del trabajo. El score es la proporción de fraudes de la hoja, no una probabilidad calibrada de fraude real. Estos resultados describen esta muestra y no garantizan rendimiento fuera de ella.

Documentación del framework utilizada para servir los archivos web: [FastAPI · Static Files](https://fastapi.tiangolo.com/tutorial/static-files/).
