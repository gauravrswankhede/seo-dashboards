// SEO dashboard engine. Reads site.json, tasks.csv and traffic.csv from the page's folder
// (or Google Sheets "Publish to web" CSV links set in site.json).
(function () {
  const PRI = ["Critical", "High", "Medium", "Low"];
  const PCOL = { Critical: "var(--crit)", High: "var(--high)", Medium: "var(--med)", Low: "var(--low)" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    const clean = rows.filter((r) => r.some((x) => x.trim() !== ""));
    if (!clean.length) return [];
    const head = clean[0].map((h) => h.trim().toLowerCase());
    return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
  }
  async function getText(url) { const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now()); if (!r.ok) throw new Error(url + " " + r.status); return r.text(); }
  const scoreColor = (s) => (s >= 75 ? "var(--ok)" : s >= 50 ? "var(--high)" : "var(--crit)");
  const normStatus = (s) => { s = (s || "").toLowerCase(); if (s.startsWith("done") || s === "complete" || s === "completed") return "Done"; if (s.includes("progress")) return "In progress"; if (s.includes("block")) return "Blocked"; return "Not started"; };

  function gauge(score) {
    const r = 42, c = 2 * Math.PI * r, off = c * (1 - score / 100);
    return `<svg width="104" height="104" viewBox="0 0 104 104"><circle cx="52" cy="52" r="${r}" fill="none" stroke="#eef0f3" stroke-width="11"/>
      <circle cx="52" cy="52" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 52 52)"/>
      <text x="52" y="58" text-anchor="middle" font-size="26" font-weight="700" fill="#16202c">${score}</text></svg>`;
  }

  function trafficChart(rows) {
    if (!rows.length) return `<div class="empty">No traffic data yet. Each month, add one row to <b>traffic.csv</b> from Google Search Console<br>(month, clicks, impressions, avg_position, enquiries).</div>`;
    const W = 560, H = 200, P = 34, n = rows.length;
    const clicks = rows.map((r) => +r.clicks || 0), imp = rows.map((r) => +r.impressions || 0);
    const mc = Math.max(1, ...clicks), mi = Math.max(1, ...imp), bw = (W - 2 * P) / n;
    let bars = "", line = "", labels = "";
    rows.forEach((r, i) => {
      const x = P + i * bw, h = (clicks[i] / mc) * (H - 2 * P);
      bars += `<rect x="${x + bw * 0.2}" y="${H - P - h}" width="${bw * 0.6}" height="${h}" rx="3" fill="#5b3cc4"><title>${esc(r.month)}: ${clicks[i]} clicks</title></rect>`;
      const y = H - P - (imp[i] / mi) * (H - 2 * P);
      line += (i ? "L" : "M") + (x + bw / 2) + " " + y;
      labels += `<text x="${x + bw / 2}" y="${H - 12}" font-size="11" text-anchor="middle" fill="#6b7685">${esc(r.month)}</text>`;
    });
    return `<div style="max-width:680px"><svg viewBox="0 0 ${W} ${H}" width="100%">${bars}<path d="${line}" fill="none" stroke="#f79009" stroke-width="2.5"/>${labels}</svg>
      <div class="legend"><span><i style="background:#5b3cc4"></i>Clicks (bars)</span><span><i style="background:#f79009"></i>Impressions (line, own scale)</span></div></div>`;
  }

  function renderChecks(status, tasks) {
    const el = $("#checks"); if (!el) return;
    if (!status || !status.checks) { el.innerHTML = `<div class="empty">Checks appear after the first automatic scan.</div>`; return; }
    const tmap = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const row = (c) => { const ok = c.pages === 0; const t = c.task && tmap[c.task];
      return `<tr><td>${ok ? "✅" : "❌"}</td><td>${esc(c.label)}${c.examples && c.examples.length ? `<div class="notes">${c.examples.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/[^/]+/, "") || "/")}</a>`).join(" · ")}${c.pages > c.examples.length ? " …" : ""}</div>` : ""}</td>
        <td style="font-weight:600;color:${ok ? "var(--ok)" : c.generic ? "var(--high)" : "var(--crit)"}">${c.pages}</td>
        <td>${c.task ? `${esc(c.task)}${t ? ` <span class="tag st-${t.status.replace(" ", "-")}">${t.status}</span>` : ""}` : ""}</td></tr>`; };
    const mine = status.checks.filter((c) => !c.generic), gen = status.checks.filter((c) => c.generic);
    el.innerHTML = `<table><thead><tr><th></th><th>Watch item (specific to this site)</th><th>Pages</th><th>Task</th></tr></thead><tbody>${mine.map(row).join("")}</tbody></table>
      <table style="margin-top:14px"><thead><tr><th></th><th>General SEO hygiene (all scanned pages)</th><th>Pages</th><th></th></tr></thead><tbody>${gen.map(row).join("")}</tbody></table>
      <div class="foot">❌ on a watch item while its task says Done means the fix is not live yet.</div>`;
  }

  function renderLog(changes, base) {
    const el = $("#log"); if (!el) return;
    const types = [...new Set(changes.map((c) => c.change))].sort();
    $("#lType").innerHTML = `<option value="">All change types</option>` + types.map((t) => `<option>${esc(t)}</option>`).join("");
    const color = (t) => /removed|error/i.test(t) ? "Critical" : /added|baseline/i.test(t) ? "Low" : /title|meta|h1|canonical|robots/i.test(t) ? "High" : "Medium";
    function draw() {
      const days = +$("#lRange").value, ty = $("#lType").value, q = $("#lQ").value.toLowerCase();
      const rows = changes.filter((c) => (!days || Date.now() - Date.parse(c.timestamp_utc) < days * 864e5) && (!ty || c.change === ty) && (!q || (c.url + c.before + c.after).toLowerCase().includes(q)))
        .sort((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc));
      if (!changes.length) { el.innerHTML = `<div class="empty">No scans yet. After the first scan you'll see a "Baseline captured" entry, then every change the scans find.</div>`; return; }
      if (!rows.length) { el.innerHTML = `<div class="empty">No changes in this period.</div>`; return; }
      let html = "", lastDay = "";
      for (const c of rows.slice(0, 500)) {
        const d = new Date(c.timestamp_utc), day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
        if (day !== lastDay) { html += `<tr><td colspan="4" style="background:#f9fafb;font-weight:650">${day}</td></tr>`; lastDay = day; }
        const path = c.url.replace(/^https?:\/\/[^/]+/, "") || "/";
        html += `<tr><td style="white-space:nowrap;color:var(--mute)">${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
          <td><span class="tag ${color(c.change)}">${esc(c.change)}</span></td>
          <td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(path)}</a>${c.lastmod ? `<div class="notes">site says modified ${esc(c.lastmod.slice(0, 16).replace("T", " "))}</div>` : ""}</td>
          <td>${c.before ? `<div class="notes" style="text-decoration:line-through">${esc(c.before)}</div>` : ""}${c.after ? `<div>${esc(c.after)}</div>` : ""}</td></tr>`;
      }
      el.innerHTML = `<table><thead><tr><th>Found at</th><th>Change</th><th>Page</th><th>Before → after</th></tr></thead><tbody>${html}</tbody></table>
        <div class="foot">${rows.length} changes${rows.length > 500 ? " (showing latest 500)" : ""}. Times are when the scan found the change (scans run every 4 hours).</div>`;
    }
    ["#lRange", "#lType"].forEach((id) => $(id).addEventListener("change", draw)); $("#lQ").addEventListener("input", draw);
    draw();
  }

  async function render() {
    const site = JSON.parse(await getText("site.json"));
    let tasks = [], traffic = [], changes = [], status = null;
    try { status = JSON.parse(await getText("status.json")); } catch (e) {}
    try { changes = parseCSV(await getText("changes.csv")); } catch (e) {}
    try { tasks = parseCSV(await getText(site.tasksCsvUrl || "tasks.csv")); } catch (e) { console.warn(e); }
    try { traffic = parseCSV(await getText(site.trafficCsvUrl || "traffic.csv")); } catch (e) { console.warn(e); }
    tasks.forEach((t) => { t.status = normStatus(t.status); if (!PRI.includes(t.priority)) t.priority = "Medium"; });

    document.title = site.name + " · SEO dashboard";
    $("#title").textContent = site.name + " — SEO dashboard";
    $("#sub").innerHTML = `<a href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a> · audit ${esc(site.auditDate)} · page loaded ${new Date().toLocaleString()}`;
    const ago = (iso) => { const h = (Date.now() - Date.parse(iso)) / 36e5; return h < 1 ? Math.round(h * 60) + " min ago" : h < 48 ? Math.round(h) + " h ago" : Math.round(h / 24) + " days ago"; };
    $("#scan").innerHTML = status
      ? (status.ok ? `🟢 Last automatic scan <b>${new Date(status.lastRunUtc).toLocaleString()}</b> (${ago(status.lastRunUtc)}) · ${status.pagesScanned} pages · scans every ${status.intervalHours || 4} hours`
                   : `🟠 Last scan ${new Date(status.lastRunUtc).toLocaleString()} could not reach the site. ${esc(status.message || "")}`)
      : `⚪ No automatic scan yet. Once GitHub Actions is switched on, the site is scanned every 4 hours.`;
    if (site.alert) $("#alert").innerHTML = `<div class="alert">⚠ ${esc(site.alert)}</div>`;

    const health = Math.round(site.scores.reduce((a, s) => a + s.score * s.weight, 0) / site.scores.reduce((a, s) => a + s.weight, 0));
    const today = new Date().toISOString().slice(0, 10);
    const open = tasks.filter((t) => t.status !== "Done");
    const done = tasks.length - open.length;
    const crit = open.filter((t) => t.priority === "Critical").length;
    const overdue = open.filter((t) => t.due && t.due < today).length;
    const last = traffic[traffic.length - 1];

    const realChanges = changes.filter((c) => c.change !== "Baseline captured");
    const wk = realChanges.filter((c) => Date.now() - Date.parse(c.timestamp_utc) < 7 * 864e5).length;
    $("#kpis").innerHTML = [
      `<div class="card kpi gauge">${gauge(health)}<div><div class="label">SEO health</div><div class="hint">out of 100 · estimated</div></div></div>`,
      `<div class="card kpi"><div class="label">Open tasks</div><div class="val">${open.length}</div><div class="hint">${done} done of ${tasks.length}</div></div>`,
      `<div class="card kpi"><div class="label">Critical open</div><div class="val" style="color:${crit ? "var(--crit)" : "var(--ok)"}">${crit}</div><div class="hint">fix these first</div></div>`,
      `<div class="card kpi"><div class="label">Overdue</div><div class="val" style="color:${overdue ? "var(--crit)" : "var(--ok)"}">${overdue}</div><div class="hint">past due date</div></div>`,
      `<div class="card kpi"><div class="label">Website changes (7 days)</div><div class="val" style="color:${wk ? "var(--brand)" : "var(--mute)"}">${status ? wk : "—"}</div><div class="hint">detected by the 4-hourly scan</div></div>`,
      `<div class="card kpi"><div class="label">Clicks (latest month)</div><div class="val">${last ? (+last.clicks).toLocaleString() : "—"}</div><div class="hint">${last ? esc(last.month) + " · pos " + esc(last.avg_position || "—") : "add Search Console data"}</div></div>`,
      `<div class="card kpi"><div class="label">Enquiries (latest month)</div><div class="val">${last && last.enquiries ? (+last.enquiries).toLocaleString() : "—"}</div><div class="hint">counts only, no client names</div></div>`,
    ].join("");

    $("#scores").innerHTML = site.scores.map((s) => `<div class="bar"><div class="name">${esc(s.category)}${s.measured ? "" : '<span class="tag nm">not measured</span>'}</div>
      <div class="track"><div class="fill" style="width:${s.score}%;background:${scoreColor(s.score)}"></div></div><div class="num">${s.score}</div></div>
      <div class="why">${esc(s.why)}</div>`).join("") + `<div class="foot">${esc(site.auditNote)}</div>`;

    const byPri = PRI.map((p) => ({ p, all: tasks.filter((t) => t.priority === p).length, done: tasks.filter((t) => t.priority === p && t.status === "Done").length }));
    const owners = [...new Set(tasks.map((t) => t.owner || "Unassigned"))];
    $("#progress").innerHTML = `<div class="stack">${PRI.map((p) => { const n = open.filter((t) => t.priority === p).length; return n ? `<div title="${p}: ${n} open" style="width:${(100 * n) / Math.max(1, open.length)}%;background:${PCOL[p]}"></div>` : ""; }).join("")}</div>
      <div class="legend">${byPri.map((b) => `<span><i style="background:${PCOL[b.p]}"></i>${b.p}: ${b.all - b.done} open / ${b.all}</span>`).join("")}</div>
      <h2 style="margin-top:18px">Open tasks by owner</h2>
      ${owners.map((o) => { const n = open.filter((t) => (t.owner || "Unassigned") === o).length, a = tasks.filter((t) => (t.owner || "Unassigned") === o).length; return `<div class="bar"><div class="name">${esc(o)}</div><div class="track"><div class="fill" style="width:${(100 * n) / Math.max(1, open.length)}%;background:var(--brand)"></div></div><div class="num">${n}</div></div>`; }).join("")}`;

    $("#traffic").innerHTML = trafficChart(traffic);
    renderChecks(status, tasks); renderLog(changes, site.url);

    const fs = $("#fStatus"), fp = $("#fPri"), fo = $("#fOwner"), fq = $("#fQ");
    fo.innerHTML = `<option value="">All owners</option>` + owners.map((o) => `<option>${esc(o)}</option>`).join("");
    let sortKey = "priority", sortDir = 1;
    const rank = { priority: (t) => PRI.indexOf(t.priority), due: (t) => t.due || "9999", status: (t) => ["Blocked", "In progress", "Not started", "Done"].indexOf(t.status) };
    function draw() {
      const q = fq.value.toLowerCase();
      const rows = tasks.filter((t) => (!fs.value || (fs.value === "Open" ? t.status !== "Done" : t.status === fs.value)) && (!fp.value || t.priority === fp.value) && (!fo.value || (t.owner || "Unassigned") === fo.value) && (!q || (t.task + " " + t.notes + " " + t.category + " " + t.id).toLowerCase().includes(q)))
        .sort((a, b) => { const f = rank[sortKey] || ((t) => (t[sortKey] || "").toLowerCase()); const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir || (rank.priority(a) - rank.priority(b)); });
      $("#tbody").innerHTML = rows.map((t) => `<tr class="${t.status === "Done" ? "done" : t.due && t.due < today ? "overdue" : ""}">
        <td>${esc(t.id)}</td><td class="task">${esc(t.task)}${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ""}</td>
        <td><span class="tag ${t.priority}">${t.priority}</span></td><td>${esc(t.category)}</td><td>${esc(t.owner)}</td>
        <td><span class="tag st-${t.status.replace(" ", "-")}">${t.status}</span></td><td class="due">${esc(t.due)}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No tasks match.</td></tr>`;
      $("#count").textContent = `${rows.length} of ${tasks.length} tasks`;
    }
    [fs, fp, fo].forEach((el) => el.addEventListener("change", draw)); fq.addEventListener("input", draw);
    document.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : 1; sortKey = k; draw(); }));
    draw();
  }
  render().catch((e) => { document.querySelector("main").innerHTML = `<div class="alert">Could not load dashboard data: ${esc(e.message)}. If you opened this file directly from your computer, use the GitHub Pages link instead.</div>`; });
})();
