// AtmosphereControls — a settings panel sample, for manual testing
//
// For nudging weather, time of day and color filters by hand to check how
// they look. Not meant to be used as a production UI — copy and rebuild it
// if you need one.

import { useState, type ReactNode } from 'react';
import {
  WEATHER_IDS, FILTER_IDS, formatTod,
  weatherLabel as defaultWeatherLabel, filterLabel as defaultFilterLabel,
  type WeatherId, type FilterId, type Locale,
} from '../../src';

export interface AtmosphereControlsValue {
  enabled: boolean;
  weather: WeatherId;
  timeOfDay: number;
  filter: FilterId;
}

export interface AtmosphereControlsLabels {
  title: string;
  enabled: string;
  filter: string;
  close: string;
  open: string;
  time: string;
}

// UI chrome text per locale (the weather/filter chip labels come from src/i18n.ts instead)
const CHROME_LABELS: Record<Locale, AtmosphereControlsLabels> = {
  en: {
    title: 'Sky',
    enabled: 'Show (fades to black when off)',
    filter: 'Color filter',
    close: 'Close',
    open: 'Sky settings',
    time: 'Time',
  },
  ja: {
    title: '大気',
    enabled: '表示（OFFで暗転）',
    filter: 'カラーフィルター',
    close: '閉じる',
    open: '大気の設定',
    time: '時刻',
  },
};

export interface AtmosphereControlsProps extends AtmosphereControlsValue {
  onChange: (patch: Partial<AtmosphereControlsValue>) => void;
  /**
   * pass true to disable manual weather/time controls.
   * Used when something external (e.g. scene progression) is driving the
   * sky; pass its effective value as weather/timeOfDay in that case.
   */
  locked?: boolean;
  /** extra controls inserted right after "Show" */
  extraControls?: ReactNode;
  /** UI language for chrome text and preset labels. Defaults to 'en' */
  locale?: Locale;
  labels?: Partial<AtmosphereControlsLabels>;
  /** override the weather button labels */
  weatherLabel?: (id: WeatherId) => string;
  /** override the filter button labels */
  filterLabel?: (id: FilterId) => string;
}

export function AtmosphereControls({
  enabled, weather, timeOfDay, filter,
  onChange, locked = false, extraControls, locale = 'en', labels,
  weatherLabel, filterLabel,
}: AtmosphereControlsProps) {
  const [open, setOpen] = useState(false);
  const t = { ...CHROME_LABELS[locale], ...labels };
  const wLabel = weatherLabel ?? ((id: WeatherId) => defaultWeatherLabel(id, locale));
  const fLabel = filterLabel ?? ((id: FilterId) => defaultFilterLabel(id, locale));

  if (!open) {
    return (
      <button
        className="atmo-panel-toggle"
        onClick={() => setOpen(true)}
        aria-label={t.open}
        title={t.open}
      >
        <svg viewBox="0 0 18 18" width="16" height="16">
          <circle cx="6" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 13h9a3 3 0 0 0 0-6 4 4 0 0 0-1-.9"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    <div className="atmo-panel">
      <div className="atmo-panel-header">
        <span>{t.title}</span>
        <button className="atmo-panel-close" onClick={() => setOpen(false)} aria-label={t.close}>×</button>
      </div>

      <label className="atmo-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        {t.enabled}
      </label>

      {extraControls}

      <div className={`atmo-weather-row${locked ? ' disabled' : ''}`}>
        {WEATHER_IDS.map((id) => (
          <button
            key={id}
            className={`atmo-chip${weather === id ? ' active' : ''}`}
            disabled={locked}
            onClick={() => onChange({ weather: id })}
          >
            {wLabel(id)}
          </button>
        ))}
      </div>

      <div className={`atmo-time-row${locked ? ' disabled' : ''}`}>
        <span className="atmo-time-label">{formatTod(timeOfDay)}</span>
        <input
          type="range"
          min="0"
          max="24"
          step="0.25"
          value={timeOfDay}
          disabled={locked}
          onChange={(e) => onChange({ timeOfDay: Number(e.target.value) % 24 })}
          aria-label={t.time}
        />
      </div>

      <div className="atmo-section-label">{t.filter}</div>
      <div className="atmo-weather-row">
        {FILTER_IDS.map((id) => (
          <button
            key={id}
            className={`atmo-chip${filter === id ? ' active' : ''}`}
            onClick={() => onChange({ filter: id })}
          >
            {fLabel(id)}
          </button>
        ))}
      </div>
    </div>
  );
}
