"""SiliconFlow-hosted Qwen3-Embedding-8B (OpenAI-compatible /embeddings).
Truncated to `dimensions` via the model's native Matryoshka support so the
output matches the fixed `vector(1024)` column used by every other provider
(docs/AI_PIPELINE.md §4.1: switching providers is a `settings` change, not a
migration, only as long as the dimension is held constant here)."""
import httpx

from .base import EmbeddingProvider

# SiliconFlow rejects more than 32 inputs per request.
_BATCH_SIZE = 32


class SiliconFlowProvider(EmbeddingProvider):
    def __init__(self, api_key: str, base_url: str, model: str, dimensions: int):
        if not api_key:
            raise ValueError("SILICONFLOW_API_KEY is not set")
        self.name = model
        self.dimensions = dimensions
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30.0,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), _BATCH_SIZE):
            chunk = texts[i:i + _BATCH_SIZE]
            resp = await self._client.post(
                "/embeddings",
                json={"model": self._model, "input": chunk, "dimensions": self.dimensions},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"SiliconFlow embeddings failed ({resp.status_code}): {resp.text[:500]}")
            data = resp.json()["data"]
            # The API does not promise result order matches input order.
            for row in sorted(data, key=lambda r: r["index"]):
                out.append(row["embedding"])
        return out

    async def aclose(self) -> None:
        await self._client.aclose()
