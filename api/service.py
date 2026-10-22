from pathlib import Path
import json
import hashlib
import pickle
import joblib
import numpy as np
import pandas as pd
from .features import DERIVED, THRESHOLD, crear_variables

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'

class ModelUnavailable(RuntimeError):
    pass

class ModelService:
    def __init__(self, directory: Path = ARTIFACTS):
        self.directory = directory
        self.model = None
        self.report = None
        self.error = None

    def load(self):
        try:
            report = json.loads((self.directory / 'metrics.json').read_text(encoding='utf-8'))
            model_path = self.directory / 'model.joblib'
            if hashlib.sha256(model_path.read_bytes()).hexdigest() != report['model_sha256']:
                raise ValueError('El modelo y las métricas no corresponden al mismo artefacto.')
            model = joblib.load(model_path)
            self.model, self.report = model, report
            self.error = None
        except (OSError, ValueError, KeyError, ImportError, EOFError, pickle.UnpicklingError) as exc:
            self.model = None
            self.report = None
            self.error = f'{type(exc).__name__}: {exc}'

    def require(self):
        if self.model is None:
            raise ModelUnavailable('Modelo no disponible. Ejecutá python train.py --csv RUTA y reiniciá la API.')

    def tree_preview(self) -> dict:
        """Raíz y dos niveles siguientes del artefacto cargado (profundidades 0, 1 y 2)."""
        self.require()
        classifier = self.model.named_steps['clasificador']
        tree = classifier.tree_
        names = self.model.named_steps['preparacion'].get_feature_names_out()
        fraud_index = list(classifier.classes_).index(1)

        def node_summary(node_id: int, depth: int) -> dict:
            leaf = tree.children_left[node_id] == tree.children_right[node_id]
            values = tree.value[node_id][0]
            fractions = values / values.sum()
            samples = int(tree.n_node_samples[node_id])
            fraud_fraction = float(fractions[fraud_index])
            node = dict(
                id=int(node_id), level=depth + 1, is_leaf=bool(leaf),
                is_truncated=bool(not leaf and depth == 2),
                feature=None if leaf else str(names[tree.feature[node_id]]).split('__', 1)[-1],
                threshold=None if leaf else float(tree.threshold[node_id]),
                samples=samples, fraud_fraction=fraud_fraction,
                class_counts={'legitimate': int(round(samples * (1 - fraud_fraction))),
                              'fraud': int(round(samples * fraud_fraction))},
                gini=float(tree.impurity[node_id]),
                left=None, right=None,
            )
            if not leaf and depth < 2:
                node['left'] = node_summary(int(tree.children_left[node_id]), depth + 1)
                node['right'] = node_summary(int(tree.children_right[node_id]), depth + 1)
            return node

        return {'levels': 3, 'model_version': self.report['model_version'], 'root': node_summary(0, 0)}

    def predict(self, rows: list[dict]) -> list[dict]:
        self.require()
        frame = crear_variables(pd.DataFrame(rows))
        prepared = self.model.named_steps['preparacion'].transform(frame)
        tree = self.model.named_steps['clasificador']
        # Usar la misma representación que sklearn para explicar comparaciones límite.
        prepared = prepared.astype(np.float32)
        scores = tree.predict_proba(prepared)[:, list(tree.classes_).index(1)]
        names = self.model.named_steps['preparacion'].get_feature_names_out()
        leaves = tree.apply(prepared)
        paths = tree.decision_path(prepared)
        output = []
        for i, (raw, score, leaf) in enumerate(zip(rows, scores, leaves)):
            steps = []
            for node in paths.indices[paths.indptr[i]:paths.indptr[i + 1]]:
                if tree.tree_.children_left[node] == tree.tree_.children_right[node]:
                    continue
                feature_id = tree.tree_.feature[node]
                value = float(prepared[i, feature_id])
                threshold = float(tree.tree_.threshold[node])
                steps.append(dict(feature=str(names[feature_id]).split('__', 1)[-1],
                                  value=value, operator='<=' if value <= threshold else '>', threshold=threshold))
            warnings = []
            for key, bounds in self.report['input_ranges'].items():
                if raw[key] < bounds['min'] or raw[key] > bounds['max']:
                    warnings.append(f'{key} está fuera del rango observado en entrenamiento.')
            if raw['type'] == 'PAYMENT':
                warnings.append('Para PAYMENT, el saldo estimado del destino usa 0 como marcador de información ausente.')
            if raw['amount'] > raw['oldbalanceOrg'] and raw['type'] != 'CASH_IN':
                warnings.append('El monto supera el saldo previo: el saldo estimado de origen representa un déficit teórico.')
            derived = {k: float(frame.iloc[i][k]) for k in DERIVED}
            output.append(dict(
                input=raw, prediction=int(score >= THRESHOLD),
                label='Posible fraude' if score >= THRESHOLD else 'Sin alerta de fraude',
                score=float(score), threshold=THRESHOLD, derived_features=derived,
                decision_path=steps, leaf_samples=int(tree.tree_.n_node_samples[leaf]),
                leaf_fraud_fraction=float(score), warnings=warnings,
                model_version=self.report['model_version'],
            ))
        return output
