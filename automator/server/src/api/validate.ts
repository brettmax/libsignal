import type {
  KeywordRuleInput,
  MatchType,
  Recipient,
  RepeaterInput,
  RuleAction,
} from '@automator/shared';
import { ValidationError } from '../contracts.js';

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function requireObject(v: unknown, what = 'request body'): Json {
  if (!isObj(v)) throw new ValidationError(`${what} must be a JSON object`);
  return v;
}

export function requireString(o: Json, key: string, opts: { nonEmpty?: boolean } = {}): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ValidationError(`"${key}" must be a string`);
  if (opts.nonEmpty && v.trim() === '') throw new ValidationError(`"${key}" must not be empty`);
  return v;
}

function optString(o: Json, key: string): string | undefined {
  if (o[key] === undefined) return undefined;
  return requireString(o, key);
}

function optBool(o: Json, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`"${key}" must be a boolean`);
  return v;
}

function optNumber(o: Json, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`"${key}" must be a number`);
  return v;
}

function optStringArray(o: Json, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new ValidationError(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

export function parseRecipient(v: unknown, what = 'recipient'): Recipient {
  if (!isObj(v)) throw new ValidationError(`${what} must be an object {kind, id}`);
  if (v.kind !== 'contact' && v.kind !== 'group') {
    throw new ValidationError(`${what}.kind must be "contact" or "group"`);
  }
  if (typeof v.id !== 'string' || v.id.trim() === '') throw new ValidationError(`${what}.id must be a non-empty string`);
  return { kind: v.kind, id: v.id };
}

const MATCH_TYPES: MatchType[] = ['contains', 'exact', 'startsWith', 'regex', 'word'];
const SCOPES = ['all', 'direct', 'groups'] as const;

function parseAction(v: unknown): RuleAction {
  if (!isObj(v)) throw new ValidationError('"action" must be an object');
  switch (v.type) {
    case 'reply':
      return { type: 'reply', text: requireString(v, 'text') };
    case 'send':
      return { type: 'send', to: parseRecipient(v.to, 'action.to'), text: requireString(v, 'text') };
    case 'script':
      return { type: 'script', command: requireString(v, 'command', { nonEmpty: true }) };
    default:
      throw new ValidationError('"action.type" must be "reply", "send" or "script"');
  }
}

/** Type-checks the RepeaterInput keys that are present; unknown keys are dropped. */
export function parseRepeaterPatch(body: unknown): Partial<RepeaterInput> {
  const o = requireObject(body);
  const out: Partial<RepeaterInput> = {};
  const name = optString(o, 'name');
  if (name !== undefined) out.name = name;
  const enabled = optBool(o, 'enabled');
  if (enabled !== undefined) out.enabled = enabled;
  if (o.recipients !== undefined) {
    if (!Array.isArray(o.recipients)) throw new ValidationError('"recipients" must be an array');
    out.recipients = o.recipients.map((r, i) => parseRecipient(r, `recipients[${i}]`));
  }
  const messages = optStringArray(o, 'messages');
  if (messages !== undefined) out.messages = messages;
  const interval = optNumber(o, 'intervalSeconds');
  if (interval !== undefined) out.intervalSeconds = interval;
  const jitter = optNumber(o, 'jitterSeconds');
  if (jitter !== undefined) out.jitterSeconds = jitter;
  if (o.maxRuns !== undefined) out.maxRuns = o.maxRuns === null ? null : optNumber(o, 'maxRuns')!;
  return out;
}

/** Requires name, recipients, messages and intervalSeconds; fills defaults for the rest. */
export function parseRepeaterInput(body: unknown): RepeaterInput {
  const p = parseRepeaterPatch(body);
  for (const k of ['name', 'recipients', 'messages', 'intervalSeconds'] as const) {
    if (p[k] === undefined) throw new ValidationError(`"${k}" is required`);
  }
  return {
    name: p.name!,
    enabled: p.enabled ?? true,
    recipients: p.recipients!,
    messages: p.messages!,
    intervalSeconds: p.intervalSeconds!,
    jitterSeconds: p.jitterSeconds ?? 0,
    maxRuns: p.maxRuns === undefined ? null : p.maxRuns,
  };
}

export function parseRulePatch(body: unknown): Partial<KeywordRuleInput> {
  const o = requireObject(body);
  const out: Partial<KeywordRuleInput> = {};
  const name = optString(o, 'name');
  if (name !== undefined) out.name = name;
  const enabled = optBool(o, 'enabled');
  if (enabled !== undefined) out.enabled = enabled;
  const pattern = optString(o, 'pattern');
  if (pattern !== undefined) out.pattern = pattern;
  if (o.matchType !== undefined) {
    if (!MATCH_TYPES.includes(o.matchType as MatchType)) {
      throw new ValidationError(`"matchType" must be one of ${MATCH_TYPES.join(', ')}`);
    }
    out.matchType = o.matchType as MatchType;
  }
  const cs = optBool(o, 'caseSensitive');
  if (cs !== undefined) out.caseSensitive = cs;
  if (o.scope !== undefined) {
    if (!SCOPES.includes(o.scope as (typeof SCOPES)[number])) {
      throw new ValidationError(`"scope" must be one of ${SCOPES.join(', ')}`);
    }
    out.scope = o.scope as KeywordRuleInput['scope'];
  }
  const from = optStringArray(o, 'fromFilter');
  if (from !== undefined) out.fromFilter = from;
  if (o.action !== undefined) out.action = parseAction(o.action);
  const cd = optNumber(o, 'cooldownSeconds');
  if (cd !== undefined) out.cooldownSeconds = cd;
  const sp = optBool(o, 'stopProcessing');
  if (sp !== undefined) out.stopProcessing = sp;
  return out;
}

/** Requires pattern and action; fills defaults for the rest. */
export function parseRuleInput(body: unknown): KeywordRuleInput {
  const p = parseRulePatch(body);
  if (p.pattern === undefined) throw new ValidationError('"pattern" is required');
  if (p.action === undefined) throw new ValidationError('"action" is required');
  return {
    name: p.name ?? p.pattern,
    enabled: p.enabled ?? true,
    pattern: p.pattern,
    matchType: p.matchType ?? 'contains',
    caseSensitive: p.caseSensitive ?? false,
    scope: p.scope ?? 'all',
    fromFilter: p.fromFilter ?? [],
    action: p.action,
    cooldownSeconds: p.cooldownSeconds ?? 0,
    stopProcessing: p.stopProcessing ?? false,
  };
}

const SCRIPT_NAME = /^[A-Za-z0-9._-]+\.(js|mjs)$/;

export function parseScriptName(name: string): string {
  if (!SCRIPT_NAME.test(name) || name.includes('..')) {
    throw new ValidationError('script name must match [A-Za-z0-9._-]+.js or .mjs and must not contain ".."');
  }
  return name;
}

export function parseLimit(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < 1) {
    throw new ValidationError('"limit" must be a positive integer');
  }
  return Number(v);
}

export { optBool, optString, optStringArray };
