import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";

import { agentSessionSync } from "../../state/agentSessions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarAgentHistorySync() {
  const environmentId = usePrimaryEnvironmentId();
  const allowed = useAtomValue(agentSessionSync.permissionAtom(environmentId));
  const registry = useContext(RegistryContext);
  const sync = useAtomCommand(agentSessionSync);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async () => {
    if (
      environmentId === null ||
      inFlight.current ||
      !registry.get(agentSessionSync.permissionAtom(environmentId))
    )
      return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await sync({ environmentId, input: {} });
      if (result._tag !== "Success") return;
      const { importedCount, skippedCount, unlinkedProjectCount, truncated, membershipErrorCount } =
        result.value;
      const incomplete =
        skippedCount > 0 || unlinkedProjectCount > 0 || truncated || membershipErrorCount > 0;
      toastManager.add(
        stackedThreadToast({
          type: incomplete ? "warning" : "success",
          title: incomplete ? "History sync needs attention" : "Agent history synchronized",
          description: `${importedCount} chats checked. ${skippedCount} skipped; ${unlinkedProjectCount} source folders need a linked project. ${membershipErrorCount} Codex connections could not synchronize project membership.${truncated ? " Discovery reached its limit." : ""}${skippedCount > 0 ? " Sync again to continue; persistent skips need inspection." : ""}`,
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
              disabled={!allowed || pending || environmentId === null}
              onClick={() => void run()}
              size="icon"
            >
              <RefreshCwIcon aria-hidden />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          {label}. Load new chats and full conversation history for linked folders on this
          connection.
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
