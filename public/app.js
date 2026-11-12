// StormPulse dashboard. Plain ES module, no build step: Leaflet and topojson-client come from CDNs.

const SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];
const REFRESH_MS = 60_000;
const MAX_ROWS = 200;

const AREA_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", VI: "U.S. Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
};

// us-atlas identifies states by FIPS code.
const FIPS_TO_AREA = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
  "72": "PR", "78": "VI",
};

const state = {
  zone: "land",
  severities: new Set(),
  area: "",
  q: "",
  stats: null,
  alerts: [],
  history: [],
  loadedOnce: false,
};

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sevColor = (sev) => css(`--sev-${sev}`) || "#64748b";

/** Every string from the API goes through this before touching innerHTML. */
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ── Formatting (en-US; viewer's local time zone unless they pick a U.S. zone) ─

const TIME_ZONES = {
  "": "Local time",
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
const number = new Intl.NumberFormat("en-US");
let timeZone;
let timeFmt;
let dateTimeFmt;
let dayFmt;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null; // Private mode / blocked storage: the preference just isn't remembered.
  }
}

function setTimeZone(tz) {
  timeZone = tz in TIME_ZONES && tz ? tz : undefined;
  const opts = { timeZone, timeZoneName: "short" };
  timeFmt = new Intl.DateTimeFormat("en-US", { ...opts, hour: "numeric", minute: "2-digit" });
  dateTimeFmt = new Intl.DateTimeFormat("en-US", {
    ...opts, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  dayFmt = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "short" });
}
setTimeZone(new URLSearchParams(location.search).get("tz") ?? storage("stormpulse:tz") ?? "");

function relative(iso) {
  if (!iso) return "—";
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return diffSec < 0 ? "just now" : "in a moment";
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

function shortDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameDay = dayFmt.format(d) === dayFmt.format(new Date());
  return sameDay ? timeFmt.format(d) : dateTimeFmt.format(d);
}

const areaName = (code) => AREA_NAMES[code] ?? code;

/** NWS text products are hard-wrapped at ~70 columns; keep paragraph breaks, reflow the rest. */
const unwrap = (text) => text.replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/ {2,}/g, " ");

// ── API ────────────────────────────────────────────────────────────────────

