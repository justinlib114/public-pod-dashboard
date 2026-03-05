// server.js — Public Pod Dashboard (availability-only, date range + manual refresh, NO patron names)
// UPDATED: status driven by booking check_in_status via /space/booking/{id}?check_in_status=1

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static("public"));

// Keep ranges reasonable
const MAX_RANGE_DAYS = 31;

// How many booking IDs to request per /space/booking/{idlist} call
const BOOKING_DETAIL_BATCH_SIZE = 80;

/* ============================
   Helpers
============================ */
function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseYMD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function daysBetweenInclusive(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
  const b = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();
  return Math.floor((b - a) / msPerDay) + 1;
}

function parseIsoSafe(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Normalize LibCal check_in_status values (commonly "in", "out", "-")
function normalizeCheckInStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s || s === "null" || s === "undefined") return "-";
  return s;
}

async function getLibCalToken() {
  const { CLIENT_ID_PHYSICAL, CLIENT_SECRET_PHYSICAL } = process.env;

  if (!CLIENT_ID_PHYSICAL || !CLIENT_SECRET_PHYSICAL) {
    throw new Error("Missing CLIENT_ID_PHYSICAL / CLIENT_SECRET_PHYSICAL in env");
  }

  const tokenUrl = "https://greenburghlibrary.libcal.com/1.1/oauth/token";
  const body = new URLSearchParams({
    client_id: CLIENT_ID_PHYSICAL,
    client_secret: CLIENT_SECRET_PHYSICAL,
    grant_type: "client_credentials",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Token error: ${resp.status} ${resp.statusText} - ${t}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Fetch check-in status for bookings by ID using:
 * GET /space/booking/{idlist}?check_in_status=1
 *
 * IMPORTANT: This endpoint may include patron fields; we DO NOT pass them to the client.
 * We only extract { id, check_in_status }.
 */
async function fetchBookingCheckStatuses(ids, headers) {
  const map = new Map(); // id -> normalized check_in_status

  const unique = Array.from(new Set(ids.filter((x) => x != null))).map((x) => String(x));
  if (!unique.length) return map;

  const batches = chunkArray(unique, BOOKING_DETAIL_BATCH_SIZE);

  for (const batch of batches) {
    const idList = batch.join(",");
    const params = new URLSearchParams({
      check_in_status: "1",
      form_answers: "0",
      internal_notes: "false",
    });

    const url = `https://greenburghlibrary.libcal.com/1.1/space/booking/${encodeURIComponent(
      idList
    )}?${params.toString()}`;

    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Booking detail error: ${resp.status} ${resp.statusText} - ${t}`);
    }

    const data = await resp.json();
    const list = Array.isArray(data) ? data : data ? [data] : [];

    for (const b of list) {
      if (!b) continue;
      const id = b.id != null ? String(b.id) : null;
      if (!id) continue;
      map.set(id, normalizeCheckInStatus(b.check_in_status));
    }
  }

  return map;
}

/* ============================
   Pages
============================ */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/ping", (req, res) => res.send("OK"));

/* ============================
   API: pods status for date range (PUBLIC SAFE)
   - ACTIVE booking: now >= start AND now < end
   - Status driven by check_in_status on ACTIVE booking:
       - "in"  => Reserved
       - otherwise ( "-", "out", missing ) => Available
   - If ACTIVE booking exists but not checked in => activeState = "not_checked_in"
   - NEVER returns patron names
============================ */
app.get("/api/pods-status", async (req, res) => {
  try {
    const lid = process.env.PODS_LOCATION_ID;
    const cid = process.env.PODS_CATEGORY_ID;

    if (!lid || !cid) {
      return res.status(500).json({
        error: "Missing PODS_LOCATION_ID or PODS_CATEGORY_ID in env",
      });
    }

    const today = new Date();
    const defaultStart = toYMD(today);
    const defaultEnd = toYMD(today);

    const startRaw = req.query.start || defaultStart;
    const endRaw = req.query.end || defaultEnd;

    const startDate = parseYMD(startRaw);
    const endDate = parseYMD(endRaw);

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Invalid start/end. Use YYYY-MM-DD." });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: "End date must be on/after start date." });
    }

    const rangeDays = daysBetweenInclusive(startDate, endDate);
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error: `Date range too large. Max is ${MAX_RANGE_DAYS} days.`,
      });
    }

    const token = await getLibCalToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1) Fetch pods (space items) in location+category
    const items = [];
    let pageIndex = 0;

    while (true) {
      const itemsParams = new URLSearchParams({
        category_id: String(cid),
        visibility: "admin_only",
        page_size: "100",
        page_index: String(pageIndex),
      });

      const itemsUrl = `https://greenburghlibrary.libcal.com/1.1/space/items/${lid}?${itemsParams.toString()}`;
      const itemsResp = await fetch(itemsUrl, { headers });

      if (!itemsResp.ok) {
        const t = await itemsResp.text();
        throw new Error(`Items error: ${itemsResp.status} ${itemsResp.statusText} - ${t}`);
      }

      const chunk = await itemsResp.json();
      if (Array.isArray(chunk)) items.push(...chunk);

      if (!Array.isArray(chunk) || chunk.length < 100) break;
      pageIndex++;
      if (pageIndex > 20) break; // safety
    }

    // 2) Fetch bookings for the whole range in one call:
    const bookings = [];
    let page = 1;

    while (true) {
      const bookParams = new URLSearchParams({
        lid: String(lid),
        cid: String(cid),
        date: toYMD(startDate),
        days: String(rangeDays - 1),
        limit: "500",
        page: String(page),
        include_cancel: "0",
        include_denied: "0",
        include_tentative: "0",
        include_remote: "0",
        check_in_status: "0", // we fetch actual check status via /space/booking/{id}
      });

      const bookingsUrl = `https://greenburghlibrary.libcal.com/1.1/space/bookings?${bookParams.toString()}`;
      const bookingsResp = await fetch(bookingsUrl, { headers });

      if (!bookingsResp.ok) {
        const t = await bookingsResp.text();
        throw new Error(`Bookings error: ${bookingsResp.status} ${bookingsResp.statusText} - ${t}`);
      }

      const chunk = await bookingsResp.json();
      if (Array.isArray(chunk)) bookings.push(...chunk);

      if (!Array.isArray(chunk) || chunk.length < 500) break;
      page++;
      if (page > 20) break; // safety
    }

    const now = new Date();

    // Collect booking IDs so we can look up check-in status
    const bookingIds = [];
    for (const b of bookings) {
      if (!b) continue;
      if (String(b.status || "").toLowerCase() !== "confirmed") continue;
      if (b.id != null) bookingIds.push(String(b.id));
    }

    // 3) Fetch check-in statuses for booking IDs (batched)
    const checkStatusById = await fetchBookingCheckStatuses(bookingIds, headers);

    // 4) Group bookings by pod eid with id + check status (sanitized)
    const byEid = new Map();
    for (const b of bookings) {
      if (!b) continue;
      if (String(b.status || "").toLowerCase() !== "confirmed") continue;

      const eid = b.eid != null ? Number(b.eid) : null;
      if (eid == null) continue;

      const start = parseIsoSafe(b.fromDate);
      const end = parseIsoSafe(b.toDate);
      if (!start || !end) continue;

      const id = b.id != null ? String(b.id) : null;
      const check = id ? normalizeCheckInStatus(checkStatusById.get(id)) : "-";

      if (!byEid.has(eid)) byEid.set(eid, []);
      byEid.get(eid).push({
        id,
        start,
        end,
        fromDate: b.fromDate,
        toDate: b.toDate,
        check_in_status: check,
      });
    }

    for (const [eid, list] of byEid.entries()) {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
      byEid.set(eid, list);
    }

    const results = items
      .map((it) => {
        const eid = it.id != null ? Number(it.id) : null;
        const name = it.name || "(Unnamed pod)";
        const list = eid != null ? byEid.get(eid) || [] : [];

        // ACTIVE bookings: now >= start && now < end
        const activeCandidates = list.filter(
          (bk) => now.getTime() >= bk.start.getTime() && now.getTime() < bk.end.getTime()
        );

        // If overlapping: reserved if ANY active booking is checked in
        const activeIn = activeCandidates.find((bk) => bk.check_in_status === "in") || null;

        // If there is any active booking, show it in "Current" (even if not checked in)
        const activeAny = activeCandidates.length ? activeCandidates[0] : null;

        // NEXT booking: first booking whose start > now
        let next = null;
        for (const bk of list) {
          if (bk.start.getTime() > now.getTime()) {
            next = bk;
            break;
          }
        }

        // Status driven by check-in:
        const status = activeIn ? "Reserved" : "Available";

        // Extra UI state:
        let activeState = null; // null | "in" | "not_checked_in"
        if (activeIn) activeState = "in";
        else if (activeAny) activeState = "not_checked_in";

        const activeForDisplay = activeAny
          ? {
              id: activeAny.id,
              fromDate: activeAny.fromDate,
              toDate: activeAny.toDate,
              check_in_status: activeAny.check_in_status,
            }
          : null;

        return {
          eid,
          name,

          status,
          activeState,

          active: activeForDisplay,
          next: next
            ? {
                id: next.id,
                fromDate: next.fromDate,
                toDate: next.toDate,
                check_in_status: next.check_in_status,
              }
            : null,

          bookings: list.map((bk) => ({
            id: bk.id,
            fromDate: bk.fromDate,
            toDate: bk.toDate,
            check_in_status: bk.check_in_status,
          })),
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      range: { start: toYMD(startDate), end: toYMD(endDate), days: rangeDays },
      now: now.toISOString(),
      count: results.length,
      results,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Failed to build pods status",
      detail: String(e.message || e),
    });
  }
});

app.listen(port, () => {
  console.log(`Public Pod Dashboard listening on http://localhost:${port}`);
});
