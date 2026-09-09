import { ContentItem } from '../sites/types';

/** Decode only public post fields delivered by the logged-in X UI, never account/session data. */
export function deliveredPost(value: any, includeQuote = true): ContentItem | null {
  const v = value?.tweet ?? value;
  if (!v?.rest_id || !v.legacy) return null;
  const user = v.core?.user_results?.result;
  const handle = user?.core?.screen_name || user?.legacy?.screen_name;
  const note = v.note_tweet?.note_tweet_results?.result;
  const text = note?.text ?? v.legacy.full_text;
  if (typeof text !== 'string') return null;
  const quote = includeQuote ? deliveredPost(v.quoted_status_result?.result, false) : null;
  const timestamp = Date.parse(v.legacy.created_at);
  return {
    tweetId: v.rest_id, text,
    ...(handle ? { author: '@' + handle, url: `https://x.com/${handle}/status/${v.rest_id}` } : {}),
    ...(Number.isFinite(timestamp) ? { timestamp: new Date(timestamp).toISOString() } : {}),
    linkedSourceUrls: [...new Set<string>([...(v.legacy.entities?.urls || []), ...(note?.entity_set?.urls || [])].map((u: any) => u.expanded_url).filter((u: any) => typeof u === 'string' && /^https?:\/\//.test(u)))],
    truncatedText: note?.text ? false : !!v.legacy.truncated || (!!v.note_tweet && !note?.text),
    unreadImageContent: !!(v.legacy.extended_entities?.media?.length || v.legacy.entities?.media?.length || quote?.unreadImageContent),
    ...(quote ? { quotedPost: quote } : {}),
  };
}
