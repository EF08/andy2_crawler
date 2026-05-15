# Copy Content Feature

The `npm run copy` command extracts clean, readable text from your crawl-store.json and copies it to your clipboard.

## What It Does

Extracts titles and text content from all crawled posts and comments, with:

✅ **Clean titles** - No weird spacing or excessive newlines  
✅ **Normalized whitespace** - Single spaces between words  
✅ **No special characters** - Tabs and carriage returns removed  
✅ **Readable format** - Each site/post clearly separated  

## Usage

```bash
npm run copy
```

This will copy up to 200,000 characters (configurable in `crawler.config.json` under `clipboard.maxChars`) to your clipboard.

## Output Format

```
--- x.com | Home / X ---
Post text here...
Another post...

--- reddit.com | Post Title Here ---
Post content...
Comment 1...
Comment 2...

--- bloomberg.com | Article Title ---
Article content...
```

## Before vs After

### Before (Raw JSON):
```
"title": "\n       Abaxx Technologies: Real Time Collateral of Real World Assets \n    "
```

### After (Cleaned):
```
--- reddit.com | Abaxx Technologies: Real Time Collateral of Real World Assets ---
```

## Configuration

Edit `crawler.config.json` to adjust the character limit:

```json
{
  "clipboard": {
    "maxChars": 200000
  }
}
```

## Implementation

The cleaning logic is in `src/store/extractContent.ts`:
- Replaces newlines/tabs with spaces
- Collapses multiple spaces into single spaces
- Trims leading/trailing whitespace
- Handles missing titles gracefully
