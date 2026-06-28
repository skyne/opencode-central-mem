const EMBED_DIM = 384;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function embeddingToBuffer(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer);
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function getEmbeddingDimensions(): number {
  return EMBED_DIM;
}
