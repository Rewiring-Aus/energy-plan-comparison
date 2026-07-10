import { useState } from 'react';
import { useUsageStore, type TariffKind } from '../../store/usageStore';

const TARIFF_OPTS: { value: TariffKind; label: string }[] = [
  { value: 'SINGLE_RATE', label: 'Single rate' },
  { value: 'TIME_OF_USE', label: 'Time of use' },
  { value: 'VARIABLE', label: 'Variable' },
];

export function PlanFilters() {
  const f = useUsageStore((s) => s.filters);
  const setFilter = useUsageStore((s) => s.setFilter);
  const [open, setOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  const toggleTariff = (t: TariffKind) =>
    setFilter({ tariffTypes: f.tariffTypes.includes(t) ? f.tariffTypes.filter((x) => x !== t) : [...f.tariffTypes, t] });

  // Count non-default filters so a collapsed panel still signals it's doing something.
  const active =
    (f.hideIneligible ? 0 : 1) + // hide-ineligible ON is the default; count when relaxed
    [f.hasSeniorCard, f.isNewCustomer, f.allowPartnerOffers, f.greenPowerOnly, f.noLockIn, f.excludeDemand].filter(Boolean)
      .length +
    (f.tariffTypes.length ? 1 : 0);

  return (
    <div className={`filters${open ? ' open' : ''}`}>
      <button className="filters-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="filters-caret">{open ? '▾' : '▸'}</span>
        Filters
        {active > 0 && <span className="filters-active">{active} on</span>}
      </button>

      {open && (
        <div className="filters-body">
          <label className="chk">
            <input type="checkbox" checked={f.hideIneligible} onChange={(e) => setFilter({ hideIneligible: e.target.checked })} />
            Only show plans I can get
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.hasSeniorCard} onChange={(e) => setFilter({ hasSeniorCard: e.target.checked })} />
            I have a seniors/pensioner card
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.isNewCustomer} onChange={(e) => setFilter({ isNewCustomer: e.target.checked })} />
            I'm a new / moving-in customer
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.allowPartnerOffers} onChange={(e) => setFilter({ allowPartnerOffers: e.target.checked })} />
            Include partner / membership offers
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.greenPowerOnly} onChange={(e) => setFilter({ greenPowerOnly: e.target.checked })} />
            GreenPower available
          </label>
          <label className="chk">
            <input type="checkbox" checked={f.noLockIn} onChange={(e) => setFilter({ noLockIn: e.target.checked })} />
            No lock-in / exit fees
          </label>
          <div className="chk-info">
            <label className="chk">
              <input type="checkbox" checked={f.excludeDemand} onChange={(e) => setFilter({ excludeDemand: e.target.checked })} />
              Exclude plans with demand charges
            </label>
            <button
              className="info-icon"
              aria-label="What is a demand charge?"
              aria-expanded={tipOpen}
              onClick={() => setTipOpen((t) => !t)}
            >
              i
            </button>
            {tipOpen && (
              <div className="info-tip" role="tooltip">
                A <strong>demand charge</strong> bills you on your single highest half-hour of power draw (in kW) each
                month — on top of your usage charges. It can sting homes that run big loads at once (EV + aircon + oven),
                even if total energy use is modest.
              </div>
            )}
          </div>

          <div className="filters-tariff">
            <span className="filters-label">Tariff type:</span>
            {TARIFF_OPTS.map((t) => (
              <button
                key={t.value}
                className={`chip-toggle${f.tariffTypes.includes(t.value) ? ' on' : ''}`}
                onClick={() => toggleTariff(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
