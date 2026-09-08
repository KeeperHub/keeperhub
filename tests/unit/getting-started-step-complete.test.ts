import { describe, expect, it } from "vitest";
import type { Step } from "@/lib/onboarding/getting-started-config";
import { isChipAwareStepComplete } from "@/lib/onboarding/getting-started-step-complete";

const chipStep: Step = {
  key: "run-workflow",
  title: "Run your first workflow",
  description: "desc",
  signal: "ranWorkflow",
  actionLabel: "Run",
  info: { summary: "summary", sections: [] },
  chips: [
    {
      id: "aave-health",
      label: "Aave health factor",
      prompt: "Monitor Aave",
    },
  ],
};

const noChipStep: Step = {
  key: "connect-alerts",
  title: "Connect alerts",
  description: "desc",
  signal: "alertsConnected",
  actionLabel: "Connect",
  info: { summary: "summary", sections: [] },
};

const live = (id: string | undefined): boolean => Boolean(id);
const dead = (_id: string | undefined): boolean => false;
const noSignal = (): boolean => false;
const yesSignal = (): boolean => true;
const notClickDriven = (): boolean => false;

describe("isChipAwareStepComplete", () => {
  it("never-cloned + done latch stays complete", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: ["run-workflow"],
        workflows: {},
        status: null,
        isWorkflowLive: live,
        resolveRealSignal: noSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(true);
  });

  it("never-cloned + not done is incomplete without a real signal", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: [],
        workflows: {},
        status: null,
        isWorkflowLive: live,
        resolveRealSignal: noSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(false);
  });

  it("never-cloned + real signal is complete", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: [],
        workflows: {},
        status: {
          hasApiKey: false,
          hasIntegration: false,
          executedWorkflowIds: [],
        },
        isWorkflowLive: live,
        resolveRealSignal: yesSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(true);
  });

  it("ever-cloned + live clone is complete even without done latch", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: [],
        workflows: { "run-workflow:aave-health": "wf-1" },
        status: null,
        isWorkflowLive: live,
        resolveRealSignal: noSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(true);
  });

  it("ever-cloned + deleted clone un-completes without a real signal", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: ["run-workflow"],
        workflows: { "run-workflow:aave-health": "wf-1" },
        status: {
          hasApiKey: false,
          hasIntegration: false,
          executedWorkflowIds: [],
        },
        isWorkflowLive: dead,
        resolveRealSignal: noSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(false);
  });

  it("ever-cloned + deleted clone stays complete when real signal fires", () => {
    expect(
      isChipAwareStepComplete({
        step: chipStep,
        done: [],
        workflows: { "run-workflow:aave-health": "wf-1" },
        status: {
          hasApiKey: false,
          hasIntegration: false,
          executedWorkflowIds: ["wf-1"],
        },
        isWorkflowLive: dead,
        resolveRealSignal: yesSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(true);
  });

  it("non-chip steps still honor the done latch", () => {
    expect(
      isChipAwareStepComplete({
        step: noChipStep,
        done: ["connect-alerts"],
        workflows: {},
        status: null,
        isWorkflowLive: live,
        resolveRealSignal: noSignal,
        isClickDriven: notClickDriven,
      })
    ).toBe(true);
  });
});
