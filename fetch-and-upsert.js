// Finds the biggest currently-open wallet positions ("bets") on Polymarket sports markets.
// For each active sports market, pulls the top holders per outcome token, converts their
// share balance to a live USD value, looks up the price they entered at, and stores the
// top 1000 open positions in Supabase.
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const GAMMA_EVENTS =
  "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=400";
const DATA_API_HOLDERS = "https://data-api.polymarket.com/holders";
const DATA_API_POSITIONS = "https://data-api.polymarket.com/positions";

// How many of the highest-volume sports markets to scan for large positions.
const MARKETS_TO_SCAN = 300;
// How many of the biggest positions to keep, PER SPORT (not globally) — so a high-volume
// sport like NBA doesn't crowd out smaller ones like tennis or MMA.
const TOP_N_PER_SPORT = 1000;
// Looking up entry price costs one extra API call per bet. Capped per sport to keep the
// daily run from taking hours — bets beyond this rank still show up, just without odds.
const ENTRY_PRICE_LOOKUP_CAP_PER_SPORT = 150;

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

// Excludes "who wins the World Cup" style futures/outcome markets, while still keeping
// individual match bets (e.g. "France vs Spain") that happen to be part of a World Cup event.
function isWorldCupWinnerMarket(marketTitle) {
  return /world cup/i.test(marketTitle) && /winner|champion|win the/i.test(marketTitle);
}

// Wallets to always exclude from results. Since displayed addresses are shortened
// (e.g. "0xa5ef…2966"), matching is done by prefix + suffix rather than full address.
const EXCLUDED_WALLETS = [
  { prefix: "0xa5ef", suffix: "2966" },
];

function isExcludedWallet(address) {
  if (!address) return false;
  const lower = address.toLowerCase();
  return EXCLUDED_WALLETS.some(
    ({ prefix, suffix }) => lower.startsWith(prefix.toLowerCase()) && lower.endsWith(suffix.toLowerCase())
  );
}

function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getHoldersForMarket(conditionId) {
  const url = `${DATA_API_HOLDERS}?market=${conditionId}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  holders lookup failed for ${conditionId}: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getEntryPrice(wallet, conditionId, tokenId) {
  const url = `${DATA_API_POSITIONS}?user=${wallet}&market=${conditionId}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const match = data.find((p) => p.asset === tokenId) || data[0];
    return match && typeof match.avgPrice === "number" ? match.avgPrice : null;
  } catch {
    return null;
  }
}

async function upsertChunk(rows) {
  const url = `${SUPABASE_URL}/rest/v1/pm_sports_top_bets?on_conflict=snapshot_date,market_slug,wallet,outcome`;
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
  console.log("Fetching Polymarket sports events...");
  const res = await fetch(GAMMA_EVENTS);
  if (!res.ok) throw new Error(`Polymarket API returned ${res.status}`);
  const events = await res.json();
  if (!Array.isArray(events)) throw new Error("Unexpected response shape from Polymarket API");

  const today = new Date().toISOString().slice(0, 10);
  const allBets = [];

  let scanned = 0;
  for (const event of events) {
    const sport = detectSport(event);
    if (!sport) continue;
    if (scanned >= MARKETS_TO_SCAN) break;

    for (const market of event.markets || []) {
      if (scanned >= MARKETS_TO_SCAN) break;
      if (!market.conditionId) continue;

      const title = market.question || event.title || "";
      if (isWorldCupWinnerMarket(title)) continue;

      scanned++;

      const tokenIds = safeParseArray(market.clobTokenIds);
      const prices = safeParseArray(market.outcomePrices).map((p) => parseFloat(p));
      const outcomes = safeParseArray(market.outcomes);
      if (tokenIds.length === 0) continue;

      let holderGroups;
      try {
        holderGroups = await getHoldersForMarket(market.conditionId);
      } catch (e) {
        console.warn(`  error fetching holders for ${market.slug}: ${e.message}`);
        continue;
      }

      for (const group of holderGroups) {
        const tokenIndex = tokenIds.indexOf(group.token);
        const price = tokenIndex >= 0 ? prices[tokenIndex] || 0 : 0;
        const outcomeLabel = tokenIndex >= 0 ? outcomes[tokenIndex] || "?" : "?";

        for (const holder of group.holders || []) {
          if (isExcludedWallet(holder.proxyWallet)) continue;
          const amount = parseFloat(holder.amount || 0);
          const usdValue = amount * price;
          if (usdValue <= 0) continue;
          allBets.push({
            snapshot_date: today,
            market_slug: market.slug || event.slug,
            wallet: holder.proxyWallet,
            outcome: outcomeLabel,
            market_title: title,
            sport,
            amount,
            price,
            usd_value: usdValue,
            wallet_name: holder.pseudonym || holder.name || null,
            _conditionId: market.conditionId,
            _tokenId: group.token,
          });
        }
      }

      await sleep(60);
    }
  }

  allBets.sort((a, b) => b.usd_value - a.usd_value);

  // Group by sport, keep the top N within each sport
  const bySport = {};
  for (const bet of allBets) {
    (bySport[bet.sport] = bySport[bet.sport] || []).push(bet);
  }
  const topBets = [];
  for (const sport of Object.keys(bySport)) {
    const picked = bySport[sport].slice(0, TOP_N_PER_SPORT);
    picked.forEach((bet) => (bet.entry_price = null));
    topBets.push(...picked);
  }

  console.log(`Scanned ${scanned} markets, found ${allBets.length} positions across ${Object.keys(bySport).length} sports, keeping top ${TOP_N_PER_SPORT} per sport (${topBets.length} total).`);
  console.log(`Looking up entry prices for the top ${ENTRY_PRICE_LOOKUP_CAP_PER_SPORT} per sport...`);

  for (const sport of Object.keys(bySport)) {
    const capped = bySport[sport].slice(0, ENTRY_PRICE_LOOKUP_CAP_PER_SPORT);
    for (const bet of capped) {
      bet.entry_price = await getEntryPrice(bet.wallet, bet._conditionId, bet._tokenId);
      await sleep(40);
    }
  }
  for (const bet of topBets) {
    delete bet._conditionId;
    delete bet._tokenId;
  }

  const chunkSize = 200;
  for (let i = 0; i < topBets.length; i += chunkSize) {
    await upsertChunk(topBets.slice(i, i + chunkSize));
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
