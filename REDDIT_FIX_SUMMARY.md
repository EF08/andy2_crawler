# Reddit Post Storage Fix - Summary

## Problem
Reddit posts were being stored incorrectly in the crawl-store.json:
- All posts from a search page were merged into a single snapshot
- Comments were stored at the page level, not nested with individual posts
- The sourceUrl pointed to the search page, not individual post URLs
- Made it impossible to associate comments with their specific posts

## Solution
Modified the crawler to create **separate snapshots for each Reddit post**:

### Changes Made

1. **Modified `src/sites/types.ts`**
   - Added `sourceUrl?: string` field to `ExtractedRecord` type
   - Allows tracking which URL each extracted record came from

2. **Modified `src/crawl/expand.ts`**
   - Added `extracted.sourceUrl = target.url` after extraction
   - Each record now knows its source URL

3. **Modified `src/crawl/engine.ts` - `crawlPostLevel()` function**
   - Changed return type from single `CrawlSnapshot` to `CrawlSnapshot[]`
   - Removed URL-to-record mapping logic (simplified)
   - Now creates one snapshot per post instead of merging all posts
   - Each snapshot contains:
     - Individual post URL as `sourceUrl`
     - Post's own title
     - Post content (single post in `posts` array)
     - Comments nested within that specific post

4. **Modified `src/crawl/engine.ts` - `runOnePass()` function**
   - Updated to handle array of snapshots from `crawlPostLevel()`
   - Stores each snapshot separately
   - Improved logging to show number of individual posts stored

## New Data Structure

**Before (incorrect):**
```json
{
  "reddit.com": {
    "https://www.reddit.com/r/wallstreetbets/search/?...": {
      "sourceUrl": "https://www.reddit.com/r/wallstreetbets/search/?...",
      "content": {
        "posts": [
          { "text": "Post 1 content...", "author": "user1" },
          { "text": "Post 2 content...", "author": "user2" },
          { "text": "Post 3 content...", "author": "user3" }
        ],
        "comments": [
          // All comments from all posts mixed together
        ]
      }
    }
  }
}
```

**After (correct):**
```json
{
  "reddit.com": {
    "https://www.reddit.com/r/wallstreetbets/comments/abc/post1/": {
      "sourceUrl": "https://www.reddit.com/r/wallstreetbets/comments/abc/post1/",
      "content": {
        "title": "Post 1 Title",
        "posts": [
          { "text": "Post 1 content...", "author": "user1" }
        ],
        "comments": [
          { "text": "Comment on post 1...", "author": "commenter1" },
          { "text": "Another comment on post 1...", "author": "commenter2" }
        ]
      }
    },
    "https://www.reddit.com/r/wallstreetbets/comments/def/post2/": {
      "sourceUrl": "https://www.reddit.com/r/wallstreetbets/comments/def/post2/",
      "content": {
        "title": "Post 2 Title",
        "posts": [
          { "text": "Post 2 content...", "author": "user2" }
        ],
        "comments": [
          { "text": "Comment on post 2...", "author": "commenter3" }
        ]
      }
    }
  }
}
```

## Testing

Run the verification script to check the structure:
```bash
node verify-fix.js
```

To generate new data with the correct structure:
```bash
# Backup old data first (optional)
cp data/crawl-store.json data/crawl-store.json.backup

# Run the crawler to populate with new structure
npm run crawl:dry  # Dry run to test
npm run crawl      # Actually crawl and store
```

## Benefits

✅ Each Reddit post is now a separate entry with its own URL  
✅ Comments are properly nested under their parent post  
✅ Post titles are preserved for each individual post  
✅ Easy to query specific posts by URL  
✅ Proper data normalization - no more merged/conflated data  
✅ Deduplication works correctly (tracks individual post URLs)  

## Notes

- This fix only affects post-level crawls (Reddit, Bloomberg)
- Feed-level crawls (Twitter/X) continue to work as before
- Old data in crawl-store.json will remain until next crawl
- The store's deduplication system will prevent re-crawling already visited posts
