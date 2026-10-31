import { AgentSessionSidebarOrder } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";

const CODEX_SIDEBAR_ORDER_KEY = "t3.sidebar.codex-order.v1";
const CodexSidebarOrders = Schema.Record(Schema.String, AgentSessionSidebarOrder);

export function useCodexSidebarOrders() {
  return useLocalStorage(CODEX_SIDEBAR_ORDER_KEY, {}, CodexSidebarOrders);
}
