import { BloombergAdapter } from "./bloomberg.adapter";
import { RedditAdapter } from "./reddit.adapter";
import { XAdapter } from "./x.adapter";
import { SiteAdapter } from "./types";

const adapters: SiteAdapter[] = [new XAdapter(), new RedditAdapter(), new BloombergAdapter()];

export function resolveAdapter(rawUrl: string): SiteAdapter | undefined {
  const url = new URL(rawUrl);
  return adapters.find((adapter) => adapter.supportsUrl(url));
}
