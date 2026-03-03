let countdownTimer = null;

function ymdToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtTime(dt) {
  try {
    const d = new Date(dt);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return dt;
  }
}

function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function fmtDateTime(dt) {
  const d = new Date(dt);
  return d.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRange(fromDate, toDate) {
  if (!fromDate || !toDate) return "";

  // If reservation is today, show time only
  if (isSameDay(fromDate, new Date())) {
    return `${fmtTime(fromDate)}–${fmtTime(toDate)}`;
  }

  // Otherwise, show date + time
  return `${fmtDateTime(fromDate)}–${fmtTime(toDate)}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ============================
   Countdown helpers
============================ */
function minutesUntil(isoEnd) {
  const end = new Date(isoEnd).getTime();
  const now = Date.now();
  return Math.ceil((end - now) / 60000);
}

// Don’t change classes here (cards/table set classes)
// Just update text.
function renderCountdown() {
  document.querySelectorAll("[data-endtime]").forEach((el) => {
    const endIso = el.getAttribute("data-endtime");
    const mins = minutesUntil(endIso);

    if (mins <= 0) el.textContent = "Ended";
    else if (mins === 1) el.textContent = "Ends in 1 min";
    else el.textContent = `Ends in ${mins} min`;
  });
}

/* ============================
   Renderers
============================ */
function statusBadgeHtml(isAvail) {
  return isAvail
    ? `<span class="badge available">Available</span>`
    : `<span class="badge reserved">Reserved</span>`;
}

function renderTableRows(results) {
  const tbody = document.getElementById("rows");
  if (!tbody) return;

  tbody.innerHTML = results
    .map((p) => {
      const isAvail = p.status === "Available";
      const badge = statusBadgeHtml(isAvail);

      let current = `<span class="muted">—</span>`;
      if (p.active) {
        const range = escapeHtml(fmtRange(p.active.fromDate, p.active.toDate));
        current = `
          ${range}<br/>
          <span data-endtime="${p.active.toDate}" class="countdown"></span>
        `;
      }

      const next = p.next
        ? escapeHtml(fmtRange(p.next.fromDate, p.next.toDate))
        : `<span class="muted">—</span>`;

      return `
        <tr>
          <td><strong>${escapeHtml(p.name || "")}</strong></td>
          <td>${badge}</td>
          <td>${current}</td>
          <td>${next}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCards(results) {
  const cards = document.getElementById("cards");
  if (!cards) return;

  cards.innerHTML = results
    .map((p) => {
      const isAvail = p.status === "Available";
      const badge = statusBadgeHtml(isAvail);

      const current = p.active
        ? `
          <div class="v">
            ${escapeHtml(fmtRange(p.active.fromDate, p.active.toDate))}
            <div data-endtime="${p.active.toDate}" class="countdown"></div>
          </div>
        `
        : `<div class="v muted">—</div>`;

      const next = p.next
        ? `<div class="v">${escapeHtml(fmtRange(p.next.fromDate, p.next.toDate))}</div>`
        : `<div class="v muted">—</div>`;

      return `
        <section class="card">
          <div class="cardTop">
            <div class="podName">${escapeHtml(p.name || "")}</div>
            ${badge}
          </div>

          <div class="cardGrid">
            <div>
              <div class="k">Current</div>
              ${current}
            </div>
            <div>
              <div class="k">Next</div>
              ${next}
            </div>
          </div>
        </section>
      `;
    })
    .join("");
}

/* ============================
   Main load
============================ */
async function loadData() {
  const meta = document.getElementById("meta");
  const tbody = document.getElementById("rows");
  const cards = document.getElementById("cards");

  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");

  const start = startEl?.value || ymdToday();
  const end = endEl?.value || start;

  // Loading states for both views
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  }
  if (cards) {
    cards.innerHTML = `<div class="card"><div class="muted">Loading…</div></div>`;
  }

  // Stop any previous countdown loop
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  try {
    const url = `/api/pods-status?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const r = await fetch(url);

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }

    const data = await r.json();
    const updated = new Date(data.now).toLocaleString();

    if (meta) {
      meta.textContent = `Range: ${data.range.start} → ${data.range.end} (${data.range.days} day${
        data.range.days === 1 ? "" : "s"
      }) | Updated: ${updated}`;
    }

    if (!data.results || !data.results.length) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="muted">No pods returned.</td></tr>`;
      if (cards) cards.innerHTML = `<div class="card"><div class="muted">No pods returned.</div></div>`;
      return;
    }

    renderTableRows(data.results);
    renderCards(data.results);

    // Initial countdown render + interval
    renderCountdown();
    countdownTimer = setInterval(renderCountdown, 30000);
  } catch (e) {
    if (meta) meta.textContent = "—";
    const msg = escapeHtml(e.message || String(e));

    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="error">${msg}</td></tr>`;
    if (cards) cards.innerHTML = `<div class="card"><div class="error">${msg}</div></div>`;
  }
}

document.getElementById("refresh")?.addEventListener("click", loadData);

// Load immediately on first open
window.addEventListener("DOMContentLoaded", loadData);

/* ============================
   Init defaults
============================ */
(() => {
  const today = ymdToday();
  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");
  if (startEl && !startEl.value) startEl.value = today;
  if (endEl && !endEl.value) endEl.value = today;
})();
