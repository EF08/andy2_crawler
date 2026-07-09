import { XMLParser } from "fast-xml-parser";
import { squeezeWhitespace } from "../extract/normalize";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

/** fast-xml-parser returns a single object for one child, an array for many. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text of a parsed node that may be a plain value or an attributed { "#text": ... } object. */
export function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    return t === undefined || t === null ? "" : String(t);
  }
  return String(node);
}

/** HTML fragment → readable plain text (tags stripped, common entities decoded). */
export function stripHtml(html: string): string {
  return squeezeWhitespace(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&amp;/gi, "&"),
  );
}

/** Feed date (RFC-822 pubDate or ISO) → ISO string, or undefined if unparseable. */
export function toIso(dateStr: unknown): string | undefined {
  const s = textOf(dateStr);
  if (!s) return undefined;
  const t = Date.parse(s);
  return isNaN(t) ? undefined : new Date(t).toISOString();
}

/** GET a feed URL with UA + timeout. Throws on network error or non-2xx. */
export async function fetchFeed(
  url: string,
  opts: { userAgent: string; timeoutMs: number },
): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": opts.userAgent, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}
