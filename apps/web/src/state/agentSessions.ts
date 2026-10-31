import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

export const agentSessionSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync",
  tag: WS_METHODS.agentSessionsSync,
});

export const agentSessionMove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:move",
  tag: WS_METHODS.agentSessionsMove,
});
