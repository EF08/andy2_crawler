import { Page } from "playwright";
import { Behavior } from "../config/types";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function randomWait(minMs: number, maxMs: number): Promise<void> {
  const waitMs = randomInt(minMs, maxMs);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/**
 * Simulates realistic human interaction before extraction.
 * Multiple small movements + scrolls at varying speeds.
 */
export async function humanizeBeforeExtract(page: Page, behavior: Behavior): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };

  // Move to a slightly random spot in the viewport.
  const x1 = randomInt(Math.floor(vp.width * 0.2), Math.floor(vp.width * 0.7));
  const y1 = randomInt(Math.floor(vp.height * 0.15), Math.floor(vp.height * 0.5));
  await page.mouse.move(x1, y1, { steps: randomInt(12, 30) });
  await randomWait(300, 800);

  // Small scroll — like reading content.
  await page.mouse.wheel(0, randomInt(100, 350));
  await randomWait(400, 1200);

  // Second movement to a different area.
  const x2 = randomInt(Math.floor(vp.width * 0.1), Math.floor(vp.width * 0.8));
  const y2 = randomInt(Math.floor(vp.height * 0.3), Math.floor(vp.height * 0.7));
  await page.mouse.move(x2, y2, { steps: randomInt(8, 20) });
  await randomWait(200, 600);

  // Another scroll.
  await page.mouse.wheel(0, randomInt(50, 250));
  await randomWait(Math.floor(behavior.waitMinMs * 0.3), Math.floor(behavior.waitMinMs * 0.6));
}
