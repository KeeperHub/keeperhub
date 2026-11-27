import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RunCardHeader,
  runCardStepCount,
  spokenRunStatus,
} from "@/components/workflow/run-card-header";

const STARTED_AT = new Date(Date.now() - 52 * 60 * 1000).toISOString();

function render(
  overrides: Partial<Parameters<typeof RunCardHeader>[0]> = {}
): string {
  return renderToStaticMarkup(
    <RunCardHeader
      durationMs={40_000}
      isExpanded={false}
      onOpenVersion={() => undefined}
      onSelect={() => undefined}
      onToggle={() => undefined}
      ranVersion={null}
      runNumber={2}
      startedAt={STARTED_AT}
      status="error"
      statusDotClass="bg-red-600"
      statusIcon={null}
      statusTitle="Failed - expand for the error"
      stepCount={3}
      {...overrides}
    />
  );
}

// The opening tag of the first element carrying `marker`.
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("RunCardHeader", () => {
  it("shows the step count on a closed run", () => {
    expect(render({ isExpanded: false })).toContain(
      'data-testid="run-step-count">3 steps<'
    );
  });

  it("hides the step part when the run has none", () => {
    const html = render({ stepCount: 0 });
    expect(html).not.toContain("run-step-count");
    expect(html).not.toContain("0 steps");
  });

  it("names the status button with the run and its status", () => {
    const button = tagWith(render(), 'aria-label="Steps of run #2, failed"');
    expect(button).toContain('aria-expanded="false"');
  });

  it("keeps one name while aria-expanded says whether it is open", () => {
    const button = tagWith(
      render({ isExpanded: true, status: "success" }),
      'aria-label="Steps of run #2, succeeded"'
    );
    expect(button).toContain('aria-expanded="true"');
  });

  it("names the chevron toggle and says whether it is open", () => {
    const chevron = tagWith(
      render({ isExpanded: true }),
      'aria-label="Steps of run #2"'
    );
    expect(chevron).toContain('aria-expanded="true"');
    expect(chevron).toContain("pointer-coarse:size-11");
  });

  it("says on the card body whether the run is open, since it opens it too", () => {
    for (const isExpanded of [false, true]) {
      const body = tagWith(render({ isExpanded }), "w-full min-w-0 text-left");
      expect(body).toContain(`aria-expanded="${isExpanded}"`);
    }
  });

  it("gives screen readers the line in words", () => {
    expect(render()).toContain(
      '<span class="sr-only">52 minutes ago, ran 40 seconds, 3 steps</span>'
    );
  });

  it("puts the version pill outside the run line", () => {
    const html = render({ ranVersion: 7 });
    const line = html.slice(
      html.indexOf('data-testid="run-line"'),
      html.indexOf("</button>", html.indexOf('data-testid="run-line"'))
    );
    expect(html).toContain('title="Ran version 7');
    expect(line).not.toContain("Ran version");
  });
});

describe("spokenRunStatus", () => {
  it("falls back to pending for an unknown status", () => {
    expect(spokenRunStatus("pending")).toBe("pending");
    expect(spokenRunStatus("system_error")).toBe("system error");
  });
});

describe("runCardStepCount", () => {
  const logs = [{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "b" }];

  it("uses the list's count for a closed run", () => {
    expect(runCardStepCount(1, false, logs)).toBe(1);
  });

  it("counts an open run's loaded steps once each when they are ahead", () => {
    expect(runCardStepCount(1, true, logs)).toBe(2);
    expect(runCardStepCount(4, true, logs)).toBe(4);
  });
});
