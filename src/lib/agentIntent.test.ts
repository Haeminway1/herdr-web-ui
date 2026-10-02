import { describe, expect, test } from "bun:test";
import { splitIntent } from "./agentIntent.ts";

describe("splitIntent", () => {
  test("a plain intent paragraph leads the answer", () => {
    expect(splitIntent("I read this as an availability check - I'll reply with pong. I'll stop when the message is sent.\n\nPong. 준비되어 있습니다.")).toEqual({
      intent: ["I read this as an availability check - I'll reply with pong. I'll stop when the message is sent."],
      answer: "Pong. 준비되어 있습니다.",
    });
  });

  test("a quoted intent and the status quote after it", () => {
    const text = "> I read this as information - answer the two questions. I'll stop when the answers are generated.\n\n> Ask: quote the rule - wanted: two answers. For you: Found the rule. Now: Answer the questions. Next: \n\n1) Report when needed.\n2) 예.";
    expect(splitIntent(text)).toEqual({
      intent: [
        "I read this as information - answer the two questions. I'll stop when the answers are generated.",
        "Ask: quote the rule - wanted: two answers. For you: Found the rule. Now: Answer the questions. Next:",
      ],
      answer: "1) Report when needed.\n2) 예.",
    });
  });

  test("an answer that is only the intent stays as it is, so the turn is never blank", () => {
    const text = "I read this as a greeting. I'll stop when I reply.";
    expect(splitIntent(text)).toEqual({ intent: [], answer: text });
  });

  test("other answers are untouched, a status quote alone included", () => {
    for (const text of ["Hello.\n\nI read this as fine.", "> Ask: x. Now: y.\n\nAnswer", "I reading this"]) {
      expect(splitIntent(text)).toEqual({ intent: [], answer: text });
    }
  });
});
