/**
 * gzip for the text this server answers with, when the browser takes it. A conversation page is
 * JSON of up to a few megabytes, polled every 2 s while it changes; over a Tailscale relay or a
 * phone's link those bytes were most of a session switch (2026-10-08: 2.1 MB → about a fifth).
 *
 * Only finished bodies of a text type: the event stream (SSE) and a WebSocket upgrade pass
 * untouched, and so do files a user downloads, a range answer and anything already encoded.
 * Static bundles are the same bytes on every load, so their compressed form is kept by content.
 */

const COMPRESSIBLE = /^(?:application\/(?:json|javascript|manifest\+json)|text\/(?:html|css|javascript|plain)|image\/svg\+xml)\b/i;
const MIN_BYTES = 1024;
const KEPT = 32;
const kept = new Map<bigint | number, Uint8Array<ArrayBuffer>>();

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
}

export async function compressResponse(request: Request, response: Response | undefined): Promise<Response | undefined> {
  if (response === undefined || request.method === "HEAD" || !acceptsGzip(request)) return response;
  // a file the viewer opens can be any size: it streams as it is
  if (/\/fs\/file$/.test(new URL(request.url).pathname)) return response;
  if (response.status !== 200 || response.headers.has("content-encoding") || response.headers.has("content-range")) return response;
  const type = response.headers.get("content-type") ?? "";
  if (!COMPRESSIBLE.test(type) || /^text\/event-stream/i.test(type) || /attachment/i.test(response.headers.get("content-disposition") ?? "")) return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  if (body.byteLength < MIN_BYTES) return new Response(body, { status: response.status, statusText: response.statusText, headers });
  const key = Bun.hash(body);
  let gzipped: Uint8Array<ArrayBuffer> | undefined = kept.get(key);
  if (gzipped === undefined) {
    gzipped = Bun.gzipSync(body, { level: 6 }) as Uint8Array<ArrayBuffer>;
    kept.set(key, gzipped);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  } else {
    kept.delete(key);
    kept.set(key, gzipped);
  }
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  return new Response(gzipped, { status: response.status, statusText: response.statusText, headers });
}
