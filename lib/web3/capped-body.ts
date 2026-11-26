/**
 * A response body as UTF-8 text, reading at most `maxBytes`. Undefined when
 * the body is larger (declared or streamed) or the stream fails; the stream
 * is cancelled whenever it is not read to the end.
 */
export async function readCappedBody(
  response: Response,
  maxBytes: number
): Promise<string | undefined> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await body.cancel().catch(() => undefined);
    return;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return;
  }
  // TextDecoder drops a leading byte-order mark, which JSON.parse rejects.
  return new TextDecoder().decode(Buffer.concat(chunks));
}
