"""EmbeddingProvider abstraction (docs/AI_PIPELINE.md §4.1, docs/ARCHITECTURE.md app/providers/base.py):
swapping the model behind /embed is a config change, not a rewrite of the caller."""
from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    name: str
    dimensions: int

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Returns one vector per input text, same order, length == self.dimensions."""
