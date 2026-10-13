import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config, ROOT } from '../config';

export interface Embedder {
  modelKey: string;
  dims: number;
  // Starting relevance floor for this model; recalibrate before launch (spec §7.4).
  defaultFloor: number;
  embed(texts: string[]): Promise<number[][]>;
}

const LOCAL_DIMS = 256;

function bucket(feature: string): [number, number] {
  const h = createHash('md5').update(feature).digest();
  return [h.readUInt32LE(0) % LOCAL_DIMS, h[4]! & 1 ? 1 : -1];
}

// Feature-hashed bag of words and character trigrams. It has no notion of meaning
// across languages; it exists so the whole system runs with no external service.
// The category prefix that callers add dominates the vector, so same-category
// texts score high and the lexical overlap separates them further.
export function localEmbedding(text: string): number[] {
  const v = new Array<number>(LOCAL_DIMS).fill(0);
  const words = text.toLowerCase().split(/[^\p{L}\p{M}\p{N}._]+/u).map((w) => w.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  for (const w of words) {
    const isSlug = /^[a-z_]+\.[a-z_]+$/.test(w);
    const [i, s] = bucket('w:' + w);
    v[i]! += s * (isSlug ? 6 : 1.5);
    if (isSlug) {
      const [j, t] = bucket('p:' + w.split('.')[0]);
      v[j]! += t * 3;
      continue;
    }
    for (let k = 0; k + 3 <= w.length; k++) {
      const [g, u] = bucket('g:' + w.slice(k, k + 3));
      v[g]! += u * 0.5;
    }
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

const localEmbedder: Embedder = {
  modelKey: 'local_hash_256',
  dims: LOCAL_DIMS,
  defaultFloor: 0.3,
  embed: async (texts) => texts.map(localEmbedding),
};

function openAiCompatEmbedder(): Embedder {
  const { AI_EMBED_BASE_URL: base, AI_EMBED_MODEL: model, AI_EMBED_DIMS: dims, AI_EMBED_API_KEY: key } = config;
  if (!base || !model || !dims) throw new Error('AI_EMBEDDER=openai_compat needs AI_EMBED_BASE_URL, AI_EMBED_MODEL and AI_EMBED_DIMS');
  return {
    modelKey: model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    dims,
    defaultFloor: 0.45,
    async embed(texts) {
      const res = await fetch(`${base.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, input: texts, dimensions: dims }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`embedding endpoint returned ${res.status}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const out = json.data.sort((a, b) => a.index - b.index).map((d) => {
        if (d.embedding.length < dims) throw new Error(`embedding has ${d.embedding.length} values; AI_EMBED_DIMS is ${dims}`);
        // Providers that ignore "dimensions" return the full vector. These models are
        // trained so a prefix is still a valid embedding once re-normalised.
        const v = d.embedding.slice(0, dims);
        const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return out;
    },
  };
}

// A small open model (about 23 MB) that runs inside the server itself: no AI
// service, no per-use cost, and nothing leaves the machine. It understands
// English, which is enough here because every talent and request is stored with
// an English rendering (canonical_en) alongside the person's own words.
let extractor: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;
const miniLmEmbedder: Embedder = {
  modelKey: 'minilm_l6_384',
  dims: 384,
  defaultFloor: 0.35,
  async embed(texts) {
    extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = join(ROOT, '.data/models');
      return (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })) as never;
    })();
    const run = await extractor;
    return (await run(texts, { pooling: 'mean', normalize: true })).tolist();
  },
};

let cached: Embedder | null = null;
export function activeEmbedder(): Embedder {
  cached ??= config.AI_EMBEDDER === 'openai_compat' ? openAiCompatEmbedder() : config.AI_EMBEDDER === 'minilm' ? miniLmEmbedder : localEmbedder;
  return cached;
}

export const toVectorLiteral = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;
