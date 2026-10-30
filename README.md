# Become Parents Group — SEO dashboards

One dashboard per website, hosted free on GitHub Pages.

| Page | What it shows |
|---|---|
| `/` | Both sites side by side: health score, open and critical tasks |
| `/becomeparents/` | becomeparents.com |
| `/bangkoksurrogacy/` | bangkoksurrogacy.com |

## Automatic 4-hourly scan (live work log)
`.github/workflows/seo-monitor.yml` runs `monitor/crawl.py` on GitHub's servers at 00:17, 04:17, 08:17, 12:17, 16:17 and 20:17 UTC (05:47, 09:47, 13:47, 17:47, 21:47 and 01:47 India time). On each run it:
1. finds every page from the site's sitemap (or follows links if there is no sitemap)
2. records each page's title, meta description, canonical, robots tag, H1/H2 headings, word count, schema types, image alt text and a content fingerprint
3. compares with the previous scan and logs each difference in `<site>/changes.csv` (page added or removed, title/meta/heading/schema change, content edited with word-count change, page errors)
4. re-runs the watch checks in `monitor/sites.json` (old email, risky claims, placeholders…) and writes `<site>/status.json`
5. commits the results and republishes the dashboard

The first run records a **baseline**; changes appear from the second run onwards. Times show when the scan found the change, so within a 4-hour window. To scan now: **Actions → SEO monitor → Run workflow**.

To add a watch item, append a rule to that site's `checks` list in `monitor/sites.json`:
`{"id": "newcheck", "label": "What it means", "pattern": "regex", "in": "text", "task": "BP-xx"}` (`"in": "html"` searches the page source instead of the visible text).

## Updating (no coding)
Each site folder has three files you edit in GitHub (pencil icon → edit → **Commit changes**):

- **tasks.csv**: one row per task. Change `status` to `Not started`, `In progress`, `Blocked` or `Done`. Add new rows at the bottom. Keep the commas.
- **traffic.csv**: add one row per month from Google Search Console → Performance (last 28 days or calendar month):
  `2026-11,170,12400,20.9,9`  →  month, clicks, impressions, average position, enquiries (a count only).
- **site.json**: category scores (0–100). Update after each re-audit or PageSpeed test.

Each commit republishes the dashboard automatically (Actions → Publish dashboard), usually within 1–2 minutes.

## Optional: run tasks from Google Sheets instead
1. Paste tasks.csv into a Google Sheet (same column headers).
2. File → Share → **Publish to web** → that tab → **CSV** → Publish, then copy the link.
3. Paste the link into `"tasksCsvUrl"` in that site's `site.json` (do the same with `"trafficCsvUrl"` for traffic).

## Privacy
GitHub Pages sites are public, even from a private repo. Never put client names, case details, emails or phone numbers in these files. Enquiries are counts only. The pages carry `noindex` so search engines skip them, but anyone with the link can still open them.
