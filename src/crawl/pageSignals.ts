import { Page, Response } from "playwright";

export type NavDebug = {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  title: string;
  blockReason: string | null;
};

function matchAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return n;
  }
  return null;
}

export async function collectNavDebug(
  page: Page,
  requestedUrl: string,
  response: Response | null,
): Promise<NavDebug> {
  const finalUrl = page.url();
  const status = response ? response.status() : null;
  const title = await page.title().catch(() => "");

  const bodyText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? "")
    .catch(() => "");

  const reason =
    matchAny(title, ["captcha", "access denied", "suspicious", "verify", "bot"]) ??
    matchAny(bodyText, [
      "unusual traffic",
      "automated requests",
      "verify you are human",
      "captcha",
      "access denied",
      "request blocked",
      "temporarily blocked",
      "something went wrong",
    ]);

  return {
    requestedUrl,
    finalUrl,
    status,
    title,
    blockReason: reason,
  };
}

