import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshot, invalidateFeatureSnapshot } from "@/hooks/use-features";

type Answer = { resolve: (body: unknown) => void };

function answerable(): { answers: Answer[]; fetch: typeof fetch } {
  const answers: Answer[] = [];
  const fake = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answers.push({
          resolve: (body) =>
            resolve(new Response(JSON.stringify(body), { status: 200 })),
        });
      })
  );
  return { answers, fetch: fake as unknown as typeof fetch };
}

afterEach(() => {
  invalidateFeatureSnapshot();
  vi.unstubAllGlobals();
});

describe("fetchSnapshot after an organization switch", () => {
  it("never caches a read started for the old organization", async () => {
    const { answers, fetch } = answerable();
    vi.stubGlobal("fetch", fetch);
    const oldRead = fetchSnapshot();
    invalidateFeatureSnapshot();
    const newRead = fetchSnapshot();
    await vi.waitFor(() => expect(answers).toHaveLength(2));

    // The new organization answers first, the old read last.
    answers[1].resolve({ bundleSendEnabled: false });
    expect(await newRead).toMatchObject({ bundleSendEnabled: false });
    answers[0].resolve({ bundleSendEnabled: true });
    // The old read is answered with the new organization's snapshot.
    expect(await oldRead).toMatchObject({ bundleSendEnabled: false });
    expect(await fetchSnapshot()).toMatchObject({ bundleSendEnabled: false });
    expect(answers).toHaveLength(2);
  });
});
