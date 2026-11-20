import type { Locator, Page } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

// An announcement banner can sit above the header. Tests about what is
// under it start with it out of the way.
export async function dismissPhoneOverlays(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("kh-billing-announce-v1", "1");
    } catch {
      // A sandboxed frame has no storage, and no banner either.
    }
  });
}

function measured(target: Locator | Box): Promise<Box> | Box {
  return "boundingBox" in target ? box(target) : target;
}

// Pass a short timeout inside toPass, so a vanished element fails the
// attempt instead of waiting out the whole retry window.
export async function box(
  locator: Locator,
  options?: { timeout?: number }
): Promise<Box> {
  const found = await locator.boundingBox(options);
  if (!found) {
    throw new Error("element is not rendered");
  }
  return found;
}

// Either side may be a box the caller has already measured.
export async function overlaps(
  a: Locator | Box,
  b: Locator | Box
): Promise<boolean> {
  const [p, q] = await Promise.all([measured(a), measured(b)]);
  return (
    p.x < q.x + q.width &&
    q.x < p.x + p.width &&
    p.y < q.y + q.height &&
    q.y < p.y + p.height
  );
}

// Whether the centre of an element is drawn on top, so a tap there reaches it.
// corners: its corners too, 3px in (past the rounding, which hit testing follows).
export async function isOnTop(
  locator: Locator,
  options?: { corners?: boolean }
): Promise<boolean> {
  return await locator.evaluate((element, corners) => {
    const r = element.getBoundingClientRect();
    const points = [[r.left + r.width / 2, r.top + r.height / 2]];
    if (corners) {
      points.push(
        [r.left + 3, r.top + 3],
        [r.right - 3, r.top + 3],
        [r.left + 3, r.bottom - 3],
        [r.right - 3, r.bottom - 3]
      );
    }
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit);
    });
  }, options?.corners === true);
}

// How far the page scrolls sideways; 0 or less when it does not. clientWidth
// leaves out a vertical scrollbar, which innerWidth would count as room.
export async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
}

// Its text is all inside its box. A squeezed box can still look fine to a
// bounding-box check while the text spills out of it or is cut off.
export async function textFits(locator: Locator): Promise<boolean> {
  return await locator.evaluate(
    (element) => element.scrollWidth <= element.clientWidth
  );
}
