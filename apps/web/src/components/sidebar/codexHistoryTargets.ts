import {
  ProviderInstanceId,
  type CodexDesktopHistoryContext,
  type EnvironmentId,
} from "@t3tools/contracts";

export interface CodexHistoryDiscovery {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly discover: (
    environmentId: EnvironmentId,
  ) => Promise<ReadonlyArray<CodexDesktopHistoryContext>>;
  readonly connectSsh: (alias: string, label: string) => Promise<EnvironmentId>;
}

export async function discoverCodexHistoryTargets(input: CodexHistoryDiscovery) {
  const targets = new Map(
    input.environmentIds.map((id) => [id, [] as CodexDesktopHistoryContext[]]),
  );
  const failures: string[] = [];
  const connected = new Map<string, EnvironmentId>();
  for (const environmentId of input.environmentIds) {
    try {
      for (const source of await input.discover(environmentId)) {
        try {
          let destination = environmentId;
          let context = source;
          if (source.hostId !== "local") {
            if (source.sshAlias === null)
              throw new Error("This Codex host has no supported SSH connection.");
            destination =
              connected.get(source.sshAlias) ??
              (await input.connectSsh(source.sshAlias, source.label));
            connected.set(source.sshAlias, destination);
            context = { ...source, providerInstanceId: ProviderInstanceId.make("codex") };
          }
          const contexts = targets.get(destination) ?? [];
          if (!contexts.some((entry) => entry.providerInstanceId === context.providerInstanceId)) {
            targets.set(destination, [...contexts, context]);
          }
        } catch (error) {
          failures.push(
            `${source.label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      failures.push(`${environmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { targets, failures };
}
