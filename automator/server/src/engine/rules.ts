import type { KeywordRule, KeywordRuleInput, MatchType, Recipient, RuleAction } from '@automator/shared';
import { ValidationError } from '../contracts.js';
import { renderTemplate } from './templates.js';

const MATCH_TYPES: readonly MatchType[] = ['contains', 'exact', 'startsWith', 'regex', 'word'];
const SCOPES: readonly KeywordRule['scope'][] = ['all', 'direct', 'groups'];

export function escapeRegex(s: string): string {
  // Only SyntaxCharacters, so the result is also valid under the 'u' flag.
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validRecipient(r: unknown): r is Recipient {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (o.kind === 'contact' || o.kind === 'group') && typeof o.id === 'string' && o.id.trim() !== '';
}

export function validateAction(a: unknown): asserts a is RuleAction {
  if (!a || typeof a !== 'object') throw new ValidationError('action is required');
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case 'reply':
      if (typeof o.text !== 'string' || o.text.trim() === '') throw new ValidationError('reply action needs text');
      return;
    case 'send':
      if (typeof o.text !== 'string' || o.text.trim() === '') throw new ValidationError('send action needs text');
      if (!validRecipient(o.to)) throw new ValidationError('send action needs a valid recipient');
      return;
    case 'script':
      if (typeof o.command !== 'string' || o.command.trim() === '') throw new ValidationError('script action needs a command name');
      return;
    default:
      throw new ValidationError(`unknown action type: ${String(o.type)}`);
  }
}

/** Validates a complete rule input (after merging any patch). */
export function validateRuleInput(r: KeywordRuleInput): void {
  if (typeof r.name !== 'string' || r.name.trim() === '') throw new ValidationError('name is required');
  if (typeof r.pattern !== 'string' || r.pattern === '') throw new ValidationError('pattern is required');
  if (!MATCH_TYPES.includes(r.matchType)) throw new ValidationError(`invalid matchType: ${String(r.matchType)}`);
  if (!SCOPES.includes(r.scope)) throw new ValidationError(`invalid scope: ${String(r.scope)}`);
  if (typeof r.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
  if (typeof r.caseSensitive !== 'boolean') throw new ValidationError('caseSensitive must be a boolean');
  if (typeof r.stopProcessing !== 'boolean') throw new ValidationError('stopProcessing must be a boolean');
  if (!Array.isArray(r.fromFilter) || r.fromFilter.some((s) => typeof s !== 'string'))
    throw new ValidationError('fromFilter must be a list of sender ids');
  if (typeof r.cooldownSeconds !== 'number' || !Number.isFinite(r.cooldownSeconds) || r.cooldownSeconds < 0)
    throw new ValidationError('cooldownSeconds must be >= 0');
  if (r.matchType === 'regex') {
    try {
      new RegExp(r.pattern);
    } catch (err) {
      throw new ValidationError(`invalid regex: ${(err as Error).message}`);
    }
  }
  validateAction(r.action);
}

export function normalizeRuleInput(r: KeywordRuleInput): KeywordRuleInput {
  return {
    name: r.name.trim(),
    enabled: r.enabled,
    pattern: r.pattern,
    matchType: r.matchType,
    caseSensitive: r.caseSensitive,
    scope: r.scope,
    fromFilter: r.fromFilter.map((s) => s.trim()).filter(Boolean),
    action: structuredClone(r.action),
    cooldownSeconds: r.cooldownSeconds,
    stopProcessing: r.stopProcessing,
  };
}

export interface RuleMatch {
  /** The matched text ({{match}}). */
  text: string;
  /** Full regex match array (unmatched groups as '') for regex rules; [body] otherwise. Passed to bot.command handlers. */
  groups: string[];
}

/** Returns the match for `body`, or null. Does not check scope / sender. */
export function matchBody(rule: Pick<KeywordRule, 'pattern' | 'matchType' | 'caseSensitive'>, body: string): RuleMatch | null {
  const cs = rule.caseSensitive;
  const fold = (s: string): string => (cs ? s : s.toLowerCase());
  const pattern = rule.pattern;
  switch (rule.matchType) {
    case 'contains': {
      const idx = fold(body).indexOf(fold(pattern));
      if (idx < 0) return null;
      return { text: body.slice(idx, idx + pattern.length), groups: [body] };
    }
    case 'exact': {
      const b = body.trim();
      if (fold(b) !== fold(pattern.trim())) return null;
      return { text: b, groups: [body] };
    }
    case 'startsWith': {
      const b = body.trimStart();
      if (!fold(b).startsWith(fold(pattern))) return null;
      return { text: b.slice(0, pattern.length), groups: [body] };
    }
    case 'word':
    case 'regex': {
      let re: RegExp;
      try {
        // Whole-word: \b-style boundaries expressed as lookarounds so patterns that
        // start or end with punctuation (e.g. "c++", "?help") still work.
        const src = rule.matchType === 'word' ? `(?<![\\p{L}\\p{N}_])${escapeRegex(pattern)}(?![\\p{L}\\p{N}_])` : pattern;
        const flags = (cs ? '' : 'i') + (rule.matchType === 'word' ? 'u' : '');
        re = new RegExp(src, flags);
      } catch {
        return null;
      }
      const m = re.exec(body);
      if (!m) return null;
      // 'word' is a regex internally only; like the other non-regex types it passes [body].
      return { text: m[0], groups: rule.matchType === 'regex' ? Array.from(m, (g) => g ?? '') : [body] };
    }
    default:
      return null;
  }
}

export interface RuleInputMessage {
  body: string;
  sender: string;
  senderName?: string;
  isGroup: boolean;
}

/** Scope + sender filter + body match. Ignores enabled/cooldown. */
export function ruleApplies(rule: KeywordRule, msg: RuleInputMessage): RuleMatch | null {
  if (rule.scope === 'direct' && msg.isGroup) return null;
  if (rule.scope === 'groups' && !msg.isGroup) return null;
  if (rule.fromFilter.length > 0 && !rule.fromFilter.includes(msg.sender)) return null;
  return matchBody(rule, msg.body);
}

/** Renders the text of a reply/send action; null for script actions. */
export function renderAction(rule: KeywordRule, msg: RuleInputMessage, match: RuleMatch, now: number): string | null {
  const a = rule.action;
  if (a.type === 'script') return null;
  return renderTemplate(a.text, {
    body: msg.body,
    sender: msg.sender,
    senderName: msg.senderName,
    match: match.text,
    groups: match.groups,
    now,
  });
}
