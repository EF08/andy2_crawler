import { FeedsConfig } from "../config/types";
import { squeezeWhitespace } from "../extract/normalize";
import { FeedItem } from "./types";
import { asArray, fetchFeed, parseXml, stripHtml, textOf, toIso } from "./xml";

const CURRENT_FILINGS_URL = (formType: string) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(formType)}` +
  `&company=&dateb=&owner=include&count=100&output=atom`;

/**
 * SEC EDGAR "current events" Atom feed — the near-real-time stream of filings.
 * Entry titles look like "8-K - AUTOZONE INC (0000866787) (Filer)"; the summary
 * carries Filed date, accession number, and the 8-K item list ("Item 2.02: …").
 * Note: the feed only moves during EDGAR acceptance hours (weekdays ~6am–10pm ET);
 * an empty pull off-hours is normal. SEC fair-use: identifying UA, low request rate
 * (we make one request per form type per pull).
 */
export async function fetchEdgar(cfg: FeedsConfig): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const formType of cfg.edgar.formTypes) {
    const xml = await fetchFeed(CURRENT_FILINGS_URL(formType), {
      userAgent: cfg.userAgent,
      timeoutMs: cfg.timeoutMs,
    });
    const feed = parseXml(xml)?.feed;

    for (const entry of asArray<any>(feed?.entry)) {
      const rawTitle = squeezeWhitespace(textOf(entry?.title));
      const link = asArray<any>(entry?.link).find((l) => l?.["@_href"]);
      const url = link ? String(link["@_href"]) : "";
      if (!rawTitle || !url) continue;

      // "8-K - AUTOZONE INC (0000866787) (Filer)" → form, company, CIK
      const m = rawTitle.match(/^(.+?)\s+-\s+(.+?)\s+\((\d{6,10})\)/);
      const form = m ? m[1] : formType;
      const company = m ? m[2] : rawTitle;
      const cik = m ? m[3] : "";

      const summary = stripHtml(textOf(entry?.summary));
      const accNo = summary.match(/AccNo:\s*(\S+)/)?.[1] ?? "";
      const itemCodes = [...summary.matchAll(/Item\s+(\d+\.\d+)/g)].map((x) => x[1]);

      const metrics: FeedItem["metrics"] = { formType: form };
      if (cik) metrics.cik = cik;
      if (accNo) metrics.accessionNo = accNo;
      if (itemCodes.length) metrics.items = itemCodes.join(", ");

      const title = `${form} — ${company}`;
      items.push({
        site: "sec.gov",
        url,
        title,
        text: summary ? `${title}. ${summary}` : title,
        author: company,
        timestamp: toIso(entry?.updated),
        metrics,
      });
    }
  }

  return items;
}