async function api(path, init) {
  const res = await fetch(path, { headers: { Accept: "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

function alertsQuery() {
  const p = new URLSearchParams({ zone: state.zone, limit: "1000" });
  if (state.severities.size) p.set("severity", [...state.severities].join(","));
  if (state.area) p.set("area", state.area);
  if (state.q) p.set("q", state.q);
  return `/api/alerts?${p}`;
}

let alertsRequest = 0;
async function loadAlerts() {
  const id = ++alertsRequest;
  const data = await api(alertsQuery());
  if (id !== alertsRequest) return; // A newer filter change already superseded this response.
  state.alerts = data.alerts;
  renderAlerts();
  renderMapAlerts();
}

/** Concurrent callers (timer, tab focus, zone switch) share one in-flight refresh per zone. */
let loadAllInFlight = null;
function loadAll() {
  if (loadAllInFlight?.zone === state.zone) return loadAllInFlight.promise;
  const promise = doLoadAll().finally(() => {
    if (loadAllInFlight?.promise === promise) loadAllInFlight = null;
  });
  loadAllInFlight = { zone: state.zone, promise };
  return promise;
}

async function doLoadAll() {
  try {
    const zone = state.zone;
    const [stats, history] = await Promise.all([
      api(`/api/stats?zone=${zone}`),
      api(`/api/history?hours=24&zone=${zone}`),
      loadAlerts(),
    ]);
    if (zone !== state.zone) return;
    state.stats = stats;
    state.history = history.snapshots;
    state.loadedOnce = true;
    renderStatus();
    renderKpis();
    renderChips();
    renderAreaSelect();
    renderTopEvents();
    renderHistory();
    renderMapStates();
  } catch (err) {
    console.error(err);
    setStatus("error", "Can't reach the StormPulse server");
  }
}

// ── Status & KPIs ──────────────────────────────────────────────────────────

function setStatus(kind, text) {
  const el = $("#status");
  el.dataset.state = kind;
  el.querySelector(".status-text").textContent = text;
}

function renderStatus() {
  const { lastPoll, lastSuccessfulPoll, pollIntervalSeconds } = state.stats;
  if (!lastSuccessfulPoll) {
    setStatus("stale", lastPoll?.status === "error" ? "NWS API unreachable — retrying" : "Loading first data…");
    return;
  }
  const age = (Date.now() - new Date(lastSuccessfulPoll.startedAt).getTime()) / 1000;
  if (lastPoll?.status === "error") {
    setStatus("error", `NWS API unreachable · data from ${relative(lastSuccessfulPoll.startedAt)}`);
  } else if (age > pollIntervalSeconds * 3) {
    setStatus("stale", `Delayed · updated ${relative(lastSuccessfulPoll.startedAt)}`);
  } else {
    setStatus("live", `Live · updated ${relative(lastSuccessfulPoll.startedAt)}`);
  }
}

function renderKpis() {
  const s = state.stats;
  const severe = s.bySeverity.Extreme + s.bySeverity.Severe;
  const areas = Object.keys(s.byArea);
  const zoneLabel = { land: "land-based", marine: "marine", all: "land and marine" }[state.zone];

  $("#kpi-total").textContent = number.format(s.total);
  $("#kpi-total-note").textContent = `${zoneLabel} alerts in effect`;
  $("#kpi-severe").textContent = number.format(severe);
  $("#kpi-severe-note").textContent = s.bySeverity.Extreme
    ? `including ${s.bySeverity.Extreme} extreme`
    : "no extreme alerts right now";
  $("#kpi-areas").textContent = state.zone === "marine" ? "—" : number.format(areas.length);
  const busiest = Object.entries(s.byArea).sort((a, b) => b[1].count - a[1].count)[0];
  $("#kpi-areas-note").textContent =
    state.zone === "marine" ? "marine zones aren't tied to a state" : busiest ? `most in ${areaName(busiest[0])} (${busiest[1].count})` : "no active alerts";
  $("#kpi-new").textContent = number.format(s.issuedLastHour);
  $("#kpi-new-note").textContent = `checks NWS every ${Math.round(s.pollIntervalSeconds / 60) || 1} min`;
}

// ── Filters ────────────────────────────────────────────────────────────────

function renderChips() {
  const counts = state.stats.bySeverity;
  $("#severity-chips").innerHTML = SEVERITIES.filter((s) => counts[s] > 0 || state.severities.has(s))
    .map(
      (s) => `<button type="button" class="chip" data-severity="${s}" aria-pressed="${state.severities.has(s)}">
        <span class="dot" style="background:var(--sev-${s})"></span>${s}<span class="count">${counts[s]}</span>
      </button>`,
    )
    .join("");
}

function renderAreaSelect() {
  const entries = Object.entries(state.stats.byArea).sort((a, b) => areaName(a[0]).localeCompare(areaName(b[0])));
  const select = $("#area");
  select.disabled = state.zone === "marine";
  select.innerHTML =
    `<option value="">All states & territories</option>` +
    entries.map(([code, v]) => `<option value="${esc(code)}">${esc(areaName(code))} (${v.count})</option>`).join("");
  if (state.area && !state.stats.byArea[state.area]) {
    select.insertAdjacentHTML("beforeend", `<option value="${esc(state.area)}">${esc(areaName(state.area))} (0)</option>`);
  }
  select.value = state.area;
}

function updateClearButton() {
  $("#clear-filters").hidden = !(state.severities.size || state.area || state.q);
}

let searchTimer;
function bindFilters() {
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      updateClearButton();
      loadAlerts().catch(console.error);
    }, 250);
  });

  $("#severity-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-severity]");
    if (!chip) return;
    const sev = chip.dataset.severity;
    state.severities.has(sev) ? state.severities.delete(sev) : state.severities.add(sev);
    chip.setAttribute("aria-pressed", String(state.severities.has(sev)));
    updateClearButton();
    loadAlerts().catch(console.error);
  });

  $("#area").addEventListener("change", (e) => setArea(e.target.value));

  $("#clear-filters").addEventListener("click", () => {
    state.severities.clear();
    state.area = "";
    state.q = "";
    $("#search").value = "";
    renderChips();
    $("#area").value = "";
    updateClearButton();
    loadAlerts().catch(console.error);
  });

  document.querySelectorAll(".segmented [data-zone]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (state.zone === btn.dataset.zone) return;
      state.zone = btn.dataset.zone;
      if (state.zone === "marine") state.area = "";
      document
        .querySelectorAll(".segmented [data-zone]")
        .forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
      updateClearButton();
      loadAll();
    }),
  );
}

