import {
  DISASTER_KINDS,
  DISASTER_SEVERITIES,
  MAX_DISASTERS_PER_EXERCISE,
  validateExercise,
  type DisasterSpecification,
  type Scenario
} from '@rescuemesh/shared';
import { DISASTER_PRESENTATION, DisasterIcon } from './disaster-ui';

export const defaultExercise = (): DisasterSpecification[] => [
  { kind: 'flash_flood', zoneId: 'zone-oakland', severity: 'high' }
];

export const defaultSecondDisaster = (): DisasterSpecification => ({
  kind: 'structural_fire',
  zoneId: 'zone-downtown',
  severity: 'high'
});

export interface BuilderErrors {
  form?: string;
  fields: Record<number, { kind?: string; zoneId?: string; severity?: string }>;
}

export function validateExerciseBuilder(
  disasters: DisasterSpecification[],
  scenario: Scenario
): BuilderErrors {
  const result = validateExercise(disasters, scenario);
  if (result.ok) return { fields: {} };
  const index = result.rejection.index;
  if (index === undefined) return { form: result.rejection.message, fields: {} };
  const field =
    result.rejection.code === 'unknown_kind'
      ? 'kind'
      : result.rejection.code === 'invalid_severity'
        ? 'severity'
        : 'zoneId';
  const message =
    result.rejection.code === 'duplicate_disaster'
      ? 'Choose a different disaster type or zone.'
      : result.rejection.message;
  return { fields: { [index]: { [field]: message } } };
}

export function addSecondDisaster(disasters: DisasterSpecification[]): DisasterSpecification[] {
  return disasters.length >= MAX_DISASTERS_PER_EXERCISE
    ? disasters
    : [...disasters, defaultSecondDisaster()];
}

export function removeSecondDisaster(disasters: DisasterSpecification[]): DisasterSpecification[] {
  return disasters.slice(0, 1);
}

export function ExerciseBuilder({
  scenario,
  disasters,
  disabled,
  starting,
  onChange,
  onSubmit
}: {
  scenario: Scenario;
  disasters: DisasterSpecification[];
  disabled: boolean;
  starting: boolean;
  onChange: (disasters: DisasterSpecification[]) => void;
  onSubmit: () => void;
}) {
  const errors = validateExerciseBuilder(disasters, scenario);
  const invalid = !!errors.form || Object.keys(errors.fields).length > 0;
  const update = (index: number, change: Partial<DisasterSpecification>) =>
    onChange(
      disasters.map((item, itemIndex) => (itemIndex === index ? { ...item, ...change } : item))
    );

  return (
    <form
      className="exercise-builder"
      aria-label="Synthetic exercise builder"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !invalid) onSubmit();
      }}
    >
      <div className="exercise-builder-fields">
        {disasters.map((disaster, index) => {
          const item = DISASTER_PRESENTATION[disaster.kind];
          const fieldErrors = errors.fields[index] ?? {};
          return (
            <fieldset className={`disaster-fields ${item.tone}`} disabled={disabled} key={index}>
              <legend>
                <DisasterIcon kind={disaster.kind} /> Disaster {index + 1}
              </legend>
              <label>
                <span>Disaster type</span>
                <select
                  aria-label={`Disaster ${index + 1} type`}
                  aria-invalid={!!fieldErrors.kind}
                  value={disaster.kind}
                  onChange={(event) =>
                    update(index, { kind: event.target.value as DisasterSpecification['kind'] })
                  }
                >
                  {DISASTER_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {DISASTER_PRESENTATION[kind].label}
                    </option>
                  ))}
                </select>
                {fieldErrors.kind && <small className="field-error">{fieldErrors.kind}</small>}
              </label>
              <label>
                <span>Zone</span>
                <select
                  aria-label={`Disaster ${index + 1} zone`}
                  aria-describedby={fieldErrors.zoneId ? `disaster-${index}-zone-error` : undefined}
                  aria-invalid={!!fieldErrors.zoneId}
                  value={disaster.zoneId}
                  onChange={(event) => update(index, { zoneId: event.target.value })}
                >
                  {scenario.zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
                {fieldErrors.zoneId && (
                  <small className="field-error" id={`disaster-${index}-zone-error`}>
                    {fieldErrors.zoneId}
                  </small>
                )}
              </label>
              <label>
                <span>Severity</span>
                <select
                  aria-label={`Disaster ${index + 1} severity`}
                  aria-invalid={!!fieldErrors.severity}
                  value={disaster.severity}
                  onChange={(event) =>
                    update(index, {
                      severity: event.target.value as DisasterSpecification['severity']
                    })
                  }
                >
                  {DISASTER_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {severity[0]!.toUpperCase() + severity.slice(1)}
                    </option>
                  ))}
                </select>
                {fieldErrors.severity && (
                  <small className="field-error">{fieldErrors.severity}</small>
                )}
              </label>
              {index === 1 && (
                <button
                  className="remove-disaster"
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(removeSecondDisaster(disasters))}
                >
                  Remove Disaster 2
                </button>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="exercise-builder-actions">
        {disasters.length < MAX_DISASTERS_PER_EXERCISE && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(addSecondDisaster(disasters))}
          >
            Add second disaster
          </button>
        )}
        {errors.form && <small className="field-error">{errors.form}</small>}
        <button className="primary" type="submit" disabled={disabled || invalid}>
          {starting ? 'Starting…' : 'Simulate'}
        </button>
      </div>
    </form>
  );
}
