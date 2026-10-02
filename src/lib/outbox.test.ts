import { expect, it } from "bun:test";
import { recorded } from "./outbox.ts";

it("knows a message once a newer user turn holds it, however its spaces were kept", () => {
  expect(recorded("fix the  bug\nplease", ["fix the bug please"])).toBe(true);
  expect(recorded("fix the bug", ["something else"])).toBe(false);
  expect(recorded("fix the bug", [])).toBe(false);
  expect(recorded("a".repeat(500), ["a".repeat(300)])).toBe(true);
  expect(recorded("   ", [])).toBe(true);
});
