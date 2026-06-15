# Sift — Amazon Search Results Filter

A Tampermonkey userscript that adds keyword filtering, price/rating sliders, and multi-page fetch to Amazon search results.

## Features

- **Keyword filtering** — `-exclude` terms, `+require` terms, or bare words to include
- **Hide or gray out** filtered results (toggle between modes)
- **Price range** slider (auto-populated from actual results)
- **Minimum rating** filter
- **Multi-page fetch** — pulls results from later pages without navigating away
- **Instant re-filter** — changing keywords re-scans cached fetched results without re-fetching
- **Keyword highlighting** — matched terms highlighted in green, excluded in red
- **ASIN deduplication** — across page results and fetched results

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. [Click to install](https://raw.githubusercontent.com/bsherrod/sift/master/sift.user.js)
   — or create a new userscript and paste the contents of `sift.user.js`
3. Go to any Amazon search results page — the Sift panel appears on the right

## Usage

- Type filter keywords in the text box: `-car -headlight +rechargeable`
- Adjust price and rating sliders
- Click **🔍 Fetch** to pull more results from subsequent pages
- Click **✕ Clear** to remove fetched results and restore the page
- Click **◀ Sift** to collapse/expand the panel

## Development

For local development with live-reload:

1. Clone this repo
2. Install the dev stub (`sift-dev-stub.user.js`) in Tampermonkey
3. Edit the `@require` path to point to your local clone
4. Enable "Allow access to file URLs" in Tampermonkey settings

The dev stub enables:
- Debug dump button (copies `.s-main-slot` structure to clipboard)
- Verbose console logging of filter decisions and parsed products

## How It Works

- Parses product cards from Amazon's DOM via `[data-component-type="s-search-result"]` selectors
- Filters in-memory with `Array.filter()` — no search index needed for ~100 products
- Multi-page fetch uses `GM_xmlhttpRequest` + `DOMParser` + `document.adoptNode()`
- Injected results placed after the first batch of organic results using a DOM walk algorithm
- CSS Grid `gridTemplateRows: auto` override makes appended cards flow correctly
