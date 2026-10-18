"""DeepSeek-hosted chat model used for topic discovery (docs/AI_PIPELINE.md §7 —
Stage 3: an LLM proposes taxonomy when a post matches no known centroid well
enough). OpenAI-compatible /chat/completions with JSON mode."""
import json

import httpx

SYSTEM_PROMPT = (
    "أنت مصنّف مواضيع ومشاعر لمنصة رصد تراقب منشورات X (تويتر) العربية حول برامج ومنصات سعودية.\n"
    "تستلم نص منشور وقائمة مواضيع موجودة (id, nameAr, description).\n\n"
    "أولاً حدّد الموضوع — واحد مما يلي بالضبط في حقل action:\n"
    '1) "existing" إن كان المنشور يطابق موضوعاً موجوداً فعلياً — أضف "topicId":"<id>"\n'
    '2) "new" إن كان المنشور يمثّل مشكلة/موضوعاً حقيقياً متكرراً يستحق التتبع ولا يطابق أي موضوع موجود —\n'
    '   أضف "nameAr":"<اسم قصير 3-6 كلمات>" و"description":"<وصف جملة واحدة>"\n'
    '3) "none" إن كان المنشور غامضاً أو حالة فردية لا تستحق موضوعاً مستقلاً\n\n'
    "ثانياً وبغضّ النظر عن قرار الموضوع، صنّف مشاعر المنشور دائماً في حقلين إضافيين:\n"
    '- "sentiment": واحدة بالضبط من [very_positive, positive, neutral, negative, very_negative]\n'
    '- "sentimentScore": رقم عشري بين -1 (سلبي جداً) و1 (إيجابي جداً)\n\n'
    "أجب بصيغة JSON فقط بلا أي نص إضافي، بمفاتيح: action, topicId, nameAr, description, sentiment, sentimentScore "
    "(اترك غير المستخدم منها null)."
)


class LabelProvider:
    def __init__(self, api_key: str, base_url: str, model: str):
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY is not set")
        self.model = model
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60.0,
        )

    async def label(self, text: str, existing_topics: list[dict]) -> dict:
        topics_json = json.dumps(existing_topics, ensure_ascii=False)
        user_msg = f"المنشور:\n{text}\n\nالمواضيع الموجودة:\n{topics_json}"
        resp = await self._client.post(
            "/chat/completions",
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"DeepSeek chat completion failed ({resp.status_code}): {resp.text[:500]}")
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            parsed = {"action": "none"}
        return {
            "result": parsed,
            "model": data.get("model", self.model),
            "promptTokens": usage.get("prompt_tokens", 0),
            "completionTokens": usage.get("completion_tokens", 0),
        }

    async def aclose(self) -> None:
        await self._client.aclose()
