import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";

import { agentSessionDesktopSources, agentSessionSync } from "../../state/agentSessions";
import { connectSshEnvironment as connectSshEnvironmentCommand } from "../../connection/onboarding";
import { environmentCatalog } from "../../connection/catalog";
import { discoverCodexHistoryTargets } from "./codexHistoryTargets";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { environmentSummaries } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCodexSidebarOrders } from "./codexSidebarOrder";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";

const folderOrderSchema = Schema.Array(Schema.String);

const syncableEnvironmentsAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).filter((id) =>
    get(agentSessionSync.permissionAtom(id)),
  ),
);

export function SidebarAgentHistorySync() {
  const environmentIds = useAtomValue(syncableEnvironmentsAtom);
  const allowed = environmentIds.length > 0;
  const registry = useContext(RegistryContext);
  const sync = useAtomCommand(agentSessionSync);
  const discoverSources = useAtomCommand(agentSessionDesktopSources, { reportFailure: false });
  const connectSsh = useAtomCommand(connectSshEnvironmentCommand, { reportFailure: false });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [, setCodexOrders] = useCodexSidebarOrders();
  const run = async () => {
    const initialTargets = registry.get(syncableEnvironmentsAtom);
    if (initialTargets.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const findSsh = (alias: string) =>
        [...registry.get(environmentCatalog.catalogValueAtom).entries].find(
          ([, entry]) =>
            Option.isSome(entry.profile) &&
            entry.profile.value._tag === "SshConnectionProfile" &&
            (entry.profile.value.target.alias === alias ||
              entry.profile.value.target.hostname === alias),
        )?.[0];
      const discovery = await discoverCodexHistoryTargets({
        environmentIds: initialTargets,
        discover: async (environmentId) => {
          const result = await discoverSources({ environmentId, input: {} });
          if (result._tag !== "Success") throw Cause.squash(result.cause);
          return result.value.sources;
        },
        connectSsh: async (alias, label) => {
          const existing = findSsh(alias);
          if (
            existing &&
            registry.get(environmentSummaries.connectedEnvironmentIdsAtom).includes(existing)
          )
            return existing;
          if (!window.desktopBridge)
            throw new Error("Connect this Codex host through the T3 desktop app first.");
          const target = await window.desktopBridge.resolveSshHost(alias);
          const connected = await connectSsh({ target, label });
          if (connected._tag !== "Success") throw Cause.squash(connected.cause);
          const environmentId = findSsh(alias);
          if (!environmentId)
            throw new Error("The SSH connection did not register its T3 environment.");
          return environmentId;
        },
      });
      const targets = [...discovery.targets.keys()];
      const results = await Promise.allSettled(
        targets.map((environmentId) =>
          sync({
            environmentId,
            input: { desktopContexts: discovery.targets.get(environmentId) ?? [] },
          }),
        ),
      );
      let importedCount = 0;
      let skippedCount = 0;
      let unlinkedProjectCount = 0;
      let membershipErrorCount = 0;
      let failedConnections =
        Math.max(
          0,
          registry.get(environmentSummaries.connectedEnvironmentIdsAtom).length - targets.length,
        ) + discovery.failures.length;
      let truncated = false;
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled" || result.value._tag !== "Success") {
          failedConnections++;
          continue;
        }
        const value = result.value.value;
        const environmentId = targets[index]!;
        if (value.sidebarOrder) {
          const order = value.sidebarOrder;
          setCodexOrders((orders) => ({ ...orders, [environmentId]: order }));
          writeLocalStorageValue(
            "t3.sidebar.project-folder-order.v1",
            (ids) => ids.filter((id) => !id.startsWith(`folder:${environmentId}:`)),
            [],
            folderOrderSchema,
          );
        }
        importedCount += value.importedCount;
        skippedCount += value.skippedCount;
        unlinkedProjectCount += value.unlinkedProjectCount;
        membershipErrorCount += value.membershipErrorCount;
        truncated ||= value.truncated;
      }
      const incomplete =
        failedConnections > 0 ||
        skippedCount > 0 ||
        unlinkedProjectCount > 0 ||
        truncated ||
        membershipErrorCount > 0;
      toastManager.add(
        stackedThreadToast({
          type: incomplete ? "warning" : "success",
          title: incomplete ? "History sync needs attention" : "Agent history synchronized",
          description: `${targets.length} connected machines checked; ${failedConnections} connections could not sync. Servers need the current T3 version. ${importedCount} chats checked. ${skippedCount} skipped; ${unlinkedProjectCount} source folders need a linked project. ${membershipErrorCount} Codex connections could not synchronize project membership.${truncated ? " Discovery reached its limit." : ""}${skippedCount > 0 ? " Sync again to continue; persistent skips need inspection." : ""}${discovery.failures.length > 0 ? ` ${discovery.failures.join(" ")}` : ""}`,
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "History sync failed",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const label = pending ? "Synchronizing agent history…" : "Sync agent history";
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              disabled={!allowed || pending}
              onClick={() => void run()}
              size="icon"
            >
              <RefreshCwIcon aria-hidden />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          {label}. Copy Codex names, project membership and sidebar order to T3 on connected
          machines. Offline machines must reconnect before syncing.
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
