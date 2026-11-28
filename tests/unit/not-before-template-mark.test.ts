import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  markTemplatedNotBefore,
  readBundleSettings,
} from "@/lib/web3/bundles/settings";
import { processTemplates } from "@/lib/workflow/executor/executor.workflow";
import { createTracker } from "@/lib/workflow/executor/template-resolution";

const WRITE = "web3/write-contract";
const outputs = {
  read: { label: "Read Contract", data: { success: true, result: null } },
};

/** What the executor hands the step: rendered config plus its mark. */
function runConfig(
  actionType: string,
  saved: Record<string, unknown>
): Record<string, unknown> {
  const processed = processTemplates(saved, outputs, createTracker());
  markTemplatedNotBefore(actionType, saved, processed);
  return processed;
}

describe("a templated Not before that resolves empty", () => {
  it("renders a null result to an empty value, and the mark makes the step fail", () => {
    const config = runConfig(WRITE, {
      notBefore: "{{@read:Read Contract.result}}",
    });
    expect(config.notBefore).toBe("");
    expect(config._notBeforeFromTemplate).toBe(true);
    expect(readBundleSettings(config, "run")).toMatchObject({
      ok: true,
      settings: {
        notBeforeRefusal:
          "Not before (notBefore) resolved to an empty value, so nothing was sent.",
      },
    });
  });

  it("marks only Write Contract steps whose saved Not before is a template", () => {
    expect(runConfig(WRITE, { notBefore: "" })).not.toHaveProperty(
      "_notBeforeFromTemplate"
    );
    expect(runConfig(WRITE, { notBefore: "1796126400" })).not.toHaveProperty(
      "_notBeforeFromTemplate"
    );
    expect(
      runConfig("Write Contract", {
        notBefore: "{{@read:Read Contract.result}}",
      })
    ).toHaveProperty("_notBeforeFromTemplate", true);
    expect(
      runConfig("http-request", { notBefore: "{{@read:Read Contract.result}}" })
    ).not.toHaveProperty("_notBeforeFromTemplate");
  });
});
