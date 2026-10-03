// Enforce the byte limit while streaming; Content-Length is not trusted.
export async function readPredictionRequest(request, maxBytes = 20000) {
  const invalid = () => Object.assign(new Error("Invalid prediction selection"), { code: "INVALID_FIXTURE_SELECTION" });
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw invalid(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw invalid(); }
  } finally { reader.releaseLock(); }
}
