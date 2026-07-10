import { create } from 'zustand';
import type { Behaviours, BillingPeriod, SolarEffectiveness, UsageProfile } from '../types';

/** Plan-list filters (do not affect the usage profile — just what's shown/ranked). */
/** Tariff kinds for the filter chips. VARIABLE = Amber-style spot; the rest map from pricingModel. */
export type TariffKind = 'SINGLE_RATE' | 'TIME_OF_USE' | 'VARIABLE';

export interface PlanFilters {
  hideIneligible: boolean;
  hasSeniorCard: boolean;
  isNewCustomer: boolean;
  allowPartnerOffers: boolean;
  tariffTypes: TariffKind[]; // empty = all
  greenPowerOnly: boolean;
  noLockIn: boolean;
  excludeDemand: boolean; // drop plans that levy a demand (kW) charge
}

const DEFAULT_FILTERS: PlanFilters = {
  hideIneligible: true,
  hasSeniorCard: false,
  isNewCustomer: false,
  allowPartnerOffers: false,
  tariffTypes: [],
  greenPowerOnly: false,
  noLockIn: false,
  excludeDemand: false,
};
import { DEFAULT_HOME, type HomeInputs, type ApplianceKey } from '../data/applianceProfiles';
import {
  DEFAULT_BEHAVIOURS,
  periodToDailyKwh,
  synthesizeProfile,
  type ApplianceLoads,
  type DerivedProfile,
} from '../lib/usageModel';
import { PLAN_BY_ID } from '../lib/plans';
import { planHourlyImportRates } from '../lib/time';
import { stateForPostcode } from '../data/energyModel';

export type BaselineUnit = 'kWh' | '$';
/** Assumed average all-in price used to convert a $ baseline into kWh. */
const ASSUMED_DOLLARS_PER_KWH = 0.3;

interface DeriveInputs {
  home: HomeInputs;
  baselineAmount: number | null;
  baselineUnit: BaselineUnit;
  period: BillingPeriod;
  effectiveness: SolarEffectiveness;
  behaviours: Behaviours;
  /** Postcode → state selects the RA per-state energy-use & solar figures used in derivation. */
  postcode: string;
  /** The plan V2G/battery arbitrage is optimised against (its cheap hours drive grid top-up). */
  selectedPlanId?: string | null;
}

interface UsageState extends DeriveInputs {
  /** Import/export profile billed by the engine. */
  profile: UsageProfile;
  /**
   * Hand-edited override of `profile` (drag the "what I'm paying for" bars). When non-null it is
   * billed instead of `profile`, letting the user model a custom load-shift scenario. Cleared when
   * any usage input re-derives the profile; survives plan selection so you can shop a scenario.
   */
  manualProfile: UsageProfile | null;
  loads: ApplianceLoads;
  gross: number[];
  solar: number[];
  /** Plan the user pinned as active (null ⇒ follow the cheapest). */
  selectedPlanId: string | null;
  /** The user's current plan, for the savings baseline. */
  currentPlanId: string | null;
  /** Plan-list filters. */
  filters: PlanFilters;
  /** Postcode used to pick the distribution network (DNSP). */
  postcode: string;
  /** Whether the ranked retail offers have been revealed. */
  showPlans: boolean;

  setBaseline: (amount: number | null, unit?: BaselineUnit) => void;
  setHome: (patch: Partial<HomeInputs>) => void;
  setPeriod: (p: BillingPeriod) => void;
  setEffectiveness: (e: SolarEffectiveness) => void;
  setBehaviour: (patch: Partial<Behaviours>) => void;
  setSelectedPlan: (id: string | null) => void;
  setCurrentPlan: (id: string | null) => void;
  setFilter: (patch: Partial<PlanFilters>) => void;
  setPostcode: (pc: string) => void;
  setShowPlans: (v: boolean) => void;
  /** Drag an import bar: set hour `h` of the active day to `value` kWh. `keepTotal` redistributes. */
  setManualImport: (hour: number, value: number, keepTotal: boolean) => void;
  /** Discard hand edits and return to the derived profile. */
  resetManual: () => void;
}

function baselineDaily(amount: number | null, unit: BaselineUnit, period: BillingPeriod): number | undefined {
  if (amount == null || amount <= 0) return undefined;
  const totalKwh = unit === '$' ? amount / ASSUMED_DOLLARS_PER_KWH : amount;
  return periodToDailyKwh(totalKwh, period);
}