function setArea(code) {
  state.area = code;
  $("#area").value = code;
  updateClearButton();
  loadAlerts().catch(console.error);
}

// ── Alert list ─────────────────────────────────────────────────────────────

function areaSummary(alert) {
  const codes = alert.areas.length ? `<span class="area-codes">${esc(alert.areas.join(", "))}</span> · ` : "";
  return `${codes}${esc(alert.areaDesc)}`;
}

function renderAlerts() {
  const rows = state.alerts.slice(0, MAX_ROWS);
  const hourAgo = Date.now() - 3_600_000;

  $("#alert-rows").innerHTML =
    rows
      .map(
        (a) => `<tr tabindex="0" data-id="${esc(a.id)}">
          <td><span class="badge sev-${esc(a.severity)}">${esc(a.severity)}</span></td>
          <td><span class="alert-event">${esc(a.event)}</span>${new Date(a.sent).getTime() >= hourAgo ? '<span class="new-tag">New</span>' : ""}
            <div class="muted">${esc(a.senderName)}</div></td>
          <td><div class="alert-area" title="${esc(a.areaDesc)}">${areaSummary(a)}</div></td>
          <td class="time-cell" data-label="Issued"><time datetime="${esc(a.sent)}" title="${esc(shortDateTime(a.sent))}">${relative(a.sent)}</time></td>
          <td class="time-cell" data-label="Until"><time datetime="${esc(a.ends ?? a.expires ?? "")}">${shortDateTime(a.ends ?? a.expires)}</time></td>
        </tr>`,
      )
      .join("") +
    (state.alerts.length > MAX_ROWS
      ? `<tr class="more-row"><td colspan="5">Showing the ${MAX_ROWS} most severe of ${number.format(state.alerts.length)} alerts — narrow the filters to see more.</td></tr>`
      : "");

  const filtered = state.severities.size || state.area || state.q;
  const empty = $("#empty");
  empty.hidden = state.alerts.length > 0;
  empty.textContent = filtered ? "No alerts match these filters." : "No active alerts right now. Quiet skies.";

  const where = state.area ? ` in ${areaName(state.area)}` : "";
  $("#alerts-count").textContent = `${number.format(state.alerts.length)} active${where}, most severe first`;
}

function bindAlertList() {
  const open = (row) => row?.dataset.id && openDetail(row.dataset.id);
  $("#alert-rows").addEventListener("click", (e) => open(e.target.closest("tr[data-id]")));
  $("#alert-rows").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(e.target.closest("tr[data-id]"));
    }
  });
}

// ── Detail dialog ──────────────────────────────────────────────────────────

async function openDetail(id) {
  let alert = state.alerts.find((a) => a.id === id);
  if (!alert) {
    try {
      alert = await api(`/api/alerts/${encodeURIComponent(id)}`);
    } catch {
      toast("That alert is no longer available.");
      return;
    }
  }

  const dialog = $("#detail");
  const badge = $("#detail-severity");
  badge.className = `badge sev-${alert.severity}`;
  badge.textContent = alert.severity;
  $("#detail-title").textContent = alert.event;
  $("#detail-sender").textContent = `${alert.senderName} · ${alert.messageType === "Update" ? "Updated" : "Issued"} ${shortDateTime(alert.sent)}`;

  const facts = [
    ["Urgency", alert.urgency],
    ["Certainty", alert.certainty],
    ["In effect", shortDateTime(alert.onset ?? alert.effective)],
    ["Until", shortDateTime(alert.ends ?? alert.expires)],
  ];

  $("#detail-body").innerHTML = `
    ${alert.active === false ? `<p class="instruction">This alert ended ${esc(relative(alert.endedAt))}.</p>` : ""}
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${alert.headline ? `<h3>Headline</h3><p class="text">${esc(alert.headline)}</p>` : ""}
    <h3>Affected area${alert.areas.length ? ` · ${esc(alert.areas.map(areaName).join(", "))}` : ""}</h3>
    <p class="text">${esc(alert.areaDesc)}</p>
    ${alert.description ? `<h3>Details</h3><p class="text">${esc(unwrap(alert.description))}</p>` : ""}
    ${alert.instruction ? `<h3>What to do</h3><p class="text instruction">${esc(unwrap(alert.instruction))}</p>` : ""}
    ${alert.geometry ? `<p style="margin-top:16px"><button type="button" class="btn" data-zoom>Show on map</button></p>` : ""}
  `;
  $("#detail-body [data-zoom]")?.addEventListener("click", () => {
    dialog.close();
    zoomToAlert(alert);
  });

  history.replaceState(null, "", `#alert=${encodeURIComponent(id)}`);
  if (!dialog.open) dialog.showModal();
  $("#detail-body").scrollTop = 0;
}

