# Sift — Technical Design

## Architecture

```
Amazon search page
  └─ sift.user.js (injected by Tampermonkey)
       ├─ parseProducts()         — DOM → product array
       ├─ applyFilters()          — show/hide/gray original results
       ├─ fetchMoreResults()      — GM_xmlhttpRequest pages 2-N
       ├─ renderFetchedResults()  — inject cards into .s-main-slot
       └─ createPanel()           — fixed sidebar UI
```

## Key Technical Details

### DOM Parsing

Products are extracted from `[data-component-type="s-search-result"]` elements. Duplicate ASINs (same product in multiple positions) are merged into a single product with an `elements[]` array so all instances get styled consistently.

### CSS Grid Insertion

Amazon's `.s-main-slot` is a CSS Grid with explicit `gridTemplateRows` pixel values. To insert fetched results:

1. Walk `.s-main-slot`'s direct children
2. Find the first visible, non-result element after the initial batch of result cards (skipping invisible scripts)
3. Insert our header + cards before that element
4. Override `gridTemplateRows: 'auto'` so appended items flow correctly

### Multi-Page Fetch

- `GM_xmlhttpRequest` fetches subsequent pages as raw HTML
- `DOMParser` parses the HTML into a document
- `document.adoptNode()` imports real DOM elements (preserving Amazon's card structure)
- Results cached in `fetchedProducts[]` — keyword changes re-filter without re-fetching
- ASIN deduplication against both the current page and within fetched results

### Dev Mode

`window.SIFT_DEV = true` (set by the dev stub) enables:
- Debug dump button in the panel
- Verbose console logging of filter pass/fail decisions
- Parsed/unparsed product dumps

## Decisions Made

- **Hide by default** (not gray-out) — checked by default
- **Right sidebar** panel — fixed position, collapsible
- **Self-hashing version** — computed from function source at runtime
- **Manual fetch** — user clicks Fetch button; slider sets page count (1-20, default 5)
- **Fresh DOM for injected cards** — never clone/modify existing Amazon cards (avoids stale banners, wrong reviews)
