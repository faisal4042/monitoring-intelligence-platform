"""Stateless AI service (docs/PROJECT_PLAN.md §96-100): no DB connection, no
knowledge of X. Receives text, returns vectors. apps/api owns everything else."""
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .providers.base import EmbeddingProvider
from .providers.siliconflow import SiliconFlowProvider
from .providers.deepseek import LabelProvider

app = FastAPI(title="mip-ai", version="0.1.0")

_provider: EmbeddingProvider | None = None
_labeler: LabelProvider | None = None


def get_provider() -> EmbeddingProvider:
    global _provider
    if _provider is None:
        if settings.embedding_provider == "siliconflow":
            _provider = SiliconFlowProvider(
                api_key=settings.siliconflow_api_key,
                base_url=settings.siliconflow_base_url,
                model=settings.siliconflow_embedding_model,
                dimensions=settings.embedding_dimensions,
            )
        else:
            raise HTTPException(500, f"unknown EMBEDDING_PROVIDER: {settings.embedding_provider}")
    return _provider


def get_labeler() -> LabelProvider:
    global _labeler
    if _labeler is None:
        if settings.label_provider == "deepseek":
            _labeler = LabelProvider(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
                model=settings.deepseek_model,
            )
        else:
            raise HTTPException(500, f"unknown LABEL_PROVIDER: {settings.label_provider}")
    return _labeler


def check_auth(authorization: str | None) -> None:
    if not settings.ai_api_key:
        return  # no shared secret configured — dev mode
    expected = f"Bearer {settings.ai_api_key}"
    if authorization != expected:
        raise HTTPException(401, "invalid or missing AI service token")


@app.get("/health")
async def health():
    return {"ok": True, "provider": settings.embedding_provider, "dimensions": settings.embedding_dimensions}


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=256)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimensions: int


@app.post("/embed", response_model=EmbedResponse)
async def embed(body: EmbedRequest, authorization: str | None = Header(default=None)):
    check_auth(authorization)
    provider = get_provider()
    vectors = await provider.embed(body.texts)
    return EmbedResponse(embeddings=vectors, model=provider.name, dimensions=provider.dimensions)


class TopicRef(BaseModel):
    id: str
    nameAr: str
    description: str | None = None


class LabelRequest(BaseModel):
    text: str
    existingTopics: list[TopicRef] = Field(default_factory=list)


_SENTIMENT_LABELS = {"very_positive", "positive", "neutral", "negative", "very_negative"}


class LabelResponse(BaseModel):
    action: str  # "existing" | "new" | "none"
    topicId: str | None = None
    nameAr: str | None = None
    description: str | None = None
    sentiment: str | None = None
    sentimentScore: float | None = None
    model: str
    promptTokens: int
    completionTokens: int


@app.post("/label", response_model=LabelResponse)
async def label(body: LabelRequest, authorization: str | None = Header(default=None)):
    check_auth(authorization)
    labeler = get_labeler()
    out = await labeler.label(
        body.text,
        [t.model_dump() for t in body.existingTopics],
    )
    result = out["result"] if isinstance(out["result"], dict) else {}
    action = result.get("action") if result.get("action") in ("existing", "new", "none") else "none"
    sentiment = result.get("sentiment") if result.get("sentiment") in _SENTIMENT_LABELS else None
    score = result.get("sentimentScore")
    sentiment_score = max(-1.0, min(1.0, float(score))) if isinstance(score, (int, float)) else None
    return LabelResponse(
        action=action,
        topicId=result.get("topicId"),
        nameAr=result.get("nameAr"),
        description=result.get("description"),
        sentiment=sentiment,
        sentimentScore=sentiment_score,
        model=out["model"],
        promptTokens=out["promptTokens"],
        completionTokens=out["completionTokens"],
    )
