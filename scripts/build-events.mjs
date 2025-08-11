// Node 20+: fetch is global
import fs from "node:fs/promises";

// --------- helpers
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const toISODate = (d) => new Date(d).toISOString().slice(0, 10);
const idFrom = ({ date, city, venue }) =>
  `${date}-${norm(city).replace(/ /g, "-")}-${norm(venue).replace(/ /g, "-")}`;

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[m][n];
}
const similar = (a, b) => levenshtein(norm(a), norm(b)) <= 2;

function mergeTickets(a = [], b = []) {
  const seen = new Set();
  return [...a, ...b].filter((t) => {
    const k = (t.label || "") + "|" + (t.url || "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const statusRank = { cancelled: 3, sold_out: 2, on_sale: 1, tba: 0 };
const mergeStatus = (a = "tba", b = "tba") =>
  Object.entries(statusRank).find(
    ([k, v]) => v === Math.max(statusRank[a] ?? 0, statusRank[b] ?? 0)
  )[0];

const sourceLabel = (s) =>
  ({
    eventbrite: "Eventbrite",
    bandsintown: "Bandsintown",
    skiddle: "Skiddle",
    ticketmaster: "Ticketmaster",
  }[s] || s);

function makeEvent({
  date,
  time,
  city,
  venue,
  title,
  supports,
  source,
  url,
  status,
}) {
  return {
    id: "",
    date: toISODate(date),
    time: time || null,
    city: city || "",
    venue: venue || "",
    title: title || null,
    supports: supports?.length ? supports : [],
    status: status || "on_sale",
    sources: [source],
    tickets: url ? [{ label: sourceLabel(source), url }] : [],
  };
}

// --------- fetchers
async function fetchEventbrite() {
  const token = process.env.EVENTBRITE_TOKEN;
  if (!token) return [];
  const org = process.env.EVENTBRITE_ORG_ID;
  // expand=venue so we don’t need a second request
  const base = org
    ? `https://www.eventbriteapi.com/v3/organizations/${org}/events/?status=live,started,ended,canceled&expand=venue`
    : `https://www.eventbriteapi.com/v3/users/me/events/?status=live,started,ended,canceled&expand=venue`;
  const res = await fetch(base, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const events = (data.events || []).map((ev) =>
    makeEvent({
      date: ev.start?.utc || ev.start?.local,
      time: ev.start?.local?.slice(11, 16) || null,
      city: ev.venue?.address?.city || "",
      venue: ev.venue?.name || "",
      title: ev.name?.text || null,
      source: "eventbrite",
      url: ev.url,
      status: ev.status === "canceled" ? "cancelled" : "on_sale",
    })
  );
  return events;
}

async function fetchBandsintown() {
  const appId = process.env.BANDSINTOWN_APP_ID;
  const artist = process.env.BANDSINTOWN_ARTIST;
  if (!appId || !artist) return [];
  const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(
    artist
  )}/events?app_id=${encodeURIComponent(appId)}&date=all`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];
  return arr.map((e) =>
    makeEvent({
      date: e.datetime,
      time: e.datetime?.slice(11, 16) || null,
      city: `${e.venue?.city || ""}${
        e.venue?.country ? ", " + e.venue.country : ""
      }`,
      venue: e.venue?.name || "",
      title: e.title || e.description || null,
      source: "bandsintown",
      url: e.offers?.[0]?.url || e.url || null,
      status: e.offers?.some((o) => /sold\s*out/i.test(o.status || ""))
        ? "sold_out"
        : "on_sale",
    })
  );
}

async function fetchSkiddle() {
  const key = process.env.SKIDDLE_API_KEY;
  if (!key) return [];
  // Placeholder: we’ll plug the right artist/endpoint once we decide the best filter.
  return [];
}

async function fetchTicketmaster() {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return [];
  // Basic keyword search; we can refine with classificationName, countryCode, etc.
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}&keyword=${encodeURIComponent(
    "Osiah"
  )}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const list = data?._embedded?.events || [];
  return list.map((ev) => {
    const v = ev._embedded?.venues?.[0] || {};
    const city = `${v.city?.name || ""}${
      v.country?.countryCode ? ", " + v.country.countryCode : ""
    }`;
    return makeEvent({
      date: ev.dates?.start?.dateTime || ev.dates?.start?.localDate,
      time: ev.dates?.start?.localTime || null,
      city,
      venue: v.name || "",
      title: ev.name || null,
      source: "ticketmaster",
      url: ev.url || null,
      status: ev.dates?.status?.code === "cancelled" ? "cancelled" : "on_sale",
    });
  });
}

// --------- merge/dedupe/split
function mergeEvents(events) {
  const groups = [];
  for (const e of events) {
    let g = groups.find(
      (x) =>
        x.date === e.date &&
        (norm(x.city) === norm(e.city) || similar(x.city, e.city)) &&
        (norm(x.venue) === norm(e.venue) || similar(x.venue, e.venue))
    );
    if (!g) {
      groups.push({ ...e });
    } else {
      g.tickets = mergeTickets(g.tickets, e.tickets);
      g.sources = Array.from(
        new Set([...(g.sources || []), ...(e.sources || [])])
      );
      g.status = mergeStatus(g.status, e.status);
      g.title = g.title || e.title || null;
      if (e.supports?.length) {
        const s = new Set([...(g.supports || []), ...e.supports]);
        g.supports = Array.from(s);
      }
    }
  }
  for (const g of groups) g.id = idFrom(g);
  return groups.sort((a, b) => a.date.localeCompare(b.date));
}

function splitUpcomingPast(events) {
  const today = toISODate(new Date());
  const upcoming = events.filter((e) => e.date >= today);
  const past = events.filter((e) => e.date < today).reverse();
  return { upcoming, past };
}

// --------- main
(async function main() {
  const all = [
    ...(await fetchEventbrite()),
    ...(await fetchBandsintown()),
    ...(await fetchSkiddle()),
    ...(await fetchTicketmaster()),
  ];
  const merged = mergeEvents(all);
  const { upcoming, past } = splitUpcomingPast(merged);

  // Write to /web (your Firebase public dir)
  await fs.writeFile("web/events.json", JSON.stringify(merged, null, 2));
  await fs.writeFile("web/upcoming.json", JSON.stringify(upcoming, null, 2));
  await fs.writeFile("web/past.json", JSON.stringify(past, null, 2));

  console.log(
    `Wrote ${merged.length} events (${upcoming.length} upcoming, ${past.length} past).`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
