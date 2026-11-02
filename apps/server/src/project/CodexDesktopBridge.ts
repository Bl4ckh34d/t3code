// @effect-diagnostics nodeBuiltinImport:off -- Codex desktop exposes a framed local socket protocol.
// @effect-diagnostics globalTimers:off -- Each socket owns and clears its response deadline.
import * as NodeNet from "node:net";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class CodexDesktopUnavailable extends Schema.TaggedError<CodexDesktopUnavailable>()(
  "CodexDesktopUnavailable",
  {
    message: Schema.String,
    moveConfirmation: Schema.optionalKey(
      Schema.Struct({
        projectTitle: Schema.String,
        sourcePaths: Schema.Array(Schema.String),
      }),
    ),
  },
) {}

const decodeMoveConfirmation = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Literal("confirmation_required"),
      projectId: Schema.String,
      missingProjectSources: Schema.Array(Schema.String),
      targetProjectName: Schema.String,
    }),
  ),
);

const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, namespace: Schema.String })),
});
const ToolResult = Schema.Struct({
  success: Schema.Boolean,
  contentItems: Schema.optionalKey(
    Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  ),
});
const RpcResponse = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const decodeRpcResponse = Schema.decodeUnknownSync(RpcResponse);
const isDesktopUnavailable = Schema.is(CodexDesktopUnavailable);

type Request = (
  method: string,
  params?: unknown,
) => Effect.Effect<unknown, CodexDesktopUnavailable>;

export function desktopBridge(request: Request) {
  const requireTool = Effect.fn("CodexDesktopBridge.requireTool")(function* (name: string) {
    const list = yield* request("tools/list", { threadStartKind: "all" }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ToolList)),
      Effect.mapError((error) =>
        isDesktopUnavailable(error)
          ? error
          : new CodexDesktopUnavailable({
              message: "Connect Codex desktop before organizing synced projects or chats.",
            }),
      ),
    );
    const tool = list.tools.find((entry) => entry.name === name && entry.namespace === "codex_app");
    if (!tool)
      return yield* new CodexDesktopUnavailable({
        message: `Codex desktop does not support ${name}. Update Codex before trying again.`,
      });
    return tool;
  });
  const invoke = Effect.fn("CodexDesktopBridge.call")(function* (
    name: string,
    nativeThreadId: string,
    args: Record<string, unknown>,
  ) {
    const tool = yield* requireTool(name);
    const crypto = yield* Crypto.Crypto;
    const result = yield* request("tools/call", {
      namespace: tool.namespace,
      tool: name,
      arguments: args,
      callerSource: "codex",
      threadId: nativeThreadId,
      callId: `t3:${yield* crypto.randomUUIDv4()}`,
      turnId: `t3:${yield* crypto.randomUUIDv4()}`,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ToolResult)),
      Effect.mapError((error) =>
        isDesktopUnavailable(error)
          ? error
          : new CodexDesktopUnavailable({
              message: "Codex desktop did not acknowledge the change. T3 was not updated.",
            }),
      ),
    );
    if (!result.success) {
      const detail = result.contentItems
        ?.flatMap((item) => item.text ?? [])
        .join(" ")
        .trim()
        .replace(/[.!?]+$/u, "");
      const confirmation = decodeMoveConfirmation(detail);
      if (
        name === "move_thread_to_project" &&
        Option.isSome(confirmation) &&
        confirmation.value.projectId === args.projectId &&
        confirmation.value.missingProjectSources.length > 0
      )
        return yield* new CodexDesktopUnavailable({
          message:
            "Approve folder access in the Codex desktop sidebar before moving this chat. T3 was not updated.",
          moveConfirmation: {
            projectTitle: confirmation.value.targetProjectName,
            sourcePaths: confirmation.value.missingProjectSources,
          },
        });
      return yield* new CodexDesktopUnavailable({
        message: detail
          ? `Codex desktop rejected the change: ${detail}. T3 was not updated.`
          : "Codex desktop rejected the change. T3 was not updated.",
      });
    }
    return result;
  });
  const call = (name: string, nativeThreadId: string, args: Record<string, unknown>) =>
    invoke(name, nativeThreadId, args).pipe(Effect.asVoid);
  return { requireTool, call, read: invoke };
}

export const requestDesktopPipe = (pipePath: string): Request =>
  Effect.fn("CodexDesktopBridge.request")(function* (method: string, params?: unknown) {
    if (!pipePath)
      return yield* new CodexDesktopUnavailable({
        message: "Connect T3 from Codex desktop before organizing synced projects or chats.",
      });
    return yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<unknown>((resolve, reject) => {
          const socket = NodeNet.createConnection(pipePath);
          let data = Buffer.alloc(0);
          let finished = false;
          const finish = (message?: string, result?: unknown) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            socket.destroy();
            if (message) reject(new CodexDesktopUnavailable({ message }));
            else resolve(result);
          };
          const abort = () => finish("Codex desktop request cancelled.");
          const timer = setTimeout(() => finish("Codex desktop did not respond."), 5_000);
          signal.addEventListener("abort", abort, { once: true });
          socket.once("error", (error) => finish(error.message));
          socket.once("close", () => finish("Codex desktop disconnected."));
          socket.once("connect", () => {
            const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
            const header = Buffer.alloc(4);
            header.writeUInt32LE(payload.length);
            socket.write(Buffer.concat([header, payload]));
          });
          socket.on("data", (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
            if (data.length < 4) return;
            const length = data.readUInt32LE(0);
            if (length === 0 || length > 8 * 1024 * 1024) {
              finish("Invalid Codex desktop response size.");
              return;
            }
            if (data.length < length + 4) return;
            try {
              const response = decodeRpcResponse(
                JSON.parse(data.subarray(4, length + 4).toString("utf8")),
              );
              if (response.id !== 1) {
                finish("Invalid Codex desktop response id.");
                return;
              }
              finish(response.error?.message, response.result);
            } catch (error) {
              finish(error instanceof Error ? error.message : "Invalid Codex desktop response.");
            }
          });
          if (signal.aborted) abort();
        }),
      catch: (error) =>
        isDesktopUnavailable(error)
          ? error
          : new CodexDesktopUnavailable({ message: "Codex desktop connection failed." }),
    });
  });
