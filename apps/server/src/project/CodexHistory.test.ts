import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readCodexConversation } from "./CodexHistory.ts";

it.effect("imports every conversation page in source order without repeated page anchors", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 251 }, (_, index) => ({
      item: {
        id: `item-${index}`,
        type: index % 2 === 0 ? "userMessage" : "agentMessage",
        text: `text-${index}`,
        content: [{ type: "text", text: `text-${index}` }],
      },
      startedAtMs: 1_000 + index,
    }));
    const messages = yield* readCodexConversation(
      {
        request: (_method, params) => {
          const cursor = Number((params as { cursor?: string }).cursor ?? 0);
          return Effect.succeed({
            data: rows.slice(Math.max(cursor - 1, 0), cursor + 100),
            nextCursor: cursor + 100 < rows.length ? String(cursor + 100) : null,
          });
        },
      },
      "native",
      1,
    );
    expect(messages).toHaveLength(251);
    expect(messages.map((message) => message.text)).toEqual(rows.map((row) => row.item.text));
    expect(messages[250]?.nativeId).toBe("item-250");
    const failure = yield* Effect.result(
      readCodexConversation(
        {
          request: () => Effect.succeed({ data: [], nextCursor: "stuck" }),
        },
        "native",
        1,
      ),
    );
    expect(failure._tag).toBe("Failure");
  }),
);
