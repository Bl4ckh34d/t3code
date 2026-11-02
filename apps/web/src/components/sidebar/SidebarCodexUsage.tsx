import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProviderUsageLimits } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { providersIgnoringCheckedAtAtom } from "~/state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function WeeklyUsageRing({ usage }: { usage: ServerProviderUsageLimits | undefined }) {
  const weekly = usage?.unavailable
    ? undefined
    : usage?.windows.find((window) => window.kind === "weekly");
  const remaining = weekly ? remainingPercent(weekly) : null;
  const label =
    remaining === null ? "Wöchentlich · Kontingent unbekannt" : `Wöchentlich · noch ${remaining} %`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground"
          />
        }
      >
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2"
          />
          {remaining !== null ? (
            <>
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                pathLength="100"
                strokeDasharray={`${remaining} 100`}
                transform="rotate(-90 12 12)"
              />
              <rect
                x="9"
                y="9"
                width="6"
                height="6"
                rx="1"
                fill="currentColor"
                fillOpacity="0.55"
                transform="rotate(45 12 12)"
              />
            </>
          ) : (
            <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="12">
              ?
            </text>
          )}
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="right">
        <div>{label}</div>
        {weekly?.resetsAt && <div>Zurückgesetzt: {new Date(weekly.resetsAt).toLocaleString()}</div>}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SidebarCodexUsage({
  environmentId,
  instanceId,
}: {
  environmentId: EnvironmentId;
  instanceId: string;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return (
    <WeeklyUsageRing
      usage={provider?.enabled && provider.installed ? provider.usageLimits : undefined}
    />
  );
}
