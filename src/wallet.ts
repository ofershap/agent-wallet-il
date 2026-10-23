/**
 * agent-wallet-il — ליבת הארנק (Wallet core)
 *
 * ארנק תשלום מבוקר לסוכני AI. שכבת בקרה בלבד: קובעת מותר/אסור לפני שכסף אמיתי זז.
 * הגרסה הזו לא מחוברת למסילת תשלום אמיתית — אישורי התשלום (credentials) הם
 * אסימוני הדמיה חד־פעמיים. חיבור לכסף אמיתי דורש מנפיק/סולק עם API מתאים
 * (ראו README, סעיף "הדרך לכסף אמיתי").
 *
 * שני מצבי עבודה — הבחירה נשארת של בעל הארנק:
 *  - approve-each: כל רכישה דורשת אישור אישי (כמו Allowance).
 *  - autonomous: הסוכן קונה בעצמו בתוך תקציב נטען + חוקים (הכיוון של עופר מ־15.10).
 *
 * מודל בטיחות:
 *  - אישור = רזרבציה. ברגע שמונפק אישור תשלום, הסכום נעול (hold) ומקוזז מהיתרה
 *    הזמינה ומתקרות היום/חודש — אי אפשר לאשר פעמיים את אותו הכסף.
 *  - אישור שפג תוקפו משחרר את הרזרבציה אוטומטית.
 */

import type { IssuerAdapter, IssuedCredential } from './issuer.ts';
import { SimulatedIssuerAdapter } from './issuer.ts';

export type ApprovalMode = 'approve-each' | 'autonomous';
export type { IssuedCredential } from './issuer.ts';

export interface WalletRules {
  perPurchaseAgorot: number;
  dailyAgorot: number;
  monthlyAgorot: number;
  allowedMerchants?: string[];
  blockedMerchants?: string[];
}

export interface SpendRequest {
  id: string;
  merchant: string;
  amountAgorot: number;
  description: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'declined' | 'auto-approved' | 'auto-declined' | 'expired';
  reason?: string;
}

/** אישור תשלום חד־פעמי — נעול לבית עסק ולסכום, פג תוקף, לשימוש יחיד */
export type PaymentCredential = IssuedCredential;

export interface LedgerEntry {
  at: number;
  kind: 'topup' | 'spend' | 'decline' | 'release';
  amountAgorot: number;
  merchant?: string;
  note: string;
}

export type RuleViolation =
  | 'per-purchase-cap'
  | 'daily-cap'
  | 'monthly-cap'
  | 'merchant-not-allowed'
  | 'merchant-blocked'
  | 'insufficient-balance';

const DAY_MS = 24 * 60 * 60 * 1000;

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function formatILS(agorot: number): string {
  return `₪${(agorot / 100).toFixed(2)}`;
}

function requireAgorot(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive safe integer of agorot');
  }
}

export class AgentWallet {
  private balanceAgorot = 0;
  private rules: WalletRules;
  private mode: ApprovalMode;
  private requests: SpendRequest[] = [];
  private issuer: IssuerAdapter;
  private ledger: LedgerEntry[] = [];

  constructor(mode: ApprovalMode, rules: WalletRules, issuer?: IssuerAdapter) {
    this.mode = mode;
    this.rules = rules;
    this.issuer = issuer ?? new SimulatedIssuerAdapter();
  }

  getIssuerName(): string { return this.issuer.name; }

  getMode(): ApprovalMode { return this.mode; }
  setMode(mode: ApprovalMode): void { this.mode = mode; }
  getRules(): WalletRules { return { ...this.rules }; }
  setRules(rules: Partial<WalletRules>): void { this.rules = { ...this.rules, ...rules }; }
  getLedger(): LedgerEntry[] { return [...this.ledger]; }
  getRequests(): SpendRequest[] { return [...this.requests]; }
  getCredentials(): PaymentCredential[] { return this.issuer.list(Date.now()); }
  getPendingRequests(): SpendRequest[] { return this.requests.filter((r) => r.status === 'pending'); }

  /** יתרה כוללת (כולל סכומים שמורזרבים לאישורים פעילים) */
  getBalanceAgorot(): number { this.sweepExpired(); return this.balanceAgorot; }
  /** יתרה זמינה בפועל = יתרה פחות רזרבציות פעילות */
  getAvailableAgorot(): number { this.sweepExpired(); return this.balanceAgorot - this.activeHoldsAgorot(); }

  private activeHoldsAgorot(): number {
    return this.issuer.activeHoldsAgorot(Date.now());
  }

  /** פג תוקף של אישורים → שחרור הרזרבציה */
  private sweepExpired(now = Date.now()): void {
    for (const { credential: c } of this.issuer.sweepExpired(now)) {
      this.ledger.push({ at: now, kind: 'release', amountAgorot: c.amountAgorot, merchant: c.merchant, note: 'אישור פג תוקף — הרזרבציה שוחררה' });
      const req = this.requests.find((r) => r.status === 'approved' || r.status === 'auto-approved');
      if (req && req.merchant === c.merchant && req.amountAgorot === c.amountAgorot) req.status = 'expired';
    }
  }

  /** טעינה ידנית בלבד — ערוץ הבעלים בלבד, אין מקור מימון אוטומטי */
  topUp(amountAgorot: number, note = 'טעינה ידנית'): LedgerEntry {
    requireAgorot(amountAgorot);
    this.balanceAgorot += amountAgorot;
    const entry: LedgerEntry = { at: Date.now(), kind: 'topup', amountAgorot, note };
    this.ledger.push(entry);
    return entry;
  }

