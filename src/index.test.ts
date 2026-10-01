import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, contract, postHogBatch, satisfies, validateBatch } from './index';

const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return { install_id: INSTALL, deployment: 'prod', events, ...overrides };
}

const hourly = (properties: Record<string, unknown>) =>
  validateBatch(batch([{ event: 'hourly summary', timestamp: at(), properties }]), NOW)?.events[0].properties;

describe('validateBatch', () => {
  it('keeps allowed properties and drops everything else', () => {
    expect(hourly({
      succeeded_bucket: '6-20',
      failed_bucket: '1',
      median_duration_bucket: '10-30s',
      top_error_class: 'OutOfMemoryError',
      node_version: '3.3.6',
      measurement_version: 1,
      prompt: 'a red fox in fresh snow',      // not in the contract
      server_url: 'http://192.168.1.76:8188', // not in the contract
    })).toEqual({
      succeeded_bucket: '6-20',
      failed_bucket: '1',
      median_duration_bucket: '10-30s',
      top_error_class: 'OutOfMemoryError',
      node_version: '3.3.6',
      measurement_version: 1,
    });
  });

  it('drops a property whose value breaks its rule, not just an unknown key', () => {
    expect(hourly({
      succeeded_bucket: '12',                         // an exact count, not a range
      top_error_class: 'ValueError: bad prompt text', // a message, not a type name
      median_duration_bucket: '12s',                  // not a range
      node_version: 'latest',                         // not a version
    })).toEqual({});
  });

  it('drops unknown events and stale or future timestamps, and counts them', () => {
    const result = validateBatch(batch([
      { event: 'node started', timestamp: at(), properties: { platform: 'linux' } },
      { event: 'prompt text captured', timestamp: at(), properties: {} },
      { event: 'prompt finished', timestamp: at(), properties: {} }, // per-run events are gone
      { event: 'node started', timestamp: at(-8 * 24 * 3600 * 1000), properties: {} },
      { event: 'node started', timestamp: at(60 * 60 * 1000), properties: {} },
      { event: 'toString', timestamp: at(), properties: {} },
    ]), NOW);
    expect(result?.events.map((e) => e.event)).toEqual(['node started']);
    expect(result?.dropped).toBe(5);
  });

  it('rejects a bad envelope outright', () => {
    const one = [{ event: 'node started', timestamp: at(), properties: {} }];
    expect(validateBatch(batch(one, { install_id: 'my-hostname' }), NOW)).toBeNull();
    expect(validateBatch(batch(one, { deployment: 'staging' }), NOW)).toBeNull();
    expect(validateBatch(batch([]), NOW)).toBeNull();
    expect(validateBatch(batch(Array(MAX_EVENTS + 1).fill(one[0])), NOW)).toBeNull();
    expect(validateBatch('not an object', NOW)).toBeNull();
  });
});

describe('top_model_family', () => {
  it('passes an architecture and refuses a filename, hash or AIR', () => {
    const family = (top_model_family: string) => hourly({ top_model_family })?.top_model_family;
    expect(family('sdxl')).toBe('sdxl');
    expect(family('some_model.safetensors')).toBeUndefined();
    expect(family('6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa')).toBeUndefined();
    expect(family('urn:air:sdxl:checkpoint:civitai:101055@128078')).toBeUndefined();
  });
});

describe('postHogBatch', () => {
  it('tags node events and keeps PostHog from building people or places', () => {
    const valid = validateBatch(batch([
      { event: 'node started', timestamp: at(), properties: { platform: 'linux' } },
    ], { deployment: 'review' }), NOW)!;
    const body = postHogBatch(valid, 'phc_test');
    expect(body.api_key).toBe('phc_test');
    expect(body.batch[0]).toMatchObject({
      event: 'node started',
      distinct_id: INSTALL,
      properties: {
        platform: 'linux',
        product: 'node',
        component: 'server',
        deployment: 'review',
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
  });
});

describe('contract.json', () => {
  it('compiles every pattern, and every bucket rule names a real bucket', () => {
    for (const source of Object.values(contract.patterns)) expect(() => new RegExp(source)).not.toThrow();
    for (const rules of [contract.common, ...Object.values(contract.events)]) {
      for (const rule of Object.values(rules)) {
        if (rule.type === 'bucket') expect(contract.buckets[rule.bucket]).toBeDefined();
      }
    }
  });

  it('sends counts only as ranges: no event carries a raw number but the schema version', () => {
    for (const [event, rules] of Object.entries(contract.events)) {
      for (const [field, rule] of Object.entries(rules)) {
        expect(rule.type, `${event}.${field}`).not.toBe('int');
      }
    }
  });

  it('rejects anything that is not exactly the declared type', () => {
    expect(satisfies({ type: 'bool' }, 'true')).toBe(false);
    expect(satisfies({ type: 'int', min: 400, max: 599 }, 500.5)).toBe(false);
    expect(satisfies({ type: 'enum', values: ['a'] }, ['a'])).toBe(false);
    expect(satisfies({ type: 'version' }, '3.3.5 ; rm -rf /')).toBe(false);
  });
});
