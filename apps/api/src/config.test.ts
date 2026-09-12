import { describe, expect, it } from 'vitest';
import { IFM_DEFAULTS, parseEnvFile, readIfmConfig } from './config.js';

describe('parseEnvFile', () => {
  it('reads plain, quoted, exported, and commented lines', () => {
    const parsed = parseEnvFile(
      [
        '# leading comment',
        'IFM_API_KEY=IFM-abc123',
        'export IFM_MODEL="IFM/K2-Horizon-375B-A23B"',
        "IFM_BASE_URL='https://api.ifm.ai/v1'",
        'IFM_TIMEOUT_MS=15000 # inline comment',
        'EMPTY=',
        'not a pair'
      ].join('\n')
    );
    expect(parsed).toEqual({
      IFM_API_KEY: 'IFM-abc123',
      IFM_MODEL: 'IFM/K2-Horizon-375B-A23B',
      IFM_BASE_URL: 'https://api.ifm.ai/v1',
      IFM_TIMEOUT_MS: '15000',
      EMPTY: ''
    });
  });
});

describe('readIfmConfig', () => {
  it('returns null when no key is pasted yet', () => {
    expect(readIfmConfig({})).toBeNull();
    expect(readIfmConfig({ IFM_API_KEY: '   ' })).toBeNull();
    expect(readIfmConfig({ IFM_API_KEY: 'IFM-xf...' })).toBeNull();
  });

  it('applies quickstart defaults when only the key is set', () => {
    expect(readIfmConfig({ IFM_API_KEY: 'IFM-abc' })).toEqual({
      apiKey: 'IFM-abc',
      baseUrl: IFM_DEFAULTS.baseUrl,
      model: IFM_DEFAULTS.model,
      timeoutMs: IFM_DEFAULTS.timeoutMs,
      maxTokens: IFM_DEFAULTS.maxTokens,
      temperature: IFM_DEFAULTS.temperature
    });
  });

  it('trims a trailing slash off the base url', () => {
    expect(
      readIfmConfig({ IFM_API_KEY: 'k', IFM_BASE_URL: 'https://api.ifm.ai/v1/' })?.baseUrl
    ).toBe('https://api.ifm.ai/v1');
  });

  it('ignores unusable numeric overrides and clamps extreme ones', () => {
    const config = readIfmConfig({
      IFM_API_KEY: 'k',
      IFM_TIMEOUT_MS: 'soon',
      IFM_TEMPERATURE: '99',
      IFM_MAX_TOKENS: '1'
    });
    expect(config?.timeoutMs).toBe(IFM_DEFAULTS.timeoutMs);
    expect(config?.temperature).toBe(2);
    expect(config?.maxTokens).toBe(64);
  });
});
