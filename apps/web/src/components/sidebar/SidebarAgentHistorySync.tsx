import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";

import { agentSessionSync } from "../../state/agentSessions";
import { Atom } from "effect/reactivity";
import { environmentSummaries } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async () => {
    const targets = registry.get(syncableEnvironmentsAtom);
    if (targets.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const results = await Promise.allSettled(
        targets.map((environmentId) => sync({ environmentId, input: {} })),
      );
      let importedCount = 0;
      let skippedCount = 0;
      let unlinkedProjectCount = 0;
      let membershipErrorCount = 0;
      let failedConnections =
        registry.get(environmentSummaries.connectedEnvironmentIdsAtom).length - targets.length;
      let truncated = false;
      for (const result of results) {
        if (result.status !== "fulfilled" || result.value._tag !== "Success") {
          failedConnections++;
          continue;
        }
        const value = result.value.value;
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
          description: `${targets.length} connected machines checked; ${failedConnections} connections could not sync. Servers need the current T3 version. ${importedCount} chats checked. ${skippedCount} skipped; ${unlinkedProjectCount} source folders need a linked project. ${membershipErrorCount} Codex connections could not synchronize project membership.${truncated ? " Discovery reached its limit." : ""}${skippedCount > 0 ? " Sync again to continue; persistent skips need inspection." : ""}`,
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
          {label}. Import conversation history and reconcile project folders on connected machines.
          Offline machines must reconnect before syncing.
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
