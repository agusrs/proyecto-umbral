from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field

Money = Annotated[float, Field(ge=0, le=1_000_000_000_000, allow_inf_nan=False, strict=True)]

class Transaction(BaseModel):
    model_config = ConfigDict(extra='forbid', json_schema_extra={
        'examples': [{'type': 'TRANSFER', 'amount': 1000, 'oldbalanceOrg': 1000, 'oldbalanceDest': 0}]
    })
    type: Literal['CASH_IN', 'CASH_OUT', 'DEBIT', 'PAYMENT', 'TRANSFER']
    amount: Money
    oldbalanceOrg: Money
    oldbalanceDest: Money

class BatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    transactions: list[Transaction] = Field(min_length=1, max_length=1000)

class DecisionStep(BaseModel):
    feature: str
    value: float
    operator: str
    threshold: float

class Prediction(BaseModel):
    input: Transaction
    prediction: int
    label: str
    score: float
    threshold: float
    derived_features: dict[str, float | int]
    decision_path: list[DecisionStep]
    leaf_samples: int
    leaf_fraud_fraction: float
    warnings: list[str]
    model_version: str

class BatchResponse(BaseModel):
    results: list[Prediction]
    total: int
    alerts: int
