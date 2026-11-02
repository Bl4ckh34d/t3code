import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { orderItemsByPreferredIds, reorderSidebarEnvironments } from "../Sidebar.logic";

const schema = Schema.Array(Schema.String);

export function useSidebarEnvironmentOrder(environmentIds: readonly EnvironmentId[]) {
  const [preferredIds, setPreferredIds] = useLocalStorage<readonly string[], readonly string[]>(
    "t3.sidebar.environment-order.v1",
    [],
    schema,
  );
  const ids = orderItemsByPreferredIds({ items: environmentIds, preferredIds, getId: (id) => id });
  const move = (source: EnvironmentId, target: EnvironmentId, placement: "before" | "after") => {
    setPreferredIds(reorderSidebarEnvironments(ids, source, target, placement));
  };
  return { ids, move };
}
