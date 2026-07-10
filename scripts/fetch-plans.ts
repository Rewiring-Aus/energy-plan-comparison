/**
 * Fetches current residential electricity plans for ALL Australian distribution networks
 * (DNSPs) from the AER's public CDR Energy Product Reference Data, normalises them, and
 * writes a national snapshot plus a postcode→DNSP lookup to src/data/.
 *
 * Source strategy (verified):
 *   1. CDR register brands/summary (no auth) -> list of 85 energy retailer brands.
 *   2. Resolve each brand's aggregator slug (https://cdr.energymadeeasy.gov.au/<slug>/…).
 *   3. List plans (x-v:1, effective=CURRENT, fuelType=ELECTRICITY); keep RESIDENTIAL plans.
 *   4. Fetch each plan's detail (x-v:3) and normalise; tag with its distributor(s).
 *   5. Build a postcode→DNSP map from each plan summary's geography.includedPostcodes.
 *
 * Outputs: src/data/plans.json (all DNSPs) and src/data/postcode-dnsp.json.
 * Usage: npx tsx scripts/fetch-plans.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizePlan, type RawPlanDetail } from '../src/lib/normalizePlan';

const REGISTER = 'https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary';
const AGG = 'https://cdr.energymadeeasy.gov.au';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'data');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const STOP = new Set([
  'energy', 'power', 'electricity', 'australia', 'gas', 'retail', 'pty', 'ltd', 'group', 'au', 'the', 'by',
]);

/**
 * The energymadeeasy aggregator slug is not derivable from the brand name alone
 * (e.g. "Origin Energy" -> "origin", "Alinta Energy" -> "alinta", and self-hosters
 * expose it in publicBaseUri). Generate ranked candidates and probe for one that
 * actually returns electricity plans.
 */
function slugCandidates(brandName: string, publicBaseUri?: string): string[] {
  const cands: string[] = [];
  if (publicBaseUri?.includes('cdr.energymadeeasy.gov.au/')) {
    cands.push(publicBaseUri.split('cdr.energymadeeasy.gov.au/')[1].replace(/\/+$/, ''));
  }
  const words = brandName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  cands.push(slug(brandName));
  cands.push(kept.join(''));
  cands.push(words.join('-')); // hyphenated, e.g. "Energy Locals" -> "energy-locals"
  cands.push(kept.join('-'));
  if (words[0]) cands.push(words[0]);
  if (words.length >= 2) cands.push(words[0] + words[1]);
  return [...new Set(cands.filter(Boolean))];
}

async function resolveSlug(brandName: string, publicBaseUri?: string): Promise<string | null> {
  for (const c of slugCandidates(brandName, publicBaseUri)) {
    try {
      const d = await getJson(
        `${AGG}/${c}/cds-au/v1/energy/plans?fuelType=ELECTRICITY&page-size=1`,
        '1',
      );
      if ((d?.meta?.totalRecords ?? 0) > 0) return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function getJson(url: string, version: string, tries = 3): Promise<any> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-v': version, Accept: 'application/json' },
      });
      if (res.status === 406) {
        // version negotiation fallback
        const max = res.headers.get('x-v');
        if (max && max !== version) return getJson(url, max, tries);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(400 * attempt);
    }
  }
}

/** Run async tasks with bounded concurrency. */
async function pMap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface PlanSummary {
  planId: string;
  customerType?: string;
  geography?: { distributors?: string[]; includedPostcodes?: string[] };
}

async function listBrandPlans(brandSlug: string): Promise<PlanSummary[]> {
  const plans: PlanSummary[] = [];
  let page = 1;
  for (;;) {
    const url = `${AGG}/${brandSlug}/cds-au/v1/energy/plans?effective=CURRENT&fuelType=ELECTRICITY&page-size=1000&page=${page}`;
    let data: any;
    try {
      data = await getJson(url, '1');
    } catch {
      return plans;
    }
    const got: PlanSummary[] = data?.data?.plans ?? [];
    plans.push(...got);
    const totalPages = data?.meta?.totalPages ?? 1;
    if (page >= totalPages || got.length === 0) break;
    page++;
  }
  return plans;
}

async function main() {
  console.log('Fetching brand register…');
  const reg = await getJson(REGISTER, '1');
  const brands: Array<{ brandName: string; publicBaseUri?: string }> = reg.data ?? [];
  console.log(`  ${brands.length} energy brands`);

  console.log('Listing residential electricity plans across ALL networks…');
  const unresolved: string[] = [];
  // postcode -> { distributor -> count }, to derive each postcode's primary DNSP.
  const postcodeVotes = new Map<string, Map<string, number>>();

  const byBrand = await pMap(brands, 6, async (b) => {
    const s = await resolveSlug(b.brandName, b.publicBaseUri);
    if (!s) {
      unresolved.push(b.brandName);
      return [] as Array<{ slug: string; planId: string }>;
    }
    const all = await listBrandPlans(s);
    const res = all.filter((p) => !p.customerType || p.customerType.toUpperCase() === 'RESIDENTIAL');
    // accumulate postcode → distributor votes
    for (const p of res) {
      const dists = p.geography?.distributors ?? [];
      for (const pc of p.geography?.includedPostcodes ?? []) {
        let m = postcodeVotes.get(pc);
        if (!m) postcodeVotes.set(pc, (m = new Map()));
        for (const d of dists) m.set(d, (m.get(d) ?? 0) + 1);
      }
    }
    if (res.length) console.log(`  ${b.brandName} (${s}): ${res.length} plans`);
    return res.map((p) => ({ slug: s, planId: p.planId }));
  });

  // Dedupe by planId (distinct register brands can share one aggregator slug).
  const seen = new Set<string>();
  const targets = byBrand.flat().filter((t) => {
    if (seen.has(t.planId)) return false;
    seen.add(t.planId);
    return true;
  });
  console.log(`\n${targets.length} unique residential plans. Fetching details…`);

  let done = 0;
  const details = await pMap(targets, 10, async (t) => {
    try {
      const d = await getJson(`${AGG}/${t.slug}/cds-au/v1/energy/plans/${t.planId}`, '3');
      const raw: RawPlanDetail = d?.data;
      const plan = raw ? normalizePlan(raw) : null;
      if (++done % 250 === 0) console.log(`  …${done}/${targets.length}`);
      return plan;
    } catch {
      return null;
    }
  });

  const plans = details.filter((p): p is NonNullable<typeof p> => p != null && p.distributors.length > 0);

  // Resolve each postcode to its most-covered distributor.
  const postcodeToDnsp: Record<string, string> = {};
  for (const [pc, votes] of postcodeVotes) {
    let best = '';
    let bestN = -1;
    for (const [d, n] of votes) if (n > bestN) ((bestN = n), (best = d));
    if (best) postcodeToDnsp[pc] = best;
  }

  // Coverage report
  const byDist: Record<string, number> = {};
  for (const p of plans) for (const d of p.distributors) byDist[d] = (byDist[d] || 0) + 1;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'plans.json'), JSON.stringify({ fetchedCount: plans.length, plans }, null, 0));
  writeFileSync(join(OUT_DIR, 'postcode-dnsp.json'), JSON.stringify(postcodeToDnsp));

  console.log(`\nWrote ${plans.length} plans -> src/data/plans.json`);
  console.log(`Wrote ${Object.keys(postcodeToDnsp).length} postcodes -> src/data/postcode-dnsp.json`);
  console.log('  plans per distributor:', byDist);
  if (unresolved.length) {
    console.log(`\n  Note: ${unresolved.length} brands unresolved (self-hosting, e.g. Red Energy, OVO).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