function bindDetail() {
  const dialog = $("#detail");
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("close", () => history.replaceState(null, "", location.pathname + location.search));
}

function openFromHash() {
  const match = location.hash.match(/^#alert=(.+)$/);
  if (match) openDetail(decodeURIComponent(match[1]));
}

// ── Charts ─────────────────────────────────────────────────────────────────

function renderTopEvents() {
  const events = state.stats.topEvents;
  const max = Math.max(1, ...events.map((e) => e.count));
  $("#top-events").innerHTML = events.length
    ? events
        .map(
          (e) => `<li><button type="button" data-event="${esc(e.event)}">
            <span class="bar-label">${esc(e.event)}</span><span class="bar-count">${e.count}</span>
            <span class="bar-track"><span class="bar-fill" style="display:block;width:${(e.count / max) * 100}%;background:var(--sev-${esc(e.severity)})"></span></span>
          </button></li>`,
        )
        .join("")
    : `<li class="muted">No active alerts.</li>`;
}

function bindTopEvents() {
  $("#top-events").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-event]");
    if (!btn) return;
    state.q = btn.dataset.event;
    $("#search").value = state.q;
    updateClearButton();
    loadAlerts().catch(console.error);
    $("#alerts").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/** Stacked area chart drawn as plain SVG — no chart library needed for one small chart. */
function renderHistory() {
  const el = $("#history");
  const data = state.history;
  if (data.length < 2) {
    el.innerHTML = `<p class="history-empty">The trend appears after a few polls.<br />Data is collected every ${Math.round(state.stats.pollIntervalSeconds / 60) || 1} min.</p>`;
    return;
  }

  const width = el.clientWidth || 320;
  const height = 160;
  const pad = { top: 8, right: 4, bottom: 20, left: 30 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const stack = SEVERITIES.slice().reverse(); // Unknown at the bottom, Extreme on top.

  const t0 = new Date(data[0].takenAt).getTime();
  const t1 = new Date(data.at(-1).takenAt).getTime();
  const totals = data.map((d) => SEVERITIES.reduce((sum, s) => sum + d[s], 0));
  const yMax = niceMax(Math.max(...totals, 1));

  const x = (d) => pad.left + ((new Date(d.takenAt).getTime() - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => pad.top + h - (v / yMax) * h;

  const baseline = data.map(() => 0);
  const layers = stack.map((sev) => {
    const lower = baseline.slice();
    data.forEach((d, i) => (baseline[i] += d[sev]));
    const top = data.map((d, i) => `${x(d).toFixed(1)},${y(baseline[i]).toFixed(1)}`);
    const bottom = data.map((d, i) => `${x(d).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
    return `<path d="M${top.join("L")}L${bottom.join("L")}Z" fill="${sevColor(sev)}" fill-opacity="0.85"><title>${sev}</title></path>`;
  });

  const ticks = [0, yMax / 2, yMax];
  const grid = ticks
    .map((v) => `<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" />
      <text class="axis" x="${pad.left - 6}" y="${y(v) + 3.5}" text-anchor="end">${number.format(v)}</text>`)
    .join("");
  const spanHours = (t1 - t0) / 3_600_000;
  const tickFmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", ...(spanHours < 6 && { minute: "2-digit" }) });
  const tickData = spanHours < 1 ? [data[0], data.at(-1)] : [data[0], data[Math.floor(data.length / 2)], data.at(-1)];
  const anchors = tickData.length === 2 ? ["start", "end"] : ["start", "middle", "end"];
  const xLabels = tickData
    .map((d, i) => `<text class="axis" x="${x(d)}" y="${height - 4}" text-anchor="${anchors[i]}">${tickFmt.format(new Date(d.takenAt))}</text>`)
    .join("");

  const latest = data.at(-1);
  const summary = SEVERITIES.map((s) => `${latest[s]} ${s.toLowerCase()}`).join(", ");
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Active alerts over the last 24 hours. Latest: ${summary}.">${grid}${layers.join("")}${xLabels}</svg>`;
}

function niceMax(v) {
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * magnitude >= v) ?? 10;
  return step * magnitude;
}

// ── Map ────────────────────────────────────────────────────────────────────

const map = { instance: null, statesLayer: null, alertsLayer: null, tiles: null };

async function initMap() {
  const L = window.L;
  // Wheel zoom stays off until the map is clicked, so scrolling the page never hijacks the map.
  const m = L.map("map", { zoomSnap: 0.5, minZoom: 2, worldCopyJump: true, scrollWheelZoom: false }).setView([38.5, -96], 4);
  map.instance = m;
  m.once("focus click", () => m.scrollWheelZoom.enable());

  const dark = matchMedia("(prefers-color-scheme: dark)");
  const setTiles = () => {
    map.tiles?.remove();
    const style = dark.matches ? "World_Dark_Gray_Base" : "World_Light_Gray_Base";
    map.tiles = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}/MapServer/tile/{z}/{y}/{x}`, {
      attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
      maxZoom: 16,
    }).addTo(m);
  };
  setTiles();
  dark.addEventListener("change", () => {
    setTiles();
    renderMapStates();
    renderMapAlerts();
    renderHistory();
  });

  const topology = await fetch("/vendor/states-10m.json").then((r) => r.json());
  const states = window.topojson.feature(topology, topology.objects.states);

  map.statesLayer = L.geoJSON(states, {
    style: () => ({ weight: 0.6, color: "#64748b", fillOpacity: 0 }),
    onEachFeature: (feature, layer) => {
      const code = FIPS_TO_AREA[feature.id];
      feature.properties.code = code;
      layer.bindTooltip(() => stateTooltip(code), { sticky: true, className: "map-tooltip" });
      layer.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        layer.closeTooltip();
        openPointPopup(e.latlng, code);
      });
    },
  }).addTo(m);

  map.alertsLayer = L.layerGroup().addTo(m);
  m.on("click", (e) => openPointPopup(e.latlng, null));

  renderMapStates();
  renderMapAlerts();
}

function stateTooltip(code) {
  const entry = state.stats?.byArea[code];
  if (!entry) return `<strong>${esc(areaName(code))}</strong><br />No active ${state.zone === "marine" ? "" : "land "}alerts`;
  return `<strong>${esc(areaName(code))}</strong><br />${entry.count} active alert${entry.count === 1 ? "" : "s"} · max ${esc(entry.maxSeverity)}`;
}

function renderMapStates() {
  if (!map.statesLayer || !state.stats) return;
  const max = Math.max(1, ...Object.values(state.stats.byArea).map((v) => v.count));
  map.statesLayer.setStyle((feature) => {
    const entry = state.stats.byArea[feature.properties.code];
    if (!entry) return { weight: 0.6, color: "#94a3b8", fillOpacity: 0 };
    return {
      weight: 0.8,
      color: sevColor(entry.maxSeverity),
      fillColor: sevColor(entry.maxSeverity),
      // More alerts → more opaque, but never so faint that a single alert disappears.
      fillOpacity: 0.18 + 0.42 * Math.sqrt(entry.count / max),
    };
  });
}

function renderMapAlerts() {
  const L = window.L;
  if (!map.alertsLayer) return;
  map.alertsLayer.clearLayers();
  const outline = css("--text");
  for (const alert of state.alerts) {
    if (!alert.geometry) continue;
    L.geoJSON(alert.geometry, {
      style: { color: outline, weight: 1, opacity: 0.9, fillColor: sevColor(alert.severity), fillOpacity: 0.85 },
    })
      .bindTooltip(`<strong>${esc(alert.event)}</strong><br />Until ${esc(shortDateTime(alert.ends ?? alert.expires))}`, {
        sticky: true,
        className: "map-tooltip",
      })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openDetail(alert.id);
      })
      .addTo(map.alertsLayer);
  }
}

function zoomToAlert(alert) {
  const layer = window.L.geoJSON(alert.geometry);
  map.instance.fitBounds(layer.getBounds(), { maxZoom: 9, padding: [24, 24] });
  $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function openPointPopup(latlng, code) {
  const L = window.L;
  const entry = code ? state.stats?.byArea[code] : null;
  const header = code
    ? `<h3>${esc(areaName(code))}</h3><p class="muted">${entry ? `${entry.count} active alert${entry.count === 1 ? "" : "s"} · max ${esc(entry.maxSeverity)}` : "No active alerts"}</p>
       ${entry ? `<div class="popup-actions"><button type="button" class="link-btn" data-show-area="${esc(code)}">Show alerts in ${esc(areaName(code))} →</button></div>` : ""}`
    : `<h3>Forecast</h3>`;

  const popup = L.popup({ maxWidth: 300 })
    .setLatLng(latlng)
    .setContent(`<div class="popup">${header}<p class="muted" style="margin-top:10px">Loading forecast…</p></div>`)
    .openOn(map.instance);

  const bindActions = () =>
    popup.getElement()?.querySelector("[data-show-area]")?.addEventListener("click", (e) => {
      setArea(e.currentTarget.dataset.showArea);
      map.instance.closePopup();
      $("#alerts").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  bindActions();

  let body;
  try {
    const f = await api(`/api/forecast?lat=${latlng.lat.toFixed(4)}&lon=${latlng.lng.toFixed(4)}`);
    const place = [f.location.city, f.location.state].filter(Boolean).join(", ");
    body = `<p class="muted" style="margin-top:10px">7-day forecast near <strong>${esc(place || "this point")}</strong></p>
      <ul class="forecast">${f.periods
        .slice(0, 4)
        .map(
          (p) => `<li>${p.icon?.startsWith("https://api.weather.gov/") ? `<img src="${esc(p.icon)}" alt="" loading="lazy" />` : "<span></span>"}
            <span><strong>${esc(p.name)}</strong>${esc(p.shortForecast)}${p.precipitationChance >= 10 ? ` · ${p.precipitationChance}% chance of precip` : ""}</span>
            <span class="temp">${p.temperature ?? "—"}°${esc(p.temperatureUnit)}</span></li>`,
        )
        .join("")}</ul>`;
  } catch (err) {
    body = `<p class="muted" style="margin-top:10px">${esc(err.message)}</p>`;
  }
  if (!popup.isOpen()) return;
  popup.setContent(`<div class="popup">${header}${body}</div>`);
  bindActions();
}

// ── Refresh & toast ────────────────────────────────────────────────────────

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function bindRefresh() {
  const btn = $("#refresh");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      const { poll } = await api("/api/poll", { method: "POST" });
      const changes = poll.added + poll.updated + poll.ended;
      toast(
        poll.status === "error"
          ? `NWS API error: ${poll.error}`
          : changes
            ? `Updated: ${poll.added} new, ${poll.updated} updated, ${poll.ended} ended`
            : "Already up to date",
      );
    } catch (err) {
      // 401 = this deployment protects manual polls with ADMIN_TOKEN; reloading the data is still useful.
      toast(
        err.status === 429
          ? "Already up to date — data refreshed under 30 seconds ago"
          : err.status === 401
            ? "Showing the latest data"
            : err.message,
      );
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
      await loadAll();
    }
  });
}

function bindTimeZone() {
  const select = $("#tz");
  select.innerHTML = Object.entries(TIME_ZONES)
    .map(([tz, label]) => `<option value="${tz}">${label === "Local time" ? label : `${label} time`}</option>`)
    .join("");
  select.value = timeZone ?? "";
  select.addEventListener("change", () => {
    setTimeZone(select.value);
    storage("stormpulse:tz", select.value);
    renderAlerts();
    renderMapAlerts();
    if (state.loadedOnce) renderHistory();
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

bindTimeZone();
bindFilters();
bindAlertList();
bindDetail();
bindTopEvents();
bindRefresh();

await loadAll();
openFromHash();
window.addEventListener("hashchange", openFromHash);

initMap().catch((err) => {
  console.error(err);
  $("#map").innerHTML = `<p class="empty">The map couldn't load. The alert list below still works.</p>`;
});

setInterval(() => {
  if (document.visibilityState === "visible") loadAll();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadAll();
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.loadedOnce && renderHistory(), 150);
});
