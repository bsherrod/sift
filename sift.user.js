// ==UserScript==
// @name         Sift — Amazon Search Filter
// @namespace    https://github.com/bsherrod/sift
// @version      0.1
// @description  Add negative keyword filters and enhanced filtering to Amazon search results
// @match        https://www.amazon.com/s?*
// @match        https://www.amazon.com/s/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      www.amazon.com
// ==/UserScript==

(function sift_main() {
  'use strict';

  // --- Version ---
  // Self-hashing: computes checksum from the function's own source
  const SIFT_VERSION = (() => {
    const src = sift_main.toString();
    let h = 0;
    for (let i = 0; i < src.length; i++) { h = ((h << 5) - h + src.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36).slice(-6);
  })();

  const SIFT_DEV = window.SIFT_DEV || (typeof GM_info !== 'undefined' && /dev/i.test(GM_info.script.name));

  // --- Product Parser ---

  function parseProducts() {
    // Primary: s-search-result cards (the main results)
    // Secondary: any data-asin element that isn't nested inside another data-asin
    const primary = document.querySelectorAll('[data-component-type="s-search-result"]');
    const secondary = document.querySelectorAll('[data-asin]:not([data-asin=""])');
    const items = [...primary];
    const primaryAsins = new Set([...primary].map(el => el.getAttribute('data-asin')));

    // Add non-primary data-asin cards (sponsored, trending, etc.) that aren't nested
    secondary.forEach(el => {
      const asin = el.getAttribute('data-asin');
      if (!asin || primaryAsins.has(asin)) return;
      if (el.parentElement.closest('[data-asin]:not([data-asin=""])')) return;
      items.push(el);
    });

    const products = [];
    const seen = new Map(); // asin -> product index (to collect duplicate elements)

    items.forEach(el => {
      const asin = el.getAttribute('data-asin');
      if (!asin) return;
      if (seen.has(asin)) {
        // Duplicate ASIN — add element to existing product's elements array
        products[seen.get(asin)].elements.push(el);
        return;
      }

      const titleEl = el.querySelector('h2 a span') || el.querySelector('h2 span') ||
                      el.querySelector('.a-link-normal .a-text-normal') ||
                      el.querySelector('[class*="title"] span') ||
                      el.querySelector('a span[class*="text"]');
      let title = titleEl ? titleEl.textContent.trim() : '';

      // Fallback: sponsored ads often only have title in image alt
      if (!title || title.length < 5) {
        const imgEl = el.querySelector('img.s-image[alt]');
        if (imgEl) title = imgEl.alt.replace(/^Sponsored Ad - /, '').trim();
      }

      if (!title || title.length < 5) return;

      seen.set(asin, products.length);

      const priceWhole = el.querySelector('.a-price .a-price-whole');
      const priceFraction = el.querySelector('.a-price .a-price-fraction');
      let price = null;
      if (priceWhole) {
        price = parseFloat(priceWhole.textContent.replace(/[^0-9]/g, '') + '.' + (priceFraction ? priceFraction.textContent : '00'));
      }

      const ratingEl = el.querySelector('.a-icon-star-small .a-icon-alt, .a-icon-star .a-icon-alt');
      let rating = null;
      if (ratingEl) {
        const match = ratingEl.textContent.match(/([\d.]+)/);
        if (match) rating = parseFloat(match[1]);
      }

      const reviewEl = el.querySelector('[aria-label*="stars"] + span a span, .a-size-base.s-underline-text');
      let reviewCount = null;
      if (reviewEl) {
        reviewCount = parseInt(reviewEl.textContent.replace(/[^0-9]/g, ''), 10) || null;
      }

      const brandEl = el.querySelector('.a-size-base-plus.a-color-base, .a-row .a-size-base:first-child');
      const brand = brandEl ? brandEl.textContent.trim() : '';

      products.push({ asin, title, price, rating, reviewCount, brand, element: el, elements: [el] });
    });

    // Debug: dump all parsed products to console
    if (SIFT_DEV) {
      console.group('🔍 Sift: Parsed Products');
      products.forEach(p => console.log(`${p.asin} | $${p.price} | ${p.rating}★ | "${p.title.slice(0, 80)}..."`));
      console.groupEnd();
      const parsedAsins = new Set(products.map(p => p.asin));
      const unparsed = items.filter(el => !parsedAsins.has(el.getAttribute('data-asin')));
      if (unparsed.length) {
        console.group('🔍 Sift: Unparsed cards (' + unparsed.length + ')');
        unparsed.forEach(el => console.log(el.getAttribute('data-asin'), el));
        console.groupEnd();
      }
    }

    return products;
  }

  // --- Filter Engine ---

  function applyFilters(products, filters) {
    const { excludes, includes, minPrice, maxPrice, minRating, selectedBrands, hideFiltered } = filters;

    if (SIFT_DEV && (includes.length || excludes.length)) {
      console.group('🔍 Sift: Filter pass (' + includes.map(t=>'+'+t).concat(excludes.map(t=>'-'+t)).join(' ') + ')');
    }

    products.forEach(p => {
      const titleLower = p.title.toLowerCase();

      const matchedExclude = excludes.find(t => titleLower.includes(t));
      const passExclude = !matchedExclude;
      const passInclude = includes.length === 0 || includes.every(t => titleLower.includes(t));
      const passPrice = (p.price === null) || (p.price >= minPrice && p.price <= maxPrice);
      const passRating = (p.rating === null) || (p.rating >= minRating);
      const passBrand = true;

      const visible = passExclude && passInclude && passPrice && passRating && passBrand;

      // Debug: log failures
      if (SIFT_DEV && !visible && (includes.length || excludes.length)) {
        console.log(`  ✗ ${p.asin} | inc:${passInclude} exc:${passExclude} | "${p.title.slice(0,60)}"`);
      } else if (SIFT_DEV && visible && includes.length) {
        console.log(`  ✓ ${p.asin} | "${p.title.slice(0,60)}"`);
      }

      // Apply visibility to ALL elements for this ASIN
      p.elements.forEach(elem => {
        if (visible) {
          elem.style.cssText = elem.style.cssText.replace(/opacity:[^;]+;?/g, '').replace(/display:[^;]+;?/g, '');
          elem.dataset.siftVisible = '1';
        } else if (hideFiltered) {
          elem.style.setProperty('display', 'none', 'important');
          elem.dataset.siftVisible = '0';
        } else {
          elem.style.setProperty('opacity', '0.3', 'important');
          elem.style.display = '';
          elem.dataset.siftVisible = '0';
        }
      });

      // Highlight keywords in title
      const titleEl = p.element.querySelector('h2 a span') || p.element.querySelector('h2 span');
      if (titleEl) {
        // Reset to original title
        if (!p._origTitle) p._origTitle = titleEl.innerHTML;
        let html = p._origTitle;

        if (visible && includes.length > 0) {
          // Highlight positive matches in green
          includes.forEach(term => {
            const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            html = html.replace(re, '<mark style="background:#a5d6a7;padding:0 2px;border-radius:2px">$1</mark>');
          });
        } else if (!visible && matchedExclude) {
          // Highlight negative match in red
          const re = new RegExp(`(${matchedExclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          html = html.replace(re, '<mark style="background:#ef9a9a;padding:0 2px;border-radius:2px">$1</mark>');
        }

        titleEl.innerHTML = html;
      }

      // Debug outline on all elements
      p.elements.forEach(elem => {
        if (!elem.dataset.siftTitle) {
          elem.dataset.siftTitle = p.title;
          elem.title = `[Sift] "${p.title}" | $${p.price} | ${p.rating}★ | ${p.brand}`;
        }
        elem.style.outline = visible ? '2px solid #4CAF50' : (hideFiltered ? '' : '2px solid #f44336');
      });
    });

    if (SIFT_DEV && (includes.length || excludes.length)) { console.groupEnd(); }

    const visibleCount = products.filter(p => p.element.dataset.siftVisible === '1').length;
    const injectedCount = document.querySelectorAll('#sift-extra-results .sift-injected-card').length;
    const countEl = document.getElementById('sift-count');
    if (countEl) {
      const total = visibleCount + injectedCount;
      countEl.textContent = injectedCount > 0
        ? `Showing ${total} (${visibleCount} on page + ${injectedCount} fetched)`
        : `Showing ${visibleCount} of ${products.length}`;
    }

    // Handle unparsed product cards: any data-asin element not in our set
    const hasActiveFilter = excludes.length > 0 || includes.length > 0 || minRating > 0;

    if (hasActiveFilter) {
      const parsedElements = new Set(products.flatMap(p => p.elements));
      const allCards = document.querySelectorAll('[data-asin]:not([data-asin=""])');
      allCards.forEach(el => {
        if (parsedElements.has(el)) return; // already handled
        if (el.dataset.siftInjected) return; // fetched card — don't hide
        // Unparsed card — can't confirm it matches, so filter it
        if (hideFiltered) {
          el.style.display = 'none';
          el.style.opacity = '';
        } else {
          el.style.display = '';
          el.style.opacity = '0.2';
        }
        el.style.outline = '2px dashed #ff9800'; // orange dashed = unparsed
      });
    } else {
      // No active filter — restore all unparsed cards
      const parsedAsins = new Set(products.map(p => p.asin));
      const allCards = document.querySelectorAll('[data-asin]:not([data-asin=""])');
      allCards.forEach(el => {
        if (parsedAsins.has(el.getAttribute('data-asin'))) return;
        el.style.display = '';
        el.style.opacity = '';
        el.style.outline = '';
      });
    }
  }

  function parseFilterText(text) {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const excludes = tokens.filter(t => t.startsWith('-')).map(t => t.slice(1)).filter(Boolean);
    const includes = tokens.filter(t => t.startsWith('+')).map(t => t.slice(1)).filter(Boolean);
    // bare terms also treated as includes
    const bare = tokens.filter(t => !t.startsWith('-') && !t.startsWith('+'));
    return { excludes, includes: [...includes, ...bare] };
  }

  // --- Auto-Fetch More Pages ---

  const TARGET_VISIBLE = 16;  // stop fetching when this many results pass filter
  const MAX_PAGES = 10;       // hard limit on pages to fetch

  function getNextPageUrl() {
    const nextLink = document.querySelector('.s-pagination-next:not(.s-pagination-disabled)');
    if (!nextLink) return null;
    const href = nextLink.getAttribute('href');
    if (!href) return null;
    return href.startsWith('http') ? href : 'https://www.amazon.com' + href;
  }

  function fetchPage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (resp) => {
          if (resp.status === 200) resolve(resp.responseText);
          else reject(new Error(`HTTP ${resp.status}`));
        },
        onerror: reject
      });
    });
  }

  function parseProductsFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = doc.querySelectorAll('[data-component-type="s-search-result"]');
    const results = [];
    cards.forEach(el => {
      const asin = el.getAttribute('data-asin');
      if (!asin) return;
      const titleEl = el.querySelector('h2 a span') || el.querySelector('h2 span');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title || title.length < 5) return;
      const priceWhole = el.querySelector('.a-price .a-price-whole');
      const priceFraction = el.querySelector('.a-price .a-price-fraction');
      let price = null;
      if (priceWhole) {
        price = parseFloat(priceWhole.textContent.replace(/[^0-9]/g, '') + '.' + (priceFraction ? priceFraction.textContent : '00'));
      }
      const imgEl = el.querySelector('img.s-image');
      const imgSrc = imgEl ? imgEl.getAttribute('src') : '';
      const linkEl = el.querySelector('h2 a');
      const href = linkEl ? linkEl.getAttribute('href') : '';
      const productUrl = href.startsWith('http') ? href : 'https://www.amazon.com' + href;
      results.push({ asin, title, price, imgSrc, productUrl, _element: document.adoptNode(el) });
    });
    // Extract next page URL from fetched HTML
    const nextLink = doc.querySelector('.s-pagination-next:not(.s-pagination-disabled)');
    let nextUrl = null;
    if (nextLink) {
      const h = nextLink.getAttribute('href');
      nextUrl = h && (h.startsWith('http') ? h : 'https://www.amazon.com' + h);
    }
    return { results, nextUrl };
  }

  function productPassesFilter(product, filters) {
    const titleLower = product.title.toLowerCase();
    const passExclude = !filters.excludes.find(t => titleLower.includes(t));
    const passInclude = filters.includes.length === 0 || filters.includes.every(t => titleLower.includes(t));
    const passPrice = (product.price === null) || (product.price >= filters.minPrice && product.price <= filters.maxPrice);
    return passExclude && passInclude && passPrice;
  }

  function renderFetchedResults(filters) {
    // Remove old injected section
    document.querySelectorAll('[data-sift-injected]').forEach(el => {
      if (el.id === 'sift-extra-results') return;
      el.remove();
    });
    const panelContainer = document.getElementById('sift-extra-results');
    if (panelContainer) panelContainer.innerHTML = '';

    if (!fetchedProducts.length) return;

    // Filter cached products against current keywords
    const passing = fetchedProducts.filter(p => productPassesFilter(p, filters));
    if (!passing.length) return;

    const mainSlot = document.querySelector('.s-main-slot');
    if (!mainSlot) return;

    // Create section header spanning full grid width
    const siftHeader = document.createElement('div');
    siftHeader.id = 'sift-results-header';
    siftHeader.dataset.siftInjected = '1';
    siftHeader.style.cssText = 'grid-column: 1 / -1; padding: 16px 0 8px; border-top: 2px solid #e77600; margin-top: 8px;';
    siftHeader.innerHTML = `<span style="font-size:16px;font-weight:bold;color:#e77600">🔍 Sift: Additional matches</span> <span style="font-size:12px;color:#888">(${passing.length} from ${fetchedProducts.length} fetched)</span>`;

    // Find insertion point: first visible non-result child after the first batch of results
    const children = [...mainSlot.children];
    let seenResult = false;
    let insertBeforeEl = null;
    for (const child of children) {
      if (child.dataset.asin && child.offsetHeight > 0) {
        seenResult = true;
        continue;
      }
      if (!seenResult) continue;
      if (child.offsetHeight === 0) continue;
      insertBeforeEl = child;
      break;
    }
    mainSlot.insertBefore(siftHeader, insertBeforeEl);

    // Insert passing cards after header (dedupe by ASIN against page + already-shown)
    const pageAsins = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')].map(el => el.dataset.asin);
    const seenAsins = new Set(pageAsins);
    let insertAfter = siftHeader;
    passing.forEach(p => {
      if (seenAsins.has(p.asin)) return;
      seenAsins.add(p.asin);
      // Clone the stored element (so we can re-render on filter change without losing it)
      const card = p._element.cloneNode(true);
      card.dataset.siftInjected = '1';
      card.dataset.siftVisible = '1';
      card.style.outline = '2px solid #4CAF50';
      card.style.display = '';
      card.style.opacity = '';

      // Highlight title
      const titleEl = card.querySelector('h2 span') || card.querySelector('h2');
      if (titleEl && filters.includes.length) {
        titleEl.innerHTML = highlightTitle(titleEl.textContent, filters.includes);
      }

      if (insertAfter.nextSibling) {
        mainSlot.insertBefore(card, insertAfter.nextSibling);
      } else {
        mainSlot.appendChild(card);
      }
      insertAfter = card;

      // Panel entry
      if (panelContainer) {
        const entry = document.createElement('div');
        entry.className = 'sift-injected-card';
        entry.style.cssText = 'padding:4px 0;border-bottom:1px solid #eee;font-size:11px;';
        entry.innerHTML = `<a href="${p.productUrl}" style="color:#0F1111;text-decoration:none">${p.title.slice(0,40)}…</a> <b>$${p.price || '?'}</b> <span style="color:#888">p${p._page}</span>`;
        panelContainer.appendChild(entry);
      }
    });

    // Override grid rows
    mainSlot.style.gridTemplateRows = 'auto';

    // Update count
    const countEl = document.getElementById('sift-count');
    if (countEl) {
      const visOnPage = document.querySelectorAll('[data-sift-visible="1"]:not([data-sift-injected])').length;
      countEl.textContent = `Showing ${visOnPage + passing.length} (${visOnPage} on page + ${passing.length} fetched)`;
    }
  }

  // Keep old name as a shim for fetchMoreResults loop
  function injectFetchedProduct(product, container, filters) {
    // During fetch, just accumulate into cache — renderFetchedResults handles display
    fetchedProducts.push(product);
  }

  function highlightTitle(title, includes) {
    let html = title.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    includes.forEach(term => {
      const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      html = html.replace(re, '<mark style="background:#a5d6a7;padding:0 2px;border-radius:2px">$1</mark>');
    });
    return html;
  }

  let fetchAbort = false; // flag to cancel ongoing fetch chain
  let fetchRunning = false; // prevent duplicate fetches
  let fetchedProducts = []; // cache of all fetched products (survives filter changes)

  async function fetchMoreResults(products, filters) {
    if (fetchRunning) return;
    fetchRunning = true;
    fetchAbort = false;
    const statusEl = document.getElementById('sift-fetch-status');
    const container = document.getElementById('sift-extra-results');
    if (!container || !statusEl) { fetchRunning = false; return; }

    // Clear previous extra results (panel + main page)
    container.innerHTML = '';
    document.querySelectorAll('[data-sift-injected]').forEach(el => {
      if (el.id === 'sift-extra-results') return;
      el.remove();
    });
    fetchedProducts = []; // reset cache for fresh fetch

    if (!filters.includes.length && !filters.excludes.length) {
      statusEl.textContent = 'Enter filter keywords first';
      fetchRunning = false; return;
    }
    const maxPages = filters.maxPages || MAX_PAGES;
    if (maxPages === 0) {
      statusEl.textContent = '';
      fetchRunning = false; return;
    }

    // Add header to container
    container.innerHTML = '<div style="padding:12px 0 8px;font-size:14px;font-weight:bold;color:#e77600;border-top:2px solid #e77600;margin-top:16px">🔍 Sift: Additional matches from later pages</div>';

    const seenAsins = new Set(products.map(p => p.asin));
    let nextUrl = getNextPageUrl();
    let pagesFetched = 0;
    let totalScanned = 0;

    while (nextUrl && pagesFetched < maxPages && !fetchAbort) {
      pagesFetched++;
      statusEl.innerHTML = `⏳ Fetching page ${pagesFetched + 1}... <span style="color:#888">(${fetchedProducts.length} cached / ${totalScanned} scanned)</span>`;

      try {
        const html = await fetchPage(nextUrl);
        const { results, nextUrl: next } = parseProductsFromHtml(html);
        nextUrl = next;

        results.forEach(p => {
          totalScanned++;
          if (seenAsins.has(p.asin)) return;
          seenAsins.add(p.asin);
          p._page = pagesFetched + 1;
          fetchedProducts.push(p);
        });

        // Update status during fetch
        statusEl.innerHTML = `⏳ Page ${pagesFetched + 1} done. <span style="color:#888">${fetchedProducts.length} products cached / ${totalScanned} scanned</span>`;

        // Delay between fetches to avoid rate-limiting
        await new Promise(r => setTimeout(r, 600));
      } catch (err) {
        console.warn('Sift fetch error:', err);
        statusEl.innerHTML += ' <span style="color:red">(fetch error)</span>';
        break;
      }
    }

    // Render all fetched products that pass the current filter
    renderFetchedResults(filters);

    if (fetchedProducts.length > 0) {
      const passing = fetchedProducts.filter(p => productPassesFilter(p, filters));
      statusEl.innerHTML = `✅ ${passing.length} matches from ${totalScanned} products across ${pagesFetched} page${pagesFetched > 1 ? 's' : ''} (${fetchedProducts.length} cached)`;
    } else if (pagesFetched > 0) {
      statusEl.innerHTML = `No matches found (scanned ${totalScanned} products across ${pagesFetched} pages)`;
      container.innerHTML = ''; // remove empty header
    } else if (!nextUrl) {
      statusEl.textContent = 'No more pages available';
    } else {
      statusEl.textContent = '';
      container.innerHTML = '';
    }
    fetchRunning = false;
  }

  // --- UI ---

  function createPanel(products) {
    const prices = products.map(p => p.price).filter(p => p !== null);
    const minPriceVal = prices.length ? Math.floor(Math.min(...prices)) : 0;
    const maxPriceVal = prices.length ? Math.ceil(Math.max(...prices)) : 1000;

    const brands = [];

    const panel = document.createElement('div');
    panel.id = 'sift-panel';
    panel.innerHTML = `
      <style>
        #sift-panel {
          position: fixed;
          top: 60px;
          right: 0;
          width: 280px;
          max-height: calc(100vh - 80px);
          overflow-y: auto;
          background: #fff;
          border-left: 2px solid #e77600;
          box-shadow: -2px 0 8px rgba(0,0,0,0.15);
          padding: 16px;
          font-family: Arial, sans-serif;
          font-size: 13px;
          z-index: 10000;
          box-sizing: border-box;
        }
        #sift-panel h3 {
          margin: 0 0 12px 0;
          font-size: 16px;
          color: #e77600;
        }
        #sift-panel label {
          display: block;
          margin: 10px 0 4px;
          font-weight: bold;
          color: #333;
        }
        #sift-panel input[type="text"] {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #ccc;
          border-radius: 4px;
          box-sizing: border-box;
        }
        #sift-panel input[type="range"] {
          width: 100%;
        }
        #sift-panel .sift-row {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: #555;
        }

        #sift-count {
          margin-top: 12px;
          font-weight: bold;
          color: #111;
        }
        #sift-toggle {
          position: fixed;
          top: 65px;
          right: 285px;
          z-index: 10001;
          background: #e77600;
          color: #fff;
          border: none;
          border-radius: 4px 0 0 4px;
          padding: 8px 10px;
          cursor: pointer;
          font-size: 12px;
          font-weight: bold;
        }
        #sift-toggle:hover { background: #c45500; }
        #sift-panel.sift-hidden { display: none; }
        #sift-panel.sift-hidden + #sift-toggle { right: 0; }
      </style>
      <h3>🔍 Sift <span style="font-size:10px;color:#888;font-weight:normal">v${SIFT_VERSION}</span></h3>
      <label>Filter keywords</label>
      <input type="text" id="sift-keywords" placeholder="-headlight -car +rechargeable">
      <div style="margin-top:4px;color:#888;font-size:11px">-exclude  +require  word=include</div>

      <label>Price: <span id="sift-price-label">$${minPriceVal} – $${maxPriceVal}</span></label>
      <div class="sift-row"><span>$${minPriceVal}</span><span>$${maxPriceVal}</span></div>
      <input type="range" id="sift-price-min" min="${minPriceVal}" max="${maxPriceVal}" value="${minPriceVal}">
      <input type="range" id="sift-price-max" min="${minPriceVal}" max="${maxPriceVal}" value="${maxPriceVal}">

      <label>Min rating</label>
      <select id="sift-rating">
        <option value="0">Any</option>
        <option value="4">★★★★☆ 4+</option>
        <option value="4.5">★★★★★ 4.5+</option>
        <option value="3">★★★☆☆ 3+</option>
      </select>



      <div id="sift-count">Showing ${products.length} of ${products.length}</div>
      <div id="sift-fetch-status" style="margin-top:6px;font-size:11px;color:#666"></div>

      <label>Fetch more pages: <span id="sift-maxpages-label">5</span></label>
      <input type="range" id="sift-maxpages" min="1" max="20" value="5" step="1">
      <div class="sift-row"><span>1</span><span>20</span></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="sift-fetch-btn" style="flex:1;padding:6px;font-size:12px;cursor:pointer;background:#e77600;color:#fff;border:none;border-radius:4px;font-weight:bold">🔍 Fetch</button>
        <button id="sift-clear-btn" style="padding:6px 10px;font-size:12px;cursor:pointer;background:#eee;border:1px solid #ccc;border-radius:4px">✕ Clear</button>
      </div>

      <label style="margin-top:12px;font-weight:normal;display:flex;align-items:center;cursor:pointer">
        <input type="checkbox" id="sift-hide-filtered" checked style="margin-right:6px">
        Hide filtered (instead of gray out)
      </label>

      ${SIFT_DEV ? '<button id="sift-debug-dump" style="margin-top:10px;padding:4px 8px;font-size:11px;cursor:pointer;background:#eee;border:1px solid #ccc;border-radius:3px">📋 Copy debug to clipboard</button>' : ''}

      <div id="sift-extra-results" data-sift-injected="1" style="margin-top:12px;max-height:400px;overflow-y:auto;border-top:1px solid #eee"></div>
    `;

    document.body.appendChild(panel);

    // Debug dump button (dev mode only)
    const debugBtn = document.getElementById('sift-debug-dump');
    if (debugBtn) {
      debugBtn.addEventListener('click', () => {
      const mainSlot = document.querySelector('.s-main-slot');
      if (!mainSlot) { navigator.clipboard.writeText('NO .s-main-slot'); alert('Copied'); return; }
      const children = [...mainSlot.children].map((el, i) => {
        const ctype = el.dataset.componentType || '';
        const asin = el.dataset.asin || '';
        const celId = el.dataset.celWidget || el.getAttribute('cel_widget_id') || '';
        const h = el.offsetHeight;
        // Get the first visible heading or label text
        const heading = el.querySelector('h2, h3, .a-section .a-text-bold, span.a-size-medium-plus, span.a-size-base-plus');
        const label = heading ? heading.textContent.trim().slice(0, 60) : '';
        const cls = el.className?.split(' ').slice(0, 2).join(' ') || '';
        if (asin) return `[${i}] RESULT asin=${asin} h=${h}`;
        return `[${i}] <${el.tagName} ctype="${ctype}" cel="${celId}" cls="${cls}"> h=${h} label="${label}"`;
      });
      navigator.clipboard.writeText(JSON.stringify(children, null, 1));
      alert('Copied ' + children.length + ' children of .s-main-slot');
      });
    }

    // Toggle button
    const toggle = document.createElement('button');
    toggle.id = 'sift-toggle';
    toggle.textContent = '◀ Sift';
    toggle.addEventListener('click', () => {
      panel.classList.toggle('sift-hidden');
      toggle.textContent = panel.classList.contains('sift-hidden') ? '▶ Sift' : '◀ Sift';
      toggle.style.right = panel.classList.contains('sift-hidden') ? '0' : '285px';
    });
    document.body.appendChild(toggle);

    // Wire up events
    const getFilters = () => {
      const text = document.getElementById('sift-keywords').value;
      const { excludes, includes } = parseFilterText(text);
      const minPrice = parseFloat(document.getElementById('sift-price-min').value);
      const maxPrice = parseFloat(document.getElementById('sift-price-max').value);
      const minRating = parseFloat(document.getElementById('sift-rating').value);

      const selectedBrands = new Set();

      document.getElementById('sift-price-label').textContent = `$${minPrice} – $${maxPrice}`;
      const hideFiltered = document.getElementById('sift-hide-filtered').checked;
      const maxPages = parseInt(document.getElementById('sift-maxpages').value, 10);
      document.getElementById('sift-maxpages-label').textContent = maxPages === 0 ? 'off' : maxPages;
      return { excludes, includes, minPrice, maxPrice, minRating, selectedBrands, hideFiltered, maxPages };
    };

    const update = () => {
      fetchAbort = true; // cancel any in-progress fetch
      const filters = getFilters();
      applyFilters(products, filters);
      // Re-render fetched results with updated filter (no re-fetch)
      renderFetchedResults(filters);
    };

    document.getElementById('sift-keywords').addEventListener('input', update);
    document.getElementById('sift-price-min').addEventListener('input', update);
    document.getElementById('sift-price-max').addEventListener('input', update);
    document.getElementById('sift-rating').addEventListener('change', update);
    document.getElementById('sift-hide-filtered').addEventListener('change', update);
    document.getElementById('sift-maxpages').addEventListener('input', () => {
      const val = document.getElementById('sift-maxpages').value;
      document.getElementById('sift-maxpages-label').textContent = val;
    });
    document.getElementById('sift-fetch-btn').addEventListener('click', () => {
      const filters = getFilters();
      if (filters.includes.length || filters.excludes.length) {
        fetchMoreResults(products, filters);
      }
    });
    document.getElementById('sift-clear-btn').addEventListener('click', () => {
      // Clear all injected content and cache
      fetchedProducts = [];
      document.querySelectorAll('[data-sift-injected]').forEach(el => {
        if (el.id === 'sift-extra-results') return;
        el.remove();
      });
      const container = document.getElementById('sift-extra-results');
      if (container) container.innerHTML = '';
      const statusEl = document.getElementById('sift-fetch-status');
      if (statusEl) statusEl.textContent = '';
      // Restore grid-template-rows
      const mainSlot = document.querySelector('.s-main-slot');
      if (mainSlot) mainSlot.style.gridTemplateRows = '';
    });
  }

  // --- Init ---

  function init() {
    // Clean up any stale injected content from previous runs
    document.querySelectorAll('[data-sift-injected]').forEach(el => el.remove());
    document.getElementById('sift-panel')?.remove();
    document.getElementById('sift-toggle')?.remove();
    const mainSlot = document.querySelector('.s-main-slot');
    if (mainSlot) mainSlot.style.gridTemplateRows = '';

    // Wait for results to load
    const observer = new MutationObserver(() => {
      const results = document.querySelectorAll('[data-component-type="s-search-result"]');
      if (results.length > 0 && !document.getElementById('sift-panel')) {
        observer.disconnect();
        const products = parseProducts();
        if (products.length > 0) {
          createPanel(products);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also try immediately in case page is already loaded
    setTimeout(() => {
      if (!document.getElementById('sift-panel')) {
        const products = parseProducts();
        if (products.length > 0) {
          createPanel(products);
        }
      }
    }, 1500);
  }

  init();
})();
