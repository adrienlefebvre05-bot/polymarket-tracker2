const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const GAMMA_EVENTS =
  "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=500";

const SPORT_KEYWORDS = [
  { match: /nba/i, label: "NBA" },
  { match: /nfl/i, label: "NFL" },
  { match: /mlb/i, label: "MLB" },
  { match: /nhl/i, label: "NHL" },
  { match: /ncaaf|college football/i, label: "NCAAF" },
  { match: /ncaab|college basketball/i, label: "NCAAB" },
  { match: /tennis/i, label: "Tennis" },
  { match: /\b(mma|ufc)\b/i, label: "MMA" },
  { match: /boxing/i, label: "Boxing" },
  { match: /golf/i, label: "Golf" },
  { match: /formula ?1|\bf1\b/i, label: "F1" },
  { match: /cricket/i, label: "Cricket" },
  { match: /rugby/i, label: "Rugby" },
  { match: /esports|league of legends|valorant|csgo|cs2|dota/i, label: "Esports" },
  { match: /champions league/i, label: "UCL" },
  { match: /premier league|epl/i, label: "EPL" },
  { match: /la liga/i, label: "La Liga" },
  { match: /serie a/i, label: "Serie A" },
  { match: /bundesliga/i, label: "Bundesliga" },
  { match: /ligue 1/i, label: "Ligue 1" },
  { match: /world cup/i, label: "World Cup" },
  { match: /\bmls\b/i, label: "MLS" },
  { match: /soccer|football club|\bfc\b/i, label: "Soccer" },
  { match: /\bsports\b/i, label: "Sports" },
];

function detectSport(event) {
  const haystack = [event.title || "", ...(event.tags || []).map((t) => t.label || t.slug || "")].join(" ");
  for (const { match, label } of SPORT_KEYWORDS) {
    if (match.test(haystack)) return label;
  }
  return null;
}

async function upsertChunk(rows) {
  const url = `${SUPABASE_URL}/rest/v1/pm_sports_snapshots?on_conflict=snapshot_date,slug`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${text}`);
  }
}

async function main() {
  console.log("Fetching Polymarket events...");
  const res = await fetch(GAMMA_EVENTS);
  if (!res.ok) throw new Error(`Polymarket API returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Unexpected response shape from Polymarket API");

  const today = new Date().toISOString().slice(0, 10);

  const rows = data
    .map((e) => {
      const sport = detectSport(e);
      if (!sport) return null;
      const volume24hr = parseFloat(e.volume24hr || 0);
      const volumeTotal = parseFloat(e.volume || 0);
      if (volume24hr <= 0) return null;
      return {
        snapshot_date: today,
        slug: e.slug,
        title: e.title,
        sport,
        volume_24hr: volume24hr,
        volume_total: volumeTotal,
        end_date: e.endDate || null,
      };
    })
    .filter(Boolean);

  console.log(`Found ${rows.length} sports events with volume. Upserting into Supabase for ${today}...`);

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await upsertChunk(rows.slice(i, i + chunkSize));
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
