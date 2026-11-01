import {
  EnvironmentId,
  ProviderInstanceId,
  type CodexDesktopHistoryContext,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { discoverCodexHistoryTargets } from "./codexHistoryTargets";

it("routes connected Codex hosts to their own T3 environment and reports an unreachable source", async () => {
  const local = EnvironmentId.make("desktop");
  const server = EnvironmentId.make("server");
  const context = (hostId: string, sshAlias: string | null): CodexDesktopHistoryContext => ({
    providerInstanceId: ProviderInstanceId.make("work-codex"),
    hostId,
    label: hostId,
    sshAlias,
    projects: [{ id: `${hostId}-project`, title: hostId, workspaceRoot: `/${hostId}` }],
    assignments: [{ threadId: `${hostId}-chat`, projectId: `${hostId}-project` }],
  });
  const sources = [
    context("local", null),
    context("ssh:server", "server"),
    context("ssh:offline", "offline"),
  ];
  const result = await discoverCodexHistoryTargets({
    environmentIds: [local],
    discover: async () => sources,
    connectSsh: async (alias) => {
      if (alias === "offline") throw new Error("Host unavailable");
      return server;
    },
  });
  expect(result.targets.get(local)).toEqual([sources[0]]);
  expect(result.targets.get(server)).toEqual([
    { ...sources[1], providerInstanceId: ProviderInstanceId.make("codex") },
  ]);
  expect(result.failures).toEqual(["ssh:offline: Host unavailable"]);
});
