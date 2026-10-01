// What the CueForge relay does with a telemetry batch from comfyui-mobile-frontend.
//
// This is the whole of it. The relay's /telemetry/batch handler calls
// validateBatch(), then forwardToPostHog(), and nothing else: no storage, no
// logging of the body. Everything a batch may contain is in ../contract.json;
// anything not listed there is dropped here, never passed through.

import contractJson from '../contract.json';

type Rule =
  | { type: 'enum'; values: string[] }
  | { type: 'bucket'; bucket: string }
  | { type: 'version'; also?: string[] }
  | { type: 'type_name' }
  | { type: 'route' }
  | { type: 'bool' }
  | { type: 'int'; min: number; max: number };

interface Contract {
  version: number;
  deployments: string[];
  limits: { max_events: number; max_body_bytes: number; max_age_seconds: number; max_skew_seconds: number };
  patterns: Record<'install_id' | 'version' | 'type_name' | 'route', string>;
  buckets: Record<string, string[]>;
  common: Record<string, Rule>;
  events: Record<string, Record<string, Rule>>;
}

export const contract = contractJson as unknown as Contract;
export const MAX_EVENTS = contract.limits.max_events;
export const MAX_BODY_BYTES = contract.limits.max_body_bytes;

const PATTERNS = Object.fromEntries(
  Object.entries(contract.patterns).map(([name, source]) => [name, new RegExp(source)]),
) as Record<keyof Contract['patterns'], RegExp>;

/** Whether `value` satisfies `rule`. Exported for tests. */
export function satisfies(rule: Rule, value: unknown): boolean {
  switch (rule.type) {
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value);
    case 'bucket':
      return typeof value === 'string' && (contract.buckets[rule.bucket] ?? []).includes(value);
    case 'version':
      return typeof value === 'string'
        && ((rule.also ?? []).includes(value) || PATTERNS.version.test(value));
    case 'type_name':
      return typeof value === 'string' && PATTERNS.type_name.test(value);
    case 'route':
      return typeof value === 'string' && PATTERNS.route.test(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max;
    default:
      return false;
  }
}

export interface ValidEvent {
  event: string;
  timestamp: string;
  properties: Record<string, string | number | boolean>;
}

export interface ValidBatch {
  installId: string;
  deployment: string;
  events: ValidEvent[];
  dropped: number;
}

/** A batch reduced to what the contract allows, or null if its envelope is bad. */
export function validateBatch(body: unknown, now: number = Date.now()): ValidBatch | null {
  if (!body || typeof body !== 'object') return null;
  const { install_id: installId, deployment, events } = body as Record<string, unknown>;
  if (typeof installId !== 'string' || !PATTERNS.install_id.test(installId)) return null;
  if (typeof deployment !== 'string' || !contract.deployments.includes(deployment)) return null;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return null;

  const valid: ValidEvent[] = [];
  let dropped = 0;
  for (const raw of events) {
    const event = validateEvent(raw, now);
    if (event) valid.push(event);
    else dropped += 1;
  }
  return { installId, deployment, events: valid, dropped };
}

function validateEvent(raw: unknown, now: number): ValidEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const { event, timestamp, properties } = raw as Record<string, unknown>;
  if (typeof event !== 'string' || !Object.hasOwn(contract.events, event)) return null;
  if (typeof timestamp !== 'string') return null;
  const at = Date.parse(timestamp);
  const { max_age_seconds: maxAge, max_skew_seconds: maxSkew } = contract.limits;
  if (Number.isNaN(at) || at > now + maxSkew * 1000 || at < now - maxAge * 1000) return null;

  const rules: Record<string, Rule> = { ...contract.common, ...contract.events[event] };
  const kept: Record<string, string | number | boolean> = {};
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
      if (rule && satisfies(rule, value)) kept[key] = value as string | number | boolean;
    }
  }
  return { event, timestamp: new Date(at).toISOString(), properties: kept };
}

/** The PostHog `/batch/` body for a validated batch. */
export function postHogBatch(batch: ValidBatch, apiKey: string) {
  return {
    api_key: apiKey,
    batch: batch.events.map((event) => ({
      event: event.event,
      distinct_id: batch.installId,
      timestamp: event.timestamp,
      properties: {
        ...event.properties,
        product: 'node',
        component: 'server',
        deployment: batch.deployment,
        // No location from the request, and no person profile for the install.
        $geoip_disable: true,
        $process_person_profile: false,
      },
    })),
  };
}

export interface PostHogTarget {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}

/** Forward a validated batch. Never throws; a failure is a dropped batch. */
export async function forwardToPostHog(batch: ValidBatch, target: PostHogTarget): Promise<boolean> {
  const apiKey = target.POSTHOG_PROJECT_TOKEN;
  if (!apiKey || batch.events.length === 0) return false;
  const host = (target.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  try {
    const response = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postHogBatch(batch, apiKey)),
    });
    return response.ok;
  } catch {
    return false;
  }
}
