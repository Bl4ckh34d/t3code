import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerSettings from "../serverSettings.ts";
import { readCodexConversation, synchronizeCodexHistory } from "./CodexHistory.ts";
import { ProviderInstanceId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type { RawClient } from "./CodexProjectMembership.ts";
import { vi } from "vite-plus/test";

const native = vi.hoisted(() => vi.fn<RawClient["request"]>());
vi.mock("./CodexProjectMembership.ts", async (original) => ({
  ...(await original<typeof import("./CodexProjectMembership.ts")>()),
  connect: () => Effect.succeed({ client: { raw: { request: native } } }),
}));

it.effect(
  "imports old and archived chats from every model provider, following all pages once",
  () =>
    Effect.gen(function* () {
      native.mockReset();
      const thread = (id: string) => ({
        id,
        cwd: "/isolated",
        name: id,
        preview: id,
        createdAt: 1,
        updatedAt: 2,
      });
      native.mockImplementation((method, value) => {
        const params = value as {
          archived?: boolean;
          modelProviders?: string[];
          cursor?: string;
          threadId?: string;
        };
        if (method === "thread/list") {
          const allProviders = params.modelProviders?.length === 0;
          return Effect.succeed(
            params.archived
              ? { data: allProviders ? [thread("archived-old")] : [], nextCursor: null }
              : params.cursor
                ? {
                    data: [
                      thread("recent"),
                      ...(allProviders ? [thread("old-custom-provider")] : []),
                    ],
                    nextCursor: null,
                  }
                : { data: [thread("recent")], nextCursor: "older-page" },
          );
        }
        return Effect.succeed({
          data: [
            {
              item: {
                id: params.threadId + ":message",
                type: "agentMessage",
                text: "Historical reply",
              },
            },
          ],
          nextCursor: null,
        });
      });
      const imported: string[] = [];
      const archiveStates: boolean[] = [];
      const skipped = yield* synchronizeCodexHistory(
        ProviderInstanceId.make("isolated"),
        (source, messages) =>
          Effect.sync(() => {
            expect(messages[0]?.text).toBe("Historical reply");
            imported.push(source.id);
            archiveStates.push(source.archived);
          }),
      );
      expect(imported).toEqual(["recent", "old-custom-provider", "archived-old"]);
      expect(archiveStates).toEqual([false, false, true]);
      expect(skipped).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
        ),
      ),
    ),
);

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
