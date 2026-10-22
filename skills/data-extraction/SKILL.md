---
name: data-extraction
description: Pull structured data out of web pages into workspace files with mochi's browser tool — extract tables as rows, walk pagination, normalize values, and write verified CSV or JSON. Use for price lists, directories, reports, search results, and any page whose data needs to become a file.
---

# Data Extraction To File

The deliverable is a file the user can open, not a chat summary of a page.
The browser tool's `extract` already parses the largest table on a page into
structured rows — build on that instead of scraping raw HTML.

## 1. Identify the data shape first
- `browser navigate` to the page, `waitfor networkidle` (or the table's selector) so the data is actually rendered.
- Run `browser extract`: note the table headers, the row count, and whether the numbers in the markdown match the structured rows.
- If the target table isn't the largest one on the page, scope `extract` with the table's (or its container's) selector.

## 2. Walk pagination deliberately
- Find the pagination pattern before extracting page one: numbered pages, a next button, or infinite scroll (`scroll` to load more, then re-extract).
- Extract page by page, tracking how many rows each page contributed; stop when a page adds zero new rows or the page control reports the last page.
- Dedupe on a natural key (id, name+price, URL) as you accumulate — paginated lists overlap and shift under you.

## 3. Normalize while it's cheap
- Trim whitespace, unify empty/missing to a single representation (empty string in CSV, null in JSON) — never guess a missing value.
- Numbers: strip currency symbols and thousands separators only when the column is truly numeric; keep the raw string in a second column if the format carries meaning.
- Dates: convert to ISO format when the source format is unambiguous; otherwise keep the source string untouched.

## 4. Write the file
- JSON for nested or typed data (array of objects keyed by the table headers); CSV for flat tables a spreadsheet will open (quote any field containing a comma, quote, or newline; double internal quotes).
- Write with the file tools to a workspace path the user can find; name it after the data (`prices-2026-10.csv`), not after the scrape (`output1.csv`).
- For downloads the site offers directly (export buttons), prefer `browser download` and parse the downloaded file — it beats re-keying rendered rows.

## 5. Verify before reporting
- Re-read the written file's head and count its rows: file rows must equal the sum of extracted rows minus duplicates removed.
- Spot-check two or three rows against a fresh `extract` of the source page.
- Report: file path, row count, columns, pages walked, and anything that was missing or ambiguous in the source.

## Pitfalls
- Virtualized tables render only the visible rows — scroll through the container and extract per viewport, or find the page's own export/download.
- Split tables: some pages render headers in a separate fixed table from the body — `extract` pairs the largest table's own header row; if headers come back empty, extract the container that holds both.
- Scraping a page that isn't settled: row counts that change between two extracts mean the data was still loading — wait on the table selector.
- Rate and access discipline from the `browser-automation` skill applies: respect robots.txt and back off on repeated failures instead of retrying in a tight loop.