function build(s: DeriveInputs): DerivedProfile {
  // Optimise battery/V2G dispatch to the selected plan's rates (only matters when grid arbitrage
  // is on). No selected plan ⇒ the default midday solar-soak window is used.
  const plan = s.selectedPlanId ? PLAN_BY_ID.get(s.selectedPlanId) : undefined;
  const arbitraging = s.behaviours.v2g || s.behaviours.batteryGridCharge;
  const dispatchRates = plan && arbitraging ? planHourlyImportRates(plan, 'WEEKDAY') : undefined;
  return synthesizeProfile({
    home: s.home,
    baselineDailyKwh: baselineDaily(s.baselineAmount, s.baselineUnit, s.period),
    includeSolar: s.home.solarKw > 0,
    effectiveness: s.effectiveness,
    behaviours: s.behaviours,
    state: stateForPostcode(s.postcode),
    dispatchRates,
  });
}

const INITIAL: DeriveInputs = {
  home: DEFAULT_HOME,
  baselineAmount: null,
  baselineUnit: 'kWh',
  period: 'quarterly',
  effectiveness: 'realistic',
  behaviours: DEFAULT_BEHAVIOURS,
  postcode: '2000',
};

export const useUsageStore = create<UsageState>((set) => {
  const initial = build(INITIAL);
  const rederive = (s: UsageState, patch: Partial<DeriveInputs>) => {
    const next = { ...s, ...patch };
    return { ...patch, ...build(next) };
  };

  return {
    ...INITIAL,
    profile: initial.profile,
    manualProfile: null,
    loads: initial.loads,
    gross: initial.gross,
    solar: initial.solar,
    selectedPlanId: null,
    currentPlanId: null,
    filters: DEFAULT_FILTERS,
    postcode: '2000',
    showPlans: false,

    // Usage-input changes re-derive the profile, which invalidates any hand edits → clear them.
    setBaseline: (amount, unit) =>
      set((s) => ({ manualProfile: null, ...rederive(s, { baselineAmount: amount, baselineUnit: unit ?? s.baselineUnit }) })),
    setHome: (patch) => set((s) => ({ manualProfile: null, ...rederive(s, { home: { ...s.home, ...patch } }) })),
    setPeriod: (period) => set((s) => ({ manualProfile: null, ...rederive(s, { period }) })),
    setEffectiveness: (effectiveness) => set((s) => ({ manualProfile: null, ...rederive(s, { effectiveness }) })),
    setBehaviour: (patch) => set((s) => ({ manualProfile: null, ...rederive(s, { behaviours: { ...s.behaviours, ...patch } }) })),

    // Re-derive on select: with V2G/battery arbitrage on, the profile optimises to this plan.
    setSelectedPlan: (selectedPlanId) => set((s) => rederive(s, { selectedPlanId })),
    // Picking a current plan also makes it the active plan driving the graph.
    setCurrentPlan: (currentPlanId) => set((s) => ({ currentPlanId, ...rederive(s, { selectedPlanId: currentPlanId }) })),
    setFilter: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
    // Changing network invalidates pinned/current plans (they may not exist in the new DNSP).
    setPostcode: (postcode) =>
      set((s) => ({ currentPlanId: null, manualProfile: null, ...rederive(s, { selectedPlanId: null, postcode }) })),
    setShowPlans: (showPlans) => set({ showPlans }),

    setManualImport: (hour, value, keepTotal) =>
      set((s) => {
        const base = s.manualProfile ?? s.profile;
        const imp = [...base.import];
        const v = Math.max(0, value);
        if (keepTotal) {
          // Move energy in time without changing the day's total: set this hour, then scale the
          // rest to soak up the difference (proportionally, so their shape is preserved).
          const total = imp.reduce((a, b) => a + b, 0);
          const clamped = Math.min(v, total);
          const rest = total - imp[hour];
          const target = total - clamped;
          imp[hour] = clamped;
          if (rest > 1e-9) {
            const f = target / rest;
            for (let i = 0; i < 24; i++) if (i !== hour) imp[i] *= f;
          } else {
            const share = target / 23;
            for (let i = 0; i < 24; i++) if (i !== hour) imp[i] = share;
          }
        } else {
          imp[hour] = v;
        }
        return { manualProfile: { ...base, import: imp } };
      }),
    resetManual: () => set({ manualProfile: null }),
  };
});

export { baselineDaily, DEFAULT_BEHAVIOURS };
export type { ApplianceKey };
