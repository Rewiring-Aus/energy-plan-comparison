import './styles/global.css';
import { useMemo } from 'react';
import { useUsageStore, baselineDaily } from './store/usageStore';
import { rankPlans, rankPlansOptimised, costPlanOptimised, computeCost } from './lib/costEngine';
import type { SynthInput } from './lib/usageModel';
import { PLAN_BY_ID, dnspForPostcode, plansForDnsp, passesFilters } from './lib/plans';
import { stateForPostcode } from './data/energyModel';
import { HomeModelSentence } from './components/UsageBuilder/HomeModelSentence';
import { HourlyProfileEditor } from './components/UsageBuilder/HourlyProfileEditor';
import { PlanList } from './components/PlanList/PlanList';
import { CurrentPlanPicker } from './components/PlanList/CurrentPlanPicker';

export default function App() {
  const period = useUsageStore((s) => s.period);
  const profile = useUsageStore((s) => s.profile);
  const selectedPlanId = useUsageStore((s) => s.selectedPlanId);
  const postcode = useUsageStore((s) => s.postcode);
  const showPlans = useUsageStore((s) => s.showPlans);
  const setShowPlans = useUsageStore((s) => s.setShowPlans);
  const home = useUsageStore((s) => s.home);
  const behaviours = useUsageStore((s) => s.behaviours);
  const effectiveness = useUsageStore((s) => s.effectiveness);
  const baselineAmount = useUsageStore((s) => s.baselineAmount);
  const baselineUnit = useUsageStore((s) => s.baselineUnit);
  const filters = useUsageStore((s) => s.filters);
  const currentPlanId = useUsageStore((s) => s.currentPlanId);
  const manualProfile = useUsageStore((s) => s.manualProfile);

  // Bill the hand-edited scenario when one exists, otherwise the derived profile.
  const activeProfile = manualProfile ?? profile;

  // With battery/V2G arbitrage on, each plan is optimised to its OWN rates (per-plan dispatch) so
  // the ranking is a fair comparison — selecting one plan no longer re-prices the others. Skipped
  // when the user has hand-edited a scenario (manualProfile), which is billed as-is everywhere.
  const arbitraging = (behaviours.v2g || behaviours.batteryGridCharge) && !manualProfile;
  const synthBase: Omit<SynthInput, 'dispatchRates'> = useMemo(
    () => ({
      home,
      baselineDailyKwh: baselineDaily(baselineAmount, baselineUnit, period),
      includeSolar: home.solarKw > 0,
      effectiveness,
      behaviours,
      state: stateForPostcode(postcode),
    }),
    [home, baselineAmount, baselineUnit, period, effectiveness, behaviours, postcode],
  );

  const dnsp = dnspForPostcode(postcode);
  const plans = useMemo(() => plansForDnsp(dnsp), [dnsp]);
  const filteredPlans = useMemo(() => plans.filter((p) => passesFilters(p, filters, home)), [plans, filters, home]);
  const ranked = useMemo(
    () =>
      arbitraging
        ? rankPlansOptimised(filteredPlans, synthBase, { period })
        : rankPlans(filteredPlans, activeProfile, { period }),
    [arbitraging, filteredPlans, synthBase, activeProfile, period],
  );

  // Current plan cost (computed even if it's filtered out — it's still the user's plan).
  const currentResult = useMemo(() => {
    const p = currentPlanId ? PLAN_BY_ID.get(currentPlanId) : undefined;
    if (!p) return null;
    return arbitraging ? costPlanOptimised(p, synthBase, { period }) : computeCost(p, activeProfile, { period });
  }, [currentPlanId, arbitraging, synthBase, activeProfile, period]);
  const activeResult = useMemo(() => {
    if (selectedPlanId) {
      const inRanked = ranked.find((r) => r.planId === selectedPlanId);
      if (inRanked) return inRanked;
      // Selected plan may be filtered out of the ranked list (e.g. the current plan) —
      // still make it the active plan by costing it directly.
      const p = PLAN_BY_ID.get(selectedPlanId);
      if (p) return computeCost(p, activeProfile, { period });
    }
    return ranked[0];
  }, [ranked, selectedPlanId, activeProfile, period]);
  const activePlan = activeResult ? PLAN_BY_ID.get(activeResult.planId) : undefined;


  return (
    <div className="app">
      <div className="layout">
        <div className="left-col">
          <header className="app-header">
            <h1>Find your best energy plan</h1>
            <p>
              Wondering about changing plans or trying to use the new 3 hours of free power? This tool will help
              you see if you can move your energy usage around during the day to save more on your bills.
            </p>
          </header>
          <HomeModelSentence />
          {showPlans && <HourlyProfileEditor activePlan={activePlan} activeResult={activeResult} />}
        </div>

        <div className="right-col">
          <div className={currentPlanId ? undefined : 'current-sticky'}>
            <CurrentPlanPicker plans={plans} />
          </div>
          {showPlans ? (
            <PlanList
              ranked={ranked}
              activePlanId={activeResult?.planId}
              currentResult={currentResult}
              dnsp={dnsp}
              postcode={postcode}
              total={plans.length}
            />
          ) : (
            <div className="reveal-cta">
              <p className="reveal-lead">Ready when you are.</p>
              <p className="reveal-sub">
                Pick your current plan above to see your savings, then we'll rank all{' '}
                <strong>{plans.length}</strong> plans on the <strong>{dnsp ?? 'your'}</strong>{' '}
                network for your home and let you shape your usage to see how time-of-use rates
                change the bill.
              </p>
              <button className="reveal-btn" onClick={() => setShowPlans(true)} disabled={!dnsp}>
                Show my energy plan options →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
