import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import type { SidebarProviderEntry } from "./SidebarThreadRow";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { sidebarEnvironmentRowId } from "./SidebarEnvironmentHeader";

export function sidebarProviderRowId(environmentId: EnvironmentId, instanceId: string) {
  return `provider:${environmentId}:${instanceId}`;
}

export const SidebarProviderHeader = memo(function SidebarProviderHeader(props: {
  environmentId: EnvironmentId;
  instanceId: string;
  provider: SidebarProviderEntry | undefined;
  collapsed: boolean;
  onToggle: (environmentId: EnvironmentId, instanceId: string) => void;
}) {
  const provider = props.provider;
  return (
    <li className="mt-1 list-none" data-testid="sidebar-provider">
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={sidebarProviderRowId(props.environmentId, props.instanceId)}
        data-sidebar-parent={sidebarEnvironmentRowId(props.environmentId)}
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(props.environmentId, props.instanceId)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) pe-(--sidebar-row-content-inset) ps-7 text-left text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0", props.collapsed && "-rotate-90")}
        />
        {provider ? (
          <ProviderInstanceIcon
            driverKind={provider.driverKind}
            displayName={provider.displayName}
            size="compact"
          />
        ) : (
          <BotIcon aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{provider?.displayName ?? props.instanceId}</span>
      </button>
    </li>
  );
});
