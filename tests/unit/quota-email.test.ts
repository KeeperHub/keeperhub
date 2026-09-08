import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendExecutionQuotaEmail } from "@/lib/email";

// Captures the SendGrid payload instead of sending it, so the rendered copy can
// be asserted without a network call.
type Captured = { subject: string; text: string; html: string };

let captured: Captured | null = null;

beforeEach(() => {
  process.env.SENDGRID_API_KEY = "test-key";
  captured = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      captured = {
        subject: body.personalizations[0].subject,
        text: body.content.find(
          (c: { type: string }) => c.type === "text/plain"
        ).value,
        html: body.content.find((c: { type: string }) => c.type === "text/html")
          .value,
      };
      return new Response("{}", { status: 202 });
    })
  );
});

const BASE = {
  email: "owner@example.com",
  orgName: "Acme",
  resetDate: new Date("2026-09-01T00:00:00.000Z"),
  plansUrl: "https://app.example.com/settings/org_1/plans",
  billingUrl: "https://app.example.com/settings/org_1/billing",
};

const PAYG = {
  priceUsdc: "0.010000",
  dailyCapUsdc: "5.000000",
  periodCapUsdc: "50.000000",
  chainName: "Base",
  assetUrl: "https://basescan.org/token/0xUSDC",
};

async function renderOverage(
  limit: number,
  planLabel: string,
  overageRatePerThousand: number
): Promise<Captured> {
  await sendExecutionQuotaEmail({
    ...BASE,
    planLabel,
    threshold: 100,
    used: limit,
    limit,
    usagePercent: 100,
    payg: null,
    overageRatePerThousand,
  });
  if (!captured) {
    throw new Error("no email captured");
  }
  return captured;
}

describe("overage plans are offered the next tier up", () => {
  it("steps within Pro", async () => {
    const first = await renderOverage(25_000, "Pro", 2);
    expect(first.text).toContain("Pro 50,000 gets you 2x the executions");
    expect(first.text).toContain("$89 a month");

    const second = await renderOverage(50_000, "Pro", 2);
    expect(second.text).toContain("Pro 100,000 gets you 2x the executions");
  });

  it("crosses from the top of Pro into Business", async () => {
    const captured_ = await renderOverage(100_000, "Pro", 2);
    expect(captured_.text).toContain(
      "Business 250,000 gets you 2.5x the executions"
    );
    expect(captured_.text).toContain("$299 a month");
  });

  it("steps within Business", async () => {
    const captured_ = await renderOverage(250_000, "Business", 1.5);
    expect(captured_.text).toContain(
      "Business 500,000 gets you 2x the executions"
    );
  });

  it("offers a conversation, not a pricing page, past the top tier", async () => {
    const captured_ = await renderOverage(1_000_000, "Business", 1.5);
    expect(captured_.text).toContain("past our largest published tier");
    expect(captured_.text).not.toContain("gets you");
    // An org at this volume is not helped by a self-serve link.
    expect(captured_.text).toContain("Talk to us: human@keeperhub.com");
    expect(captured_.text).not.toContain("See plans");
    expect(captured_.html).toContain(
      'href="mailto:human@keeperhub.com?subject=Custom%20plan%20enquiry"'
    );
    expect(captured_.html).toContain(">Talk to us</a>");
  });

  it("keeps the plans link for an org that still has a tier above it", async () => {
    const captured_ = await renderOverage(250_000, "Business", 1.5);
    expect(captured_.text).toContain("See plans:");
    expect(captured_.text).not.toContain("Talk to us");
  });

  it("prices a fractional overage rate as money", async () => {
    const captured_ = await renderOverage(250_000, "Business", 1.5);
    expect(captured_.text).toContain("$1.50 per 1,000");
    expect(captured_.text).not.toContain("$1.5 per");
  });

  it("quotes the crossover where overage costs the same as the step", async () => {
    // Pro 25k to 50k is a $40 step; at $2 per 1,000 that is 20,000 executions.
    const captured_ = await renderOverage(25_000, "Pro", 2);
    expect(captured_.text).toContain("at 45,000 executions");
  });

  it("suggests a tier but no crossover for a custom quota", async () => {
    // A planOverrides quota matches no published tier, so the step price is
    // unknown and the crossover claim is dropped rather than guessed.
    const captured_ = await renderOverage(40_000, "Pro", 2);
    expect(captured_.text).toContain("Pro 50,000");
    expect(captured_.text).not.toContain("roughly what overage costs");
  });

  it("does not tell a paid org its workflows stopped", async () => {
    const captured_ = await renderOverage(25_000, "Pro", 2);
    expect(captured_.subject).toContain("used all its included");
    expect(captured_.text).toContain("Nothing has stopped");
  });
});

describe("free plan on pay-as-you-go", () => {
  it("names both conditions that keep executions running", async () => {
    await sendExecutionQuotaEmail({
      ...BASE,
      planLabel: "Free",
      threshold: 100,
      used: 5000,
      limit: 5000,
      usagePercent: 100,
      payg: PAYG,
      overageRatePerThousand: null,
    });
    const email = captured as unknown as Captured;
    expect(email.text).toContain("Wallet balance");
    expect(email.text).toContain("Spend caps");
    expect(email.text).toContain("$5 a day and $50 a month");
  });

  it("compares against the current tier's included quota", async () => {
    await sendExecutionQuotaEmail({
      ...BASE,
      planLabel: "Pay per execution",
      threshold: 100,
      used: 5000,
      limit: 5000,
      usagePercent: 100,
      payg: PAYG,
      overageRatePerThousand: null,
    });
    const email = captured as unknown as Captured;
    expect(email.text).toContain("Pro gets you 5x your 5,000 free executions");
    // The gain carries the emphasis in HTML only.
    expect(email.html).toContain("<strong");
    expect(email.text).not.toContain("<strong");
  });

  it("calls the allowance free, and never promises an unconditional run", async () => {
    await sendExecutionQuotaEmail({
      ...BASE,
      planLabel: "Pay per execution",
      threshold: 80,
      used: 4013,
      limit: 5000,
      usagePercent: 80,
      payg: PAYG,
      overageRatePerThousand: null,
    });
    const email = captured as unknown as Captured;
    expect(email.text).toContain(
      "4,013 of the 5,000 free executions included in Pay per execution"
    );
    // An empty wallet does stop executions, so nothing may claim otherwise.
    expect(email.text).not.toContain("Nothing stops");
    expect(email.text).not.toContain("have not stopped");
  });
});
