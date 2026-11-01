// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real local socket transport.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CodexDesktopUnavailable,
  desktopBridge,
  requestDesktopPipe,
} from "./CodexDesktopBridge.ts";

it.effect("requires a responding desktop connection and validates advertised capabilities", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const bridge = desktopBridge((method) => {
      calls.push(method);
      return Effect.succeed({
        tools: [{ name: "move_thread_to_project", namespace: "codex_app" }],
      });
    });
    yield* bridge.requireTool("move_thread_to_project");
    expect(calls).toEqual(["tools/list"]);
    expect((yield* Effect.result(bridge.requireTool("set_thread_title")))._tag).toBe("Failure");
  }),
);

it.effect("does not send organizational writes when desktop handshake fails", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const bridge = desktopBridge((method) => {
      calls.push(method);
      return Effect.fail(new CodexDesktopUnavailable({ message: "desktop disconnected" }));
    });
    const result = yield* Effect.result(
      bridge.call("move_thread_to_project", "native-thread", { projectId: "project-b" }),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toEqual(["tools/list"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("waits for desktop acknowledgement and rejects unsuccessful tool results", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const bridge = desktopBridge((method, params) => {
      calls.push([method, params]);
      return Effect.succeed(
        method === "tools/list"
          ? { tools: [{ name: "set_thread_title", namespace: "codex_app" }] }
          : { success: false, contentItems: [{ type: "text", text: "Rename rejected" }] },
      );
    });
    expect(
      yield* bridge
        .call("set_thread_title", "native-thread", { title: "New" })
        .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error.message })),
    ).toBe("Codex desktop rejected the change: Rename rejected. T3 was not updated.");
    expect(calls).toHaveLength(2);
    const readResult = { success: true, contentItems: [{ text: '{"threads":[]}' }] };
    const reading = desktopBridge((method) =>
      Effect.succeed(
        method === "tools/list"
          ? { tools: [{ name: "list_threads", namespace: "codex_app" }] }
          : readResult,
      ),
    );
    expect(yield* reading.read("list_threads", "native-thread", { mode: "history" })).toEqual(
      readResult,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reads framed desktop responses and rejects mismatched IDs and remote errors", () =>
  Effect.gen(function* () {
    const id = yield* (yield* Crypto.Crypto).randomUUIDv4();
    const pipePath =
      (yield* HostProcess.Platform) === "win32"
        ? `\\\\.\\pipe\\t3-codex-test-${id}`
        : NodePath.join(NodeOS.tmpdir(), `t3-codex-${id}.sock`);
    let response: unknown = { id: 1, result: { ready: true } };
    const server = NodeNet.createServer((socket) => {
      socket.once("data", () => {
        const payload = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(payload.length);
        socket.write(header.subarray(0, 2), () => {
          socket.end(Buffer.concat([header.subarray(2), payload]));
        });
      });
    });
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(pipePath, resolve);
          }),
        catch: () => new CodexDesktopUnavailable({ message: "Test socket failed." }),
      }),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const request = requestDesktopPipe(pipePath);
    expect(yield* request("tools/list")).toEqual({ ready: true });
    response = { id: 2, result: { ready: true } };
    expect(
      yield* request("tools/list").pipe(
        Effect.match({ onSuccess: () => null, onFailure: (error) => error.message }),
      ),
    ).toBe("Invalid Codex desktop response id.");
    response = { id: 1, error: { message: "Desktop permission denied" } };
    expect(
      yield* request("tools/call").pipe(
        Effect.match({ onSuccess: () => null, onFailure: (error) => error.message }),
      ),
    ).toBe("Desktop permission denied");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