  /** בדיקת חוקים טהורה — אותם חוקים בשני המצבים. מתחשבת ברזרבציות פעילות. */
  checkRules(merchant: string, amountAgorot: number, now = Date.now()): RuleViolation[] {
    this.sweepExpired(now);
    const violations: RuleViolation[] = [];
    const r = this.rules;
    if (r.blockedMerchants?.some((m) => m.toLowerCase() === merchant.toLowerCase())) {
      violations.push('merchant-blocked');
    }
    if (r.allowedMerchants && !r.allowedMerchants.some((m) => m.toLowerCase() === merchant.toLowerCase())) {
      violations.push('merchant-not-allowed');
    }
    if (amountAgorot > r.perPurchaseAgorot) violations.push('per-purchase-cap');

    const held = this.activeHoldsAgorot();
    const spentDay = this.ledger
      .filter((e) => e.kind === 'spend' && now - e.at < DAY_MS)
      .reduce((s, e) => s + e.amountAgorot, 0);
    if (spentDay + held + amountAgorot > r.dailyAgorot) violations.push('daily-cap');

    const d = new Date(now);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const spentMonth = this.ledger
      .filter((e) => e.kind === 'spend' && e.at >= monthStart)
      .reduce((s, e) => s + e.amountAgorot, 0);
    if (spentMonth + held + amountAgorot > r.monthlyAgorot) violations.push('monthly-cap');

    if (amountAgorot > this.balanceAgorot - held) violations.push('insufficient-balance');
    return violations;
  }

  /**
   * הסוכן מבקש לבצע רכישה.
   * approve-each → הבקשה ממתינה לאישור אנושי (pending).
   * autonomous → החלטה מיידית לפי החוקים; באישור מונפק אישור תשלום (הדמיה) עם רזרבציה.
   */
  requestSpend(merchant: string, amountAgorot: number, description: string):
    { request: SpendRequest; credential?: PaymentCredential } {
    requireAgorot(amountAgorot);
    const request: SpendRequest = {
      id: randomId('req'),
      merchant,
      amountAgorot,
      description,
      createdAt: Date.now(),
      status: 'pending',
    };

    if (this.mode === 'approve-each') {
      this.requests.push(request);
      return { request };
    }

    const violations = this.checkRules(merchant, amountAgorot);
    if (violations.length > 0) {
      request.status = 'auto-declined';
      request.reason = violations.join(', ');
      this.requests.push(request);
      this.ledger.push({ at: Date.now(), kind: 'decline', amountAgorot, merchant, note: request.reason });
      return { request };
    }
    request.status = 'auto-approved';
    this.requests.push(request);
    const credential = this.issueCredential(merchant, amountAgorot);
    return { request, credential };
  }

  /**
   * אישור אנושי של בקשה ממתינה — ערוץ הבעלים בלבד.
   * בדיקת החוקים חוזרת ברגע האישור; אישור כפול לא אפשרי; הסכום מורזרב מיד.
   */
  approve(requestId: string): { request: SpendRequest; credential: PaymentCredential } {
    const request = this.requests.find((r) => r.id === requestId);
    if (!request) throw new Error(`unknown request ${requestId}`);
    if (request.status !== 'pending') throw new Error(`request ${requestId} is ${request.status}, not pending`);
    const violations = this.checkRules(request.merchant, request.amountAgorot);
    if (violations.length > 0) {
      request.status = 'declined';
      request.reason = `rules changed since request: ${violations.join(', ')}`;
      this.ledger.push({ at: Date.now(), kind: 'decline', amountAgorot: request.amountAgorot, merchant: request.merchant, note: request.reason });
      throw new Error(request.reason);
    }
    request.status = 'approved';
    const credential = this.issueCredential(request.merchant, request.amountAgorot);
    return { request, credential };
  }

  decline(requestId: string, reason = 'נדחה על ידי הבעלים'): SpendRequest {
    const request = this.requests.find((r) => r.id === requestId);
    if (!request) throw new Error(`unknown request ${requestId}`);
    if (request.status !== 'pending') throw new Error(`request ${requestId} is ${request.status}, not pending`);
    request.status = 'declined';
    request.reason = reason;
    this.ledger.push({ at: Date.now(), kind: 'decline', amountAgorot: request.amountAgorot, merchant: request.merchant, note: reason });
    return request;
  }

  /** הנפקת אישור דרך מתאם המנפיק + רזרבציה מיידית של הסכום */
  private issueCredential(merchant: string, amountAgorot: number): PaymentCredential {
    // רזרבציה בלבד: הסכום נעול כ-hold ומקוזז מהיתרה הזמינה ומהתקרות עד למימוש או פקיעה
    return this.issuer.issue(merchant, amountAgorot);
  }

  /**
   * מימוש אישור תשלום (הדמיה בלבד — לא מנפיק כסף אמיתי).
   * נכשל אם: אסימון לא ידוע, כבר נוצל או פג, בית עסק/סכום לא תואמים את הנעילה.
   * חד־פעמי: אותו אסימון לא ניתן למימוש פעמיים.
   */
  redeem(token: string, merchant: string, amountAgorot: number): LedgerEntry {
    const credential = this.issuer.redeem(token, merchant, amountAgorot, Date.now());
    this.balanceAgorot -= amountAgorot;
    const entry: LedgerEntry = {
      at: Date.now(),
      kind: 'spend',
      amountAgorot,
      merchant,
      note: `מימוש אישור ${token.slice(0, 14)}… (הדמיה)`,
    };
    this.ledger.push(entry);
    return entry;
  }
}
