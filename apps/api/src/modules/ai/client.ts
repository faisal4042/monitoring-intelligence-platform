/** HTTP client to apps/ai (docs/ARCHITECTURE.md: apps/api/.../ai/ — client for apps/ai). */
import { config } from '@mip/config';
import { redactSensitiveText } from '../../lib/privacy.js';

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface LabelResult {
  action: 'existing' | 'new' | 'none';
  topicId: string | null;
  nameAr: string | null;
  description: string | null;
  sentiment: 'very_positive' | 'positive' | 'neutral' | 'negative' | 'very_negative' | null;
  sentimentScore: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

// Mirrors the /embed request cap in apps/ai/app/main.py.
const MAX_TEXTS_PER_CALL = 256;

export async function embed(texts: string[]): Promise<EmbedResult> {
  const out: EmbedResult = { embeddings: [], model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIMENSIONS };
  for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_CALL) {
    const chunk = texts.slice(i, i + MAX_TEXTS_PER_CALL)
      .map((text) => redactSensitiveText(text, { redactUrls: true }));
    const res = await fetch(`${config.AI_SERVICE_URL}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({ texts: chunk }),
      // A hung request with no timeout blocks the whole classification
      // pipeline behind it forever — this happened for real (a request sat
      // for 30+ minutes holding the lock in service.ts).
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI service /embed failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as EmbedResult;
    out.embeddings.push(...data.embeddings);
    out.model = data.model;
    out.dimensions = data.dimensions;
  }
  return out;
}

export async function label(
  text: string,
  existingTopics: Array<{ id: string; nameAr: string; description: string | null }>,
): Promise<LabelResult> {
  const res = await fetch(`${config.AI_SERVICE_URL}/label`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
    },
    body: JSON.stringify({ text: redactSensitiveText(text, { redactUrls: true }), existingTopics }),
    // DeepSeek's own reasoning can be slow, but a hung request with no
    // timeout at all blocks every post behind it in the queue indefinitely.
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI service /label failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as LabelResult;
}
