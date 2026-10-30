import type { Locator } from "@playwright/test";

// WCAG contrast of its text against the backgrounds painted behind it,
// translucent layers blended in. Throws on a colour it cannot read.
export async function textContrast(locator: Locator): Promise<number> {
  return await locator.evaluate((element) => {
    const ctx = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    });
    if (!ctx) {
      throw new Error("no 2d canvas");
    }
    const SENTINEL = "#010203";
    const rgba = (css: string): number[] => {
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = css;
      if (ctx.fillStyle === SENTINEL) {
        throw new Error(`unreadable colour: ${css}`);
      }
      ctx.clearRect(0, 0, 1, 1);
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
    const base = layers.pop();
    if (!base || base[3] < 1) {
      throw new Error("no opaque background behind the text");
    }
    let bg = base.slice(0, 3);
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
