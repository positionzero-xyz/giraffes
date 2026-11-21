export async function readBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export function boundedRequestBody(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get("content-length")) > limit) return Promise.resolve(null);
  return readBody(req.body, limit);
}
