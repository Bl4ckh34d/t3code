import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("uses synchronized membership for new-chat commands and falls back for ordinary threads", () => {
    const environmentId = EnvironmentId.make("remote");
    const projectId = ProjectId.make("storage");
    const selected = ProjectId.make("selected");
    for (const organizationProjectId of [selected, null, undefined]) {
      expect(
        resolveThreadActionProjectRef({
          activeThread: { environmentId, projectId, organizationProjectId },
          activeDraftThread: null,
          defaultProjectRef: null,
          handleNewThread: async () => {},
        }),
      ).toEqual({ environmentId, projectId: organizationProjectId ?? projectId });
    }
  });
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});
