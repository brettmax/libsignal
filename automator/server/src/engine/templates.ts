export interface TemplateVars {
  body: string;
  sender: string;
  senderName?: string;
  /** The text that matched the rule. */
  match: string;
  /** Regex capture groups; index 1..9 map to {{1}}..{{9}}. */
  groups?: readonly (string | undefined)[];
  /** ms epoch used for {{time}} / {{date}}. */
  now: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local time HH:MM. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date YYYY-MM-DD. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Renders {{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}} and
 * {{1}}..{{9}}. Unknown placeholders are left untouched.
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{\s*([A-Za-z0-9]+)\s*\}\}/g, (whole, key: string) => {
    switch (key) {
      case 'body':
        return vars.body;
      case 'sender':
        return vars.sender;
      case 'senderName':
        return vars.senderName || vars.sender;
      case 'match':
        return vars.match;
      case 'time':
        return formatTime(vars.now);
      case 'date':
        return formatDate(vars.now);
      default:
        if (/^[1-9]$/.test(key)) return vars.groups?.[Number(key)] ?? '';
        return whole;
    }
  });
}
