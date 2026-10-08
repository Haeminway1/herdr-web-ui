import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { compressResponse } from "./compress.ts";

const asks = (path = "/api/pane/conversation", encoding = "gzip, deflate, br") => new Request(`http://local${path}`, { headers: { "accept-encoding": encoding } });
const json = (size: number) => new Response(JSON.stringify({ turns: "x".repeat(size) }), { headers: { "content-type": "application/json; charset=utf-8", etag: '"v1"' } });

test("gzips a large JSON answer for a browser that takes it, keeping its headers", async () => {
  const response = (await compressResponse(asks(), json(50_000)))!;
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("etag")).toBe('"v1"');
  expect(response.headers.get("vary")).toContain("accept-encoding");
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body.byteLength).toBeLessThan(5_000);
  expect(JSON.parse(gunzipSync(body).toString()).turns.length).toBe(50_000);
});

test("leaves alone what it must not touch", async () => {
  expect((await compressResponse(asks("/x", "identity"), json(50_000)))!.headers.get("content-encoding")).toBeNull();
  expect((await compressResponse(asks(), json(10)))!.headers.get("content-encoding")).toBeNull();
  const stream = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
  expect(await compressResponse(asks("/api/machines/events"), stream)).toBe(stream);
  const image = new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } });
  expect(await compressResponse(asks(), image)).toBe(image);
  const notModified = new Response(null, { status: 304 });
  expect(await compressResponse(asks(), notModified)).toBe(notModified);
  const file = new Response("y".repeat(50_000), { headers: { "content-type": "text/plain" } });
  expect(await compressResponse(asks("/api/fs/file"), file)).toBe(file);
  expect(await compressResponse(asks(), undefined)).toBeUndefined();
});
