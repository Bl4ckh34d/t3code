import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function sidebarEnvironmentRowId(environmentId: EnvironmentId) {
  return `environment:${environmentId}`;
}

export const SidebarEnvironmentHeader = memo(function SidebarEnvironmentHeader(props: {
  environmentId: EnvironmentId;
  label: string;
  machine: EnvironmentMachineKind;
  collapsed: boolean;
  onToggle: (environmentId: EnvironmentId) => void;
}) {
  const environment = useAtomValue(environmentPresentations.presentationAtom(props.environmentId));
  const connection = environment?.connection ?? { phase: "offline", error: null, traceId: null };
  const phase = connection.phase;
  const status = connectionStatusText(connection);
  return (
    <li className="mt-3 list-none first:mt-0" data-testid="sidebar-environment">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={sidebarEnvironmentRowId(props.environmentId)}
              aria-expanded={!props.collapsed}
              aria-label={`${props.label}, ${status}`}
              onClick={() => props.onToggle(props.environmentId)}
              className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-sm font-semibold text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0", props.collapsed && "-rotate-90")}
          />
          <EnvironmentMachineIcon kind={props.machine} aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{props.label}</span>
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", connectionPhaseDotClassName(phase))}
          />
        </TooltipTrigger>
        <TooltipPopup>
          {props.label}: {status}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
});
