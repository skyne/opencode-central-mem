let pipeline: any = null;

const EMBED_DIM = 384;

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!pipeline) {
    const { pipeline: pipe } = await import('@huggingface/transformers');
    pipeline = await pipe('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
  }
  const result = await pipeline(text, { pooling: 'mean', normalize: true });
  return result.data as Float32Array;
}

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
