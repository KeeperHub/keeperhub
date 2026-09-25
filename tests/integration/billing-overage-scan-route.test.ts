import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthenticate = vi.fn();

vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: (...args: unknown[]) =>
    mockAuthenticate(...args),
}));

const mockBillOverageForOrg = vi.fn();

vi.mock("@/lib/billing/overage", () => ({
  billOverageForOrg: (...args: unknown[]) => mockBillOverageForOrg(...args),
}));

const mockCloseCalendarMonthUsage = vi.fn();

vi.mock("@/lib/billing/execution-usage-periods", () => ({
  closeCalendarMonthUsage: (...args: unknown[]) =>
    mockCloseCalendarMonthUsage(...args),
}));

/**
 * Two reads in order: the ended-period subscriptions handled by the overage
 * loop, then the pending/failed retry records. The calendar-month close does
 * its own reads inside closeCalendarMonthUsage, which is mocked here and
 * exercised against a real database in tests/db.
 */
const selectResults: unknown[][] = [];

/**
 * Drizzle's builder is itself awaitable, so `.from(...)` has to resolve on its
 * own as well as offer `.where(...)`. A real promise carries that without the
 * mock declaring a `then` of its own.
 */
type SelectChain = Promise<unknown[]> & { where: () => Promise<unknown[]> };

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => {
        const rows = selectResults.shift() ?? [];
        const chain = Promise.resolve(rows) as SelectChain;
        chain.where = () => Promise.resolve(rows);
        return chain;
      },
    }),
  },
}));

import { POST } from "@/app/api/billing/overage/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/billing/overage", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  mockAuthenticate.mockResolvedValue({ authenticated: true });
  mockCloseCalendarMonthUsage.mockResolvedValue({
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    considered: 2,
    recorded: 2,
    skipped: 0,
  });
});

describe("POST /api/billing/overage scan", () => {
  it("reports the calendar-month close alongside the overage scan", async () => {
    // No ended provider periods and no retry records, so the response carries
    // only what the month close did.
    selectResults.push([], []);

    const response = await POST(makeRequest({ scan: true }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockCloseCalendarMonthUsage).toHaveBeenCalledWith(expect.any(Date));
    expect(json.calendarMonths).toMatchObject({
      considered: 2,
      recorded: 2,
      skipped: 0,
    });
  });

  it("runs the month close after the charges, not instead of them", async () => {
    selectResults.push(
      [
        {
          organizationId: "org_stripe",
          periodStart: new Date(Date.UTC(2026, 7, 1)),
          periodEnd: new Date(Date.UTC(2026, 8, 1)),
        },
      ],
      []
    );
    mockBillOverageForOrg.mockResolvedValue({ billed: true });

    const response = await POST(makeRequest({ scan: true }));
    const json = await response.json();

    expect(json.scanned).toBe(1);
    expect(mockBillOverageForOrg).toHaveBeenCalledTimes(1);
    expect(mockCloseCalendarMonthUsage).toHaveBeenCalledTimes(1);
  });

  it("does not fail the scan when the month close throws", async () => {
    // The charges above are already raised by this point, so a failure here
    // must be reported rather than turned into a non-2xx that makes the Job
    // retry the billing it already did.
    selectResults.push([], []);
    mockCloseCalendarMonthUsage.mockRejectedValue(new Error("boom"));

    const response = await POST(makeRequest({ scan: true }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.calendarMonths).toHaveProperty("error");
  });

  it("rejects an unauthenticated caller", async () => {
    mockAuthenticate.mockResolvedValue({
      authenticated: false,
      error: "nope",
      status: 401,
    });

    const response = await POST(makeRequest({ scan: true }));

    expect(response.status).toBe(401);
  });
});
