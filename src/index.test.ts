import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, contract, postHogBatch, satisfies, validateBatch } from './index';

const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return { install_id: INSTALL, deployment: 'prod', events, ...overrides };
}

describe('validateBatch', () => {
  it('keeps allowed properties and drops everything else', () => {
    const result = validateBatch(batch([{
      event: 'prompt finished',
      timestamp: at(),
      properties: {
        status: 'error',
        duration_bucket: '10-30s',
        error_class: 'OutOfMemoryError',
        node_version: '3.3.5',
        measurement_version: 1,
        prompt: 'a red fox in fresh snow',       // not in the contract
        server_url: 'http://192.168.1.76:8188',     // not in the contract
        status_detail: 'CUDA out of memory',        // not in the contract
      },
    }]), NOW);
    expect(result?.events[0].properties).toEqual({
      status: 'error',
      duration_bucket: '10-30s',
      error_class: 'OutOfMemoryError',
      node_version: '3.3.5',
      measurement_version: 1,
    });
  });

  it('drops a property whose value breaks its rule, not just an unknown key', () => {
    const result = validateBatch(batch([{
      event: 'prompt finished',
      timestamp: at(),
      properties: {
        status: 'finished',                        // not one of the enum values
        error_class: 'ValueError: bad prompt text', // a message, not a type name
        duration_bucket: '12s',                    // not a bucket
        node_version: 'latest',                    // not a version
      },
    }]), NOW);
    expect(result?.events[0].properties).toEqual({});
  });

  it('refuses a route that is a concrete path rather than a template', () => {
    const good = validateBatch(batch([{
      event: 'request failed', timestamp: at(),
      properties: { route: '/mobile/api/files/{source}', status: 500 },
    }]), NOW);
    const bad = validateBatch(batch([{
      event: 'request failed', timestamp: at(),
      properties: { route: '/mobile/api/files/output?name=me.png', status: 500 },
    }]), NOW);
    expect(good?.events[0].properties.route).toBe('/mobile/api/files/{source}');
    expect(bad?.events[0].properties.route).toBeUndefined();
  });

  it('drops unknown events and stale or future timestamps, and counts them', () => {
    const result = validateBatch(batch([
      { event: 'node started', timestamp: at(), properties: { platform: 'linux' } },
      { event: 'prompt text captured', timestamp: at(), properties: {} },
      { event: 'node started', timestamp: at(-8 * 24 * 3600 * 1000), properties: {} },
      { event: 'node started', timestamp: at(60 * 60 * 1000), properties: {} },
      { event: 'toString', timestamp: at(), properties: {} },
    ]), NOW);
    expect(result?.events.map((e) => e.event)).toEqual(['node started']);
    expect(result?.dropped).toBe(4);
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

describe('model_family', () => {
  it('passes an architecture and refuses a filename, hash or AIR', () => {
    const props = (model_family: string) => validateBatch(batch([{
      event: 'prompt finished', timestamp: at(), properties: { status: 'success', model_family },
    }]), NOW)?.events[0].properties.model_family;
    expect(props('sdxl')).toBe('sdxl');
    expect(props('some_model.safetensors')).toBeUndefined();
    expect(props('6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa')).toBeUndefined();
    expect(props('urn:air:sdxl:checkpoint:civitai:101055@128078')).toBeUndefined();
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

  it('rejects anything that is not exactly the declared type', () => {
    expect(satisfies({ type: 'bool' }, 'true')).toBe(false);
    expect(satisfies({ type: 'int', min: 400, max: 599 }, 500.5)).toBe(false);
    expect(satisfies({ type: 'enum', values: ['a'] }, ['a'])).toBe(false);
    expect(satisfies({ type: 'version' }, '3.3.5 ; rm -rf /')).toBe(false);
  });
});
