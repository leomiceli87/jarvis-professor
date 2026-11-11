const CANADA = /\b(canada|canadian|ontario|toronto|vancouver|british columbia|alberta|calgary|edmonton|montr[eé]al|qu[eé]bec|ottawa|waterloo|winnipeg|halifax)\b/i;
const BROAD = /\b(north america|americas|amer|anywhere|worldwide|global)\b/i;
const REMOTE_TEXT = /\b(fully remote|100% remote|remote[- ]first|work from anywhere|remote position|remote role)\b/i;
const SENIOR = /\b(senior|sr\.?|staff|lead|principal)\b/i;
const ENGINEERING = /\b(software|engineer|developer|backend|back-end|full[- ]?stack|sde|swe|programmer)\b/i;
const NOT_ENGINEERING = /\b(manager|director|recruit|sales|account|marketing|designer|support|success|solutions|counsel|analyst|intern|co-op|vp|head of|security engineer|data scientist|hardware|mechanical|electrical|field|customer|partner|finance|product manager|technical writer|program manager)\b/i;
const DOTNET = /(\bC#|\.NET\b|\bASP\.NET|\bdotnet\b)/i;

export function isEngineeringTitle(title: string): boolean {
  return ENGINEERING.test(title) && !NOT_ENGINEERING.test(title);
}

export function isSenior(title: string): boolean {
  return SENIOR.test(title);
}

export function mentionsDotnet(title: string, text: string): boolean {
  return DOTNET.test(title) || DOTNET.test(text);
}

/** true: a vaga cita o Canadá no local. null: local amplo, a confirmar. false: outro país. */
export function canadaEligible(location: string, text: string): boolean | null {
  if (CANADA.test(location)) return true;
  if (BROAD.test(location) || /^\s*remote\s*$/i.test(location) || location.trim() === '') {
    return /\bCanada\b/.test(text) ? true : null;
  }
  return false;
}

export function isRemote(location: string, hint: boolean | null, text: string): boolean | null {
  if (hint !== null) return hint;
  if (/\bremote\b/i.test(location)) return true;
  if (/\b(hybrid|on-?site|in[- ]office)\b/i.test(location)) return false;
  return REMOTE_TEXT.test(text) ? true : null;
}
