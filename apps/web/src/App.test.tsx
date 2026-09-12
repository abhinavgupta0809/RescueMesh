import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

/**
 * Server-render smoke test: catches runtime errors in the panel tree and keeps
 * the exercise-only labelling and the intake console from being dropped.
 */
describe('App', () => {
  const markup = renderToStaticMarkup(<App />);

  it('renders the five chief recommendations from the seed scenario', () => {
    for (const name of [
      'Incident Commander',
      'Medical Chief',
      'Police Chief',
      'Rescue Chief',
      'Logistics Chief'
    ]) {
      expect(markup).toContain(name);
    }
  });

  it('renders the field-report intake console and its review warning', () => {
    expect(markup).toContain('Field report → structured incident');
    expect(markup).toContain('Human review required');
    expect(markup).toContain('Parse report');
    expect(markup).toContain('Ask the chiefs');
  });

  it('keeps the exercise-only footer', () => {
    expect(markup).toContain('EXERCISE ONLY');
  });

  it('labels seeded recommendations as seeded until a provider answers', () => {
    expect(markup).toContain('seeded');
  });
});
