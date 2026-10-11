// Recomputes stored vectors with the embedding model currently set in .env.
// Needed once after switching AI_EMBEDDER or AI_EMBED_MODEL. Run `pnpm db:migrate` first.
import { activeEmbedder, toVectorLiteral } from './ai/embeddings';
import { asSystem, closePools } from './db';
import { embeddingTable } from './migrate';
import { redis } from './redis';

const embedder = activeEmbedder();
for (const kind of ['capability', 'request'] as const) {
  const table = embeddingTable(kind, embedder.modelKey);
  const rows = await asSystem((tx) =>
    tx.query(
      `SELECT v.id, sc.slug, v.canonical_en, v.original_text
       FROM ${kind}_versions v JOIN ${kind === 'capability' ? 'capabilities' : 'requests'} p ON p.current_version_id = v.id
       JOIN service_categories sc ON sc.id = p.category_id
       WHERE NOT EXISTS (SELECT 1 FROM ${table} e WHERE e.${kind}_version_id = v.id) AND v.original_text <> ''`,
    ),
  );
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const vectors = await embedder.embed(batch.map((r) => `${r.slug} ${r.canonical_en} ${r.original_text}`));
    await asSystem(async (tx) => {
      for (const [j, r] of batch.entries()) {
        await tx.exec(`INSERT INTO ${table}(${kind}_version_id, embedding) VALUES ($1, $2::vector) ON CONFLICT DO NOTHING`, [r.id, toVectorLiteral(vectors[j]!)]);
      }
    });
    // Stay well inside free-tier per-minute limits.
    if (i + 20 < rows.length) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`${kind}: ${rows.length} vector(s) written with ${embedder.modelKey}`);
}
await closePools();
redis.disconnect();
