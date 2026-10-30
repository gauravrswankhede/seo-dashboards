#!/usr/bin/env python3
"""SEO change monitor. Runs every 4 hours from GitHub Actions (standard library only).

For each site in monitor/sites.json:
  1. finds pages (robots.txt sitemaps -> sitemap_index.xml / sitemap.xml / wp-sitemap.xml, else homepage links)
  2. records each page's SEO fields (status, title, meta description, canonical, robots, H1/H2,
     word count, schema types, missing alt text, content fingerprint, sitemap lastmod)
  3. compares with the previous scan (<site>/snapshot.json) and appends every difference to <site>/changes.csv
  4. runs the watch checks (old email, risky claims...) and writes <site>/checks.json and <site>/status.json
"""
import csv, gzip, hashlib, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (compatible; BecomeParentsSEOMonitor/1.0; +https://github.com)"
NOW = datetime.now(timezone.utc).replace(microsecond=0)
NOWS = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
FIELDS = ["timestamp_utc", "url", "change", "field", "before", "after", "lastmod"]


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or url.endswith(".gz"):
                try: body = gzip.decompress(body)
                except OSError: pass
            return r.status, r.geturl(), body.decode(r.headers.get_content_charset() or "utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, url, ""
    except Exception as e:  # network error, timeout
        return 0, url, str(e)


class Page(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base; self.title = ""; self.meta = {}; self.canonical = ""
        self.h1, self.h2 = [], []; self.links = set(); self.text = []
        self.jsonld = []; self.img_no_alt = 0; self.imgs = 0
        self._stack = []; self._in_title = False; self._hbuf = None; self._ld = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        self._stack.append(tag)
        if tag == "title": self._in_title = True
        elif tag == "meta":
            k = (a.get("name") or a.get("property") or "").lower()
            if k: self.meta[k] = a.get("content", "").strip()
        elif tag == "link" and "canonical" in a.get("rel", "").lower(): self.canonical = a.get("href", "").strip()
        elif tag in ("h1", "h2"): self._hbuf = [tag, ""]
        elif tag == "a" and a.get("href"): self.links.add(urllib.parse.urljoin(self.base, a["href"]).split("#")[0])
        elif tag == "img":
            self.imgs += 1
            if not a.get("alt", "").strip(): self.img_no_alt += 1
        elif tag == "script" and "ld+json" in a.get("type", ""): self._ld = ""

    def handle_endtag(self, tag):
        if tag == "title": self._in_title = False
        if self._hbuf and tag == self._hbuf[0]:
            t = re.sub(r"\s+", " ", self._hbuf[1]).strip()
            (self.h1 if tag == "h1" else self.h2).append(t); self._hbuf = None
        if tag == "script" and self._ld is not None:
            self.jsonld.append(self._ld); self._ld = None
        while self._stack and self._stack.pop() != tag: pass

    def handle_data(self, d):
        if self._ld is not None: self._ld += d; return
        if self._in_title: self.title += d
        if self._hbuf: self._hbuf[1] += d
        if not any(t in self.SKIP for t in self._stack): self.text.append(d)


def schema_types(blocks):
    out = set()
    def walk(o):
        if isinstance(o, dict):
            t = o.get("@type")
            if isinstance(t, str): out.add(t)
            elif isinstance(t, list): out.update(map(str, t))
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    for b in blocks:
        try: walk(json.loads(b))
        except Exception: pass
    return sorted(out)


def same_site(u, host):
    p = urllib.parse.urlparse(u)
    return p.scheme in ("http", "https") and p.netloc.lower().removeprefix("www.") == host


def norm(u):
    p = urllib.parse.urlparse(u)
    path = p.path or "/"
    return urllib.parse.urlunparse((p.scheme, p.netloc.lower(), path, "", p.query, ""))


def sitemap_urls(base, host):
    found, seen, queue = {}, set(), []
    st, _, robots = fetch(urllib.parse.urljoin(base, "/robots.txt"))
    if st == 200:
        queue += re.findall(r"(?im)^\s*sitemap:\s*(\S+)", robots)
    queue += [urllib.parse.urljoin(base, p) for p in ("/sitemap_index.xml", "/sitemap.xml", "/wp-sitemap.xml")]
    while queue and len(seen) < 60:
        sm = queue.pop(0)
        if sm in seen: continue
        seen.add(sm)
        st, _, body = fetch(sm)
        if st != 200 or "<" not in body: continue
        try: root = ET.fromstring(body.encode("utf-8", "replace"))
        except ET.ParseError: continue
        ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
        for s in root.iter(ns + "sitemap"):
            loc = s.findtext(ns + "loc")
            if loc: queue.append(loc.strip())
        for u in root.iter(ns + "url"):
            loc = (u.findtext(ns + "loc") or "").strip()
            if loc and same_site(loc, host): found[norm(loc)] = (u.findtext(ns + "lastmod") or "").strip()
        if found and not queue: break
    return found


def analyse(url):
    st, final, html = fetch(url)
    rec = {"status": st}
    if st != 200 or not html: return rec, html, set()
    p = Page(final)
    try: p.feed(html)
    except Exception: pass
    text = re.sub(r"\s+", " ", " ".join(p.text)).strip()
    rec.update({
        "title": re.sub(r"\s+", " ", p.title).strip(),
        "meta_description": p.meta.get("description", ""),
        "canonical": p.canonical,
        "robots": p.meta.get("robots", ""),
        "h1": p.h1, "h2": p.h2[:40],
        "words": len(text.split()),
        "schema": schema_types(p.jsonld),
        "og_image": bool(p.meta.get("og:image")),
        "img_missing_alt": p.img_no_alt,
        "fingerprint": hashlib.sha1(text.lower().encode()).hexdigest()[:16],
    })
    rec["_text"] = text
    return rec, html, p.links


def short(v, n=180):
    if isinstance(v, list): v = " | ".join(v)
    v = str(v)
    return v if len(v) <= n else v[: n - 1] + "…"


def diff(url, old, new, lastmod):
    rows = []
    add = lambda change, field="", before="", after="": rows.append([NOWS, url, change, field, short(before), short(after), lastmod])
    if old.get("status") != new.get("status"):
        if new.get("status") == 200: add("Page back online", "status", old.get("status"), 200)
        else: add("Page error", "status", old.get("status"), new.get("status"))
        if new.get("status") != 200: return rows
    labels = {"title": "Title changed", "meta_description": "Meta description changed", "canonical": "Canonical changed", "robots": "Robots tag changed"}
    for f, lab in labels.items():
        if old.get(f, "") != new.get(f, ""): add(lab, f, old.get(f, ""), new.get(f, ""))
    for f, lab in (("h1", "H1 changed"), ("h2", "H2 headings changed")):
        o, n = old.get(f, []), new.get(f, [])
        if o != n:
            gone, came = [x for x in o if x not in n], [x for x in n if x not in o]
            if gone or came: add(lab, f, ("removed: " + " | ".join(gone)) if gone else "", ("added: " + " | ".join(came)) if came else "")
            else: add(lab, f, "order: " + " | ".join(o), "order: " + " | ".join(n))
    if old.get("schema", []) != new.get("schema", []): add("Schema changed", "schema", old.get("schema", []) or "none", new.get("schema", []) or "none")
    if old.get("og_image") != new.get("og_image"): add("Social image " + ("added" if new.get("og_image") else "removed"), "og_image", old.get("og_image"), new.get("og_image"))
    if old.get("img_missing_alt", 0) != new.get("img_missing_alt", 0): add("Image alt text changed", "img_missing_alt", f"{old.get('img_missing_alt',0)} missing", f"{new.get('img_missing_alt',0)} missing")
    if old.get("fingerprint") and old.get("fingerprint") != new.get("fingerprint"):
        d = new.get("words", 0) - old.get("words", 0)
        add("Content edited", "words", old.get("words", 0), f"{new.get('words', 0)} ({'+' if d >= 0 else ''}{d} words)")
    return rows


def run_site(cfg, max_pages, delay):
    sid, base = cfg["id"], cfg["base"]
    host = urllib.parse.urlparse(base).netloc.lower().removeprefix("www.")
    folder = os.path.join(ROOT, sid); os.makedirs(folder, exist_ok=True)
    snap_path = os.path.join(folder, "snapshot.json")
    old = json.load(open(snap_path)) if os.path.exists(snap_path) else {}
    first_run = not old

    urls = sitemap_urls(base, host)
    source = "sitemap" if urls else "links"
    if not urls: urls = {norm(base): ""}
    pages, htmls, queue, done = {}, {}, list(urls), set()
    errors = 0
    while queue and len(done) < max_pages:
        u = queue.pop(0)
        if u in done: continue
        done.add(u)
        rec, html, links = analyse(u)
        if rec["status"] == 0: errors += 1
        rec["lastmod"] = urls.get(u, "")
        pages[u] = rec; htmls[u] = html
        if source == "links":
            for l in links:
                l = norm(l)
                if same_site(l, host) and l not in done and not re.search(r"\.(jpg|jpeg|png|gif|webp|pdf|zip|mp4|svg)$|/wp-(content|json|admin)/|/feed/?$|\?replytocom", l, re.I):
                    queue.append(l)
        time.sleep(delay)

    # Abort safely if the site was unreachable (don't log a mass "page removed")
    ok = sum(1 for p in pages.values() if p.get("status") == 200)
    if ok == 0:
        status = {"lastRunUtc": NOWS, "ok": False, "message": "Site unreachable during this scan; no changes recorded.", "pagesScanned": len(pages), "source": source}
        json.dump(status, open(os.path.join(folder, "status.json"), "w"), indent=1)
        print(f"[{sid}] unreachable, skipped"); return

    rows = []
    if first_run:
        rows.append([NOWS, base, "Baseline captured", "", "", f"{ok} pages recorded", ""])
    else:
        for u, rec in pages.items():
            if u not in old:
                if rec.get("status") == 200: rows.append([NOWS, u, "Page added", "", "", short(rec.get("title", "")), rec.get("lastmod", "")])
            else:
                rows += diff(u, old[u], rec, rec.get("lastmod", ""))
        if len(pages) < max_pages:  # only judge removals when the scan was complete
            for u, rec in old.items():
                if u not in pages and rec.get("status") == 200:
                    st, _, _ = fetch(u)
                    if st != 200: rows.append([NOWS, u, "Page removed", "status", 200, st, ""])
                    else: pages[u] = rec  # still live, just missing from the sitemap this time

    # Watch checks
    checks = []
    for c in cfg.get("checks", []):
        rx = re.compile(c["pattern"], re.I)
        hits = [u for u, r in pages.items() if r.get("status") == 200 and rx.search(htmls.get(u, "") if c.get("in") == "html" else r.get("_text", ""))]
        checks.append({**{k: c[k] for k in ("id", "label", "task") if k in c}, "pages": len(hits), "examples": hits[:5]})
    live = [r for r in pages.values() if r.get("status") == 200]
    generic = [
        ("no_title", "Pages missing a title", lambda r: not r.get("title")),
        ("no_meta", "Pages missing a meta description", lambda r: not r.get("meta_description")),
        ("h1_count", "Pages without exactly one H1", lambda r: len(r.get("h1", [])) != 1),
        ("no_schema", "Pages without schema (JSON-LD)", lambda r: not r.get("schema")),
        ("noindex", "Pages set to noindex", lambda r: "noindex" in r.get("robots", "").lower()),
        ("thin", "Thin pages (under 300 words)", lambda r: r.get("words", 0) < 300),
        ("alt", "Pages with images missing alt text", lambda r: r.get("img_missing_alt", 0) > 0),
    ]
    for gid, label, fn in generic:
        hits = [u for u, r in pages.items() if r.get("status") == 200 and fn(r)]
        checks.append({"id": gid, "label": label, "pages": len(hits), "examples": hits[:5], "generic": True})
    broken = [u for u, r in pages.items() if r.get("status") not in (200, 0)]
    checks.append({"id": "broken", "label": "Pages returning errors (4xx/5xx)", "pages": len(broken), "examples": broken[:5], "generic": True})

    # Write outputs
    log = os.path.join(folder, "changes.csv")
    new_file = not os.path.exists(log) or os.path.getsize(log) == 0
    with open(log, "a", newline="") as f:
        w = csv.writer(f)
        if new_file: w.writerow(FIELDS)
        w.writerows(rows)
    json.dump({"lastRunUtc": NOWS, "ok": True, "pagesScanned": len(pages), "pagesLive": len(live), "source": source,
               "changesThisRun": 0 if first_run else len(rows), "networkErrors": errors, "intervalHours": 4,
               "checks": checks}, open(os.path.join(folder, "status.json"), "w"), indent=1)
    for r in pages.values(): r.pop("_text", None)
    json.dump(pages, open(snap_path, "w"), indent=0, sort_keys=True)
    print(f"[{sid}] {len(pages)} pages via {source}; {len(rows)} log rows")


def main():
    cfg = json.load(open(os.path.join(ROOT, "monitor", "sites.json")))
    only = sys.argv[1:]
    for s in cfg["sites"]:
        if only and s["id"] not in only: continue
        if os.environ.get("BASE_OVERRIDE_" + s["id"].upper()): s["base"] = os.environ["BASE_OVERRIDE_" + s["id"].upper()]
        run_site(s, cfg.get("maxPages", 250), cfg.get("delaySeconds", 1.0))


if __name__ == "__main__":
    main()
