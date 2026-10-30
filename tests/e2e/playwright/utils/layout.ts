import type { Locator, Page } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

// Below 768px the app warns once that it is best on a larger screen, in a
// dialog over everything, and an announcement banner can sit above the
// header. Tests about what is under them start with both out of the way.
export async function dismissPhoneOverlays(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("keeperhub-mobile-warning-dismissed", "true");
      window.localStorage.setItem("kh-billing-announce-v1", "1");
    } catch {
      // A sandboxed frame has no storage, and no dialog either.
    }
  });
}

function measured(target: Locator | Box): Promise<Box> | Box {
  return "boundingBox" in target ? box(target) : target;
}

export async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
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
export async function isOnTop(locator: Locator): Promise<boolean> {
  return await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

// Its text is all inside its box. A squeezed box can still look fine to a
// bounding-box check while the text spills out of it or is cut off.
export async function textFits(locator: Locator): Promise<boolean> {
  return await locator.evaluate(
    (element) => element.scrollWidth <= element.clientWidth
  );
}

// WCAG contrast of its text against the backgrounds painted behind it,
// translucent layers blended in.
export async function textContrast(locator: Locator): Promise<number> {
  return await locator.evaluate((element) => {
    const ctx = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    });
    if (!ctx) {
      throw new Error("no 2d canvas");
    }
    const rgba = (css: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], base: number[]): number[] =>
      [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]));
    const layers: number[][] = [];
    for (let el: Element | null = element; el; el = el.parentElement) {
      const layer = rgba(getComputedStyle(el).backgroundColor);
      if (layer[3] > 0) {
        layers.push(layer);
      }
      if (layer[3] === 1) {
        break;
      }
    }
    let bg = [255, 255, 255];
    for (const layer of layers.reverse()) {
      bg = over(layer, bg);
    }
    const fg = over(rgba(getComputedStyle(element).color), bg);
    const luminance = (c: number[]): number => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [dark, light] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
    return (light + 0.05) / (dark + 0.05);
  });
}
