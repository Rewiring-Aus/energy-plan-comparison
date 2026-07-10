/**
 * Builds an average wholesale-price curve per NEM region from AEMO's public "Aggregated price and
 * demand data" (no auth). For each region we pull the last 12 months of settlement-interval
 * Regional Reference Price (RRP, $/MWh), average by hour-of-day (all days), and write a 24-value
 * $/kWh curve to src/data/wholesale-price.json.
 *
 * Used to model variable-wholesale plans (Amber etc.) as a 24×1h TOU: rate[h] ≈ wholesale[h] +
 * network tariff[h] + fees. See src/lib/normalizePlan.ts.
 *
 * Usage: npx tsx scripts/fetch-wholesale.ts
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'wholesale-price.json');
const BASE = 'https://www.aemo.com.au/aemo/data/nem/priceanddemand';

const REGIONS = ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1'] as const;
type Region = (typeof REGIONS)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last 12 completed calendar months as YYYYMM strings (most recent first). */
function lastTwelveMonths(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Sum + count of RRP ($/MWh) per hour-of-day for one region-month CSV. */
async function accumulateMonth(region: Region, yyyymm: string, sum: number[], count: number[]): Promise<boolean> {
  const url = `${BASE}/PRICE_AND_DEMAND_${yyyymm}_${region}.csv`;
  const res = await fetch(url);
  if (!res.ok) return false;
  const text = await res.text();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 4) continue;
    const ts = cols[1]; // "YYYY/MM/DD HH:MM:SS" — interval-ENDING
    const rrp = Number(cols[3]);
    if (!ts || Number.isNaN(rrp)) continue;
    const hh = Number(ts.slice(11, 13));
    const mm = Number(ts.slice(14, 16));
    if (Number.isNaN(hh)) continue;
    // Interval-ending timestamp: the top of the hour (mm===0) belongs to the previous hour.
    const hour = mm === 0 ? (hh + 23) % 24 : hh;
    sum[hour] += rrp;
    count[hour] += 1;
  }
  return true;
}

async function main() {
  const months = lastTwelveMonths();
  const curves: Record<string, number[]> = {};

  for (const region of REGIONS) {
    const sum = new Array(24).fill(0);
    const count = new Array(24).fill(0);
    let months_ok = 0;
    for (const m of months) {
      const ok = await accumulateMonth(region, m, sum, count);
      if (ok) months_ok++;
      await sleep(120);
    }
    // $/MWh → $/kWh (÷1000). Fallback to 0 for any empty hour (shouldn't happen).
    curves[region] = sum.map((s, h) => (count[h] > 0 ? s / count[h] / 1000 : 0));
    const avg = (curves[region].reduce((a, b) => a + b, 0) / 24) * 100;
    const peak = Math.max(...curves[region]) * 100;
    console.log(`  ${region}: ${months_ok}/12 months · avg ${avg.toFixed(1)}c/kWh · peak ${peak.toFixed(1)}c/kWh`);
  }

  writeFileSync(OUT, JSON.stringify({ months, curves }, null, 0));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
