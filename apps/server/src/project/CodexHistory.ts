import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  connect,
  request,
  CODEX_SYNC_THREAD_SOURCES,
  type RawClient,
} from "./CodexProjectMembership.ts";
import type { AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const NativeThread = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
const ThreadPage = Schema.Struct({
  data: Schema.Array(NativeThread),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const Item = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
});
const ItemPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ item: Item, startedAtMs: Schema.optional(Schema.NullOr(Schema.Number)) }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const TextInput = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeItemPage = Schema.decodeUnknownEffect(ItemPage);
const decodeThreadPage = Schema.decodeUnknownEffect(ThreadPage);
const isTextInput = Schema.is(TextInput);

class HistoryError extends Schema.TaggedError<HistoryError>()("CodexHistoryError", {
  message: Schema.String,
}) {}

export const readCodexConversation = Effect.fn("readCodexConversation")(function* (
  raw: Pick<RawClient, "request">,
  threadId: string,
  createdAt: number,
) {
  const messages: Array<AgentSessionThreadMessage> = [];
  const seen = new Set<string>();
  const itemIds = new Set<string>();
  let cursor: string | undefined;
  let characters = 0;
  do {
    const page = yield* decodeItemPage(
      yield* request(raw, "thread/items/list", {
        threadId,
        limit: 100,
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const entry of page.data) {
      const item = entry.item;
      if (itemIds.has(item.id)) continue;
      itemIds.add(item.id);
      if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
      const text =
        item.type === "agentMessage"
          ? (item.text ?? "")
          : (item.content ?? [])
              .filter(isTextInput)
              .map((part) => part.text)
              .join("\n");
      if (text.length === 0) continue;
      characters += text.length;
      if (characters > 16 * 1024 * 1024 || messages.length >= 100_000) {
        return yield* new HistoryError({
          message: "Codex conversation exceeds the per-chat import budget.",
        });
      }
      messages.push({
        nativeId: item.id,
        role: item.type === "userMessage" ? "user" : "assistant",
        text,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(entry.startedAtMs ?? createdAt * 1000)),
      });
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor))
      return yield* new HistoryError({ message: "Codex repeated an item cursor." });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
});

export const synchronizeCodexHistory = Effect.fn("synchronizeCodexHistory")(function* <E, R>(
  instanceId: ProviderInstanceId,
  importThread: (
    thread: typeof NativeThread.Type,
    messages: ReadonlyArray<AgentSessionThreadMessage>,
  ) => Effect.Effect<void, E, R>,
) {
  const { client } = yield* connect(instanceId);
  let skipped = 0;
  for (const archived of [false, true]) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* decodeThreadPage(
        yield* request(client.raw, "thread/list", {
          archived,
          sourceKinds: CODEX_SYNC_THREAD_SOURCES,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const thread of page.data) {
        yield* readCodexConversation(client.raw, thread.id, thread.createdAt).pipe(
          Effect.flatMap((messages) => importThread(thread, messages)),
          Effect.catch((cause) =>
            Effect.logWarning("Codex history import failed", { threadId: thread.id, cause }).pipe(
              Effect.tap(
                Effect.sync(() => {
                  skipped++;
                }),
              ),
            ),
          ),
        );
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor))
        return yield* new HistoryError({ message: "Codex repeated a history cursor." });
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return skipped;
});
