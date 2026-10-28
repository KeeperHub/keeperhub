import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pagination } from "@/components/analytics/runs-table";
import { MAX_PAGE } from "@/lib/analytics/runs-query";

const PAGE_SIZE = 50;
// Far past MAX_PAGE * PAGE_SIZE, so the real total alone would keep paging.
const HUGE_TOTAL = 5_000_000;

function render(page: number): string {
  return renderToStaticMarkup(
    <Pagination
      loading={false}
      onPageChange={() => undefined}
      page={page}
      pageSize={PAGE_SIZE}
      total={HUGE_TOTAL}
    />
  );
}

// The Next button is the last one in the pager; `disabled` renders bare.
function nextIsDisabled(html: string): boolean {
  const last = html.split("<button").at(-1) ?? "";
  return last.slice(0, last.indexOf(">")).includes('disabled=""');
}

describe("runs table pager", () => {
  it("stops offering pages at the ceiling the route clamps to", () => {
    // Derived from the real total the pager would count 100000 pages, and Next
    // stayed enabled on a page the route clamps back to MAX_PAGE: the click
    // re-fetched the same rows while the range label read further on.
    expect(nextIsDisabled(render(MAX_PAGE))).toBe(true);
  });

  it("still offers the next page below the ceiling", () => {
    expect(nextIsDisabled(render(MAX_PAGE - 1))).toBe(false);
    expect(nextIsDisabled(render(3))).toBe(false);
  });

  it("never shows notifications as part of a count of runs", () => {
    // 10 runs and 40 notifications listed: paging covers all 50 rows, but the
    // only figure shown is the page, not "1-50 of 10".
    const html = renderToStaticMarkup(
      <Pagination
        listTotal={50}
        loading={false}
        onPageChange={() => undefined}
        page={1}
        pageSize={20}
        total={10}
      />
    );
    expect(html).toContain("Page 1 of 3");
    expect(html).not.toContain(" of 10");
    expect(nextIsDisabled(html)).toBe(false);
  });

  it("keeps the row range when nothing but runs is listed", () => {
    const html = renderToStaticMarkup(
      <Pagination
        listTotal={120}
        loading={false}
        onPageChange={() => undefined}
        page={2}
        pageSize={50}
        total={120}
      />
    );
    expect(html).toContain("51\u2013100 of 120");
  });

  it("pages over notifications even when no run matches", () => {
    const html = renderToStaticMarkup(
      <Pagination
        listTotal={60}
        loading={false}
        onPageChange={() => undefined}
        page={1}
        pageSize={50}
        total={0}
      />
    );
    expect(html).toContain("Page 1 of 2");
    expect(nextIsDisabled(html)).toBe(false);
  });
});
