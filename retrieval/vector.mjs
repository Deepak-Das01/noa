export function bufferToVector(buffer) {
  if (!buffer) return null;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.byteLength % 4 !== 0) return null;
  const aligned = Buffer.from(bytes);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

export function vectorToBuffer(vector) {
  const arr = vector instanceof Float32Array ? vector : new Float32Array(vector);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(score) ? score : 0;
}

export function vectorSearch(chunks, queryVector, limit = 25, { minScore = 0 } = {}) {
  const scored = [];
  for (const chunk of chunks) {
    const vector = bufferToVector(chunk.embedding);
    if (!vector) continue;
    if (queryVector.length !== vector.length) {
      throw new Error(
        `Embedding dimension mismatch: query=${queryVector.length}, stored=${vector.length}. Re-index with the current embedding model.`,
      );
    }
    const score = cosineSimilarity(queryVector, vector);
    if (score >= minScore) scored.push({ ...chunk, score, chunk_id: chunk.id });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
