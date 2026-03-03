// public/dashboard.js
let countdownTimer = null;
let lastResults = []; // keep latest results for click-to-view

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
    return d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
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

// ✅ Used for ranges that need a date + time (and forced 12-hour)
function fmtDateTime(dt) {
  const d = new Date(dt);
  return d.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ✅ Used for the header "Updated:" timestamp (forced 12-hour)
function fmtUpdated(dt) {
  const d = new Date(dt);
  return d.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function fmtRange(fromDate, toDate) {
  if (!fromDate || !toDate) return "";
  if (isSameDay(fromDate, new Date())) {
    return `${fmtTime(fromDate)}–${fmtTime(toDate)}`;
  }
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

// Don’t change classes here (cards/table set classes); just update text.
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

      // ✅ Make it obvious it's clickable (link style + hint + chevron)
      const podCell = `
        <div class="podCell">
          <div class="podLink">
            ${escapeHtml(p.name || "")}
            <span class="chev">›</span>
          </div>
          <div class="podHint">Tap to view this pod’s day schedule</div>
        </div>
      `;

      return `
        <tr class="podRow" data-eid="${escapeHtml(p.eid)}">
          <td>${podCell}</td>
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

      // ✅ Obvious click affordance on cards too
      const podTitle = `
        <div class="podName">
          <span class="podLink">
            ${escapeHtml(p.name || "")}
            <span class="chev">›</span>
          </span>
          <div class="podHint">Tap to view this pod’s day schedule</div>
        </div>
      `;

      return `
        <section class="card podCard" data-eid="${escapeHtml(p.eid)}">
          <div class="cardTop">
            ${podTitle}
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
   Modal: show reservations for this pod + day
============================ */
function openModalForPod(eid) {
  const modal = document.getElementById("podModal");
  const titleEl = document.getElementById("modalTitle");
  const subtitleEl = document.getElementById("modalSubtitle");
  const dayEl = document.getElementById("modalDay");
  const listEl = document.getElementById("modalList");

  if (!modal || !titleEl || !subtitleEl || !dayEl || !listEl) return;

  const pod = lastResults.find((p) => String(p.eid) === String(eid));
  if (!pod) return;

  // Default day = start date input (or today)
  const startEl = document.getElementById("start");
  const defaultDay = startEl?.value || ymdToday();
  dayEl.value = defaultDay;

  titleEl.textContent = pod.name || "Pod";
  subtitleEl.textContent = "Reservations for this pod (no patron names).";

  function renderDayList(ymd) {
    const dayDate = new Date(`${ymd}T00:00:00`);
    if (isNaN(dayDate.getTime())) {
      listEl.innerHTML = `<div class="error">Invalid date.</div>`;
      return;
    }

    const bookings = Array.isArray(pod.bookings) ? pod.bookings : [];

    // Reservations for THIS pod whose start date is this day
    const forDay = bookings
      .filter((b) => isSameDay(b.fromDate, dayDate))
      .sort(
        (a, b) => new Date(a.fromDate).getTime() - new Date(b.fromDate).getTime()
      );

    if (!forDay.length) {
      listEl.innerHTML = `
        <div class="slot">
          <div class="slotTime">No reservations</div>
          <div class="slotMeta">This pod is open for the selected day.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = forDay
      .map((b) => {
        const from = new Date(b.fromDate);
        const to = new Date(b.toDate);
        return `
          <div class="slot">
            <div class="slotTime">${escapeHtml(fmtTime(from))}–${escapeHtml(
          fmtTime(to)
        )}</div>
            <div class="slotMeta">${escapeHtml(ymd)}</div>
          </div>
        `;
      })
      .join("");
  }

  renderDayList(dayEl.value);
  dayEl.onchange = () => renderDayList(dayEl.value);

  modal.classList.remove("hidden");
  document.getElementById("modalClose")?.focus();
}

function closeModal() {
  const modal = document.getElementById("podModal");
  if (modal) modal.classList.add("hidden");
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

  if (tbody)
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  if (cards)
    cards.innerHTML = `<div class="card"><div class="muted">Loading…</div></div>`;

  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  try {
    const url = `/api/pods-status?start=${encodeURIComponent(
      start
    )}&end=${encodeURIComponent(end)}`;
    const r = await fetch(url);

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }

    const data = await r.json();
    lastResults = Array.isArray(data.results) ? data.results : [];

    // ✅ Force 12-hour timestamp in header
    const updated = fmtUpdated(data.now);

    if (meta) {
      meta.textContent = `Range: ${data.range.start} → ${data.range.end} (${
        data.range.days
      } day${data.range.days === 1 ? "" : "s"}) | Updated: ${updated}`;
    }

    if (!lastResults.length) {
      if (tbody)
        tbody.innerHTML = `<tr><td colspan="4" class="muted">No pods returned.</td></tr>`;
      if (cards)
        cards.innerHTML = `<div class="card"><div class="muted">No pods returned.</div></div>`;
      return;
    }

    renderTableRows(lastResults);
    renderCards(lastResults);

    renderCountdown();
    countdownTimer = setInterval(renderCountdown, 30000);
  } catch (e) {
    if (meta) meta.textContent = "—";
    const msg = escapeHtml(e.message || String(e));
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="error">${msg}</td></tr>`;
    if (cards) cards.innerHTML = `<div class="card"><div class="error">${msg}</div></div>`;
  }
}

/* ============================
   Click handling (cards + table + modal)
============================ */
document.addEventListener("click", (ev) => {
  const closeBtn = ev.target.closest("#modalClose");
  const backdrop = ev.target.closest("[data-close='1']");
  if (closeBtn || backdrop) {
    closeModal();
    return;
  }

  const card = ev.target.closest(".podCard");
  if (card?.dataset?.eid) {
    openModalForPod(card.dataset.eid);
    return;
  }

  const row = ev.target.closest(".podRow");
  if (row?.dataset?.eid) {
    openModalForPod(row.dataset.eid);
    return;
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeModal();
});

document.getElementById("refresh")?.addEventListener("click", loadData);
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
