/**
 * issuer.ts — גבול המתאם (adapter boundary) בין הארנק לבין מנפיק כרטיסים.
 *
 * הארנק לא מדבר ישירות עם שום ספק. הוא מדבר עם IssuerAdapter:
 * ממשק קטן וניטרלי־ספק להנפקת "אישור תשלום" נעול־בית־עסק, נעול־סכום וחד־פעמי.
 *
 * היישום היחיד כרגע הוא SimulatedIssuerAdapter — הדמיה מקומית, אפס כסף אמיתי.
 * מתאם אמיתי (למשל מול Airwallex Issuing: כרטיס virtual עם
 * allowed_transaction_count=SINGLE, allowed_merchant_brand_ids ומגבלת סכום
 * לטרנזקציה) יממש את אותו הממשק מול ה־API החי — בלי שינוי בליבת הארנק.
 *
 * שים לב: הממשק סינכרוני כי ההדמיה סינכרונית. מתאם אמיתי הוא אסינכרוני —
 * נקודת החיבור הנכונה היא שכבת השרת (src/server.ts), לא הליבה.
 */

/** אישור תשלום מונפק: נעול לבית עסק ולסכום, חד־פעמי, פג תוקף */
export interface IssuedCredential {
  token: string;
  merchant: string;
  amountAgorot: number;
  expiresAt: number;
  status: 'active' | 'redeemed' | 'expired' | 'cancelled';
  simulated: boolean;
}

export interface IssueResult {
  credential: IssuedCredential;
}

export interface RedeemResult {
  credential: IssuedCredential;
}

export interface ReleasedHold {
  credential: IssuedCredential;
}

export interface IssuerAdapter {
  readonly name: string;
  /** הנפקת אישור חד־פעמי נעול */
  issue(merchant: string, amountAgorot: number): IssuedCredential;
  /** סכום הרזרבציות הפעילות כרגע */
  activeHoldsAgorot(now: number): number;
  /** מימוש: נכשל אם לא ידוע, נוצל, פג, או בית־עסק/סכום לא תואמים */
  redeem(token: string, merchant: string, amountAgorot: number, now: number): IssuedCredential;
  /** פקיעת אישורים שפגו — מחזיר את אלו ששוחררו עכשיו */
  sweepExpired(now: number): ReleasedHold[];
  /** רשימת האישורים (קריאה בלבד) */
  list(now: number): IssuedCredential[];
}

const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** הדמיה מקומית — אין כאן כסף אמיתי ואין קריאת רשת */
export class SimulatedIssuerAdapter implements IssuerAdapter {
  readonly name = 'simulated';
  private credentials: IssuedCredential[] = [];

  issue(merchant: string, amountAgorot: number): IssuedCredential {
    const credential: IssuedCredential = {
      token: randomId('demo_pay'),
      merchant,
      amountAgorot,
      expiresAt: Date.now() + CREDENTIAL_TTL_MS,
      status: 'active',
      simulated: true,
    };
    this.credentials.push(credential);
    return credential;
  }

  activeHoldsAgorot(now: number): number {
    this.sweepExpired(now);
    return this.credentials.filter((c) => c.status === 'active').reduce((s, c) => s + c.amountAgorot, 0);
  }

  redeem(token: string, merchant: string, amountAgorot: number, now: number): IssuedCredential {
    this.sweepExpired(now);
    const credential = this.credentials.find((c) => c.token === token);
    if (!credential) throw new Error('unknown credential');
    if (credential.status === 'redeemed') throw new Error('credential already used');
    if (credential.status === 'expired') throw new Error('credential expired');
    if (credential.status === 'cancelled') throw new Error('credential cancelled');
    if (credential.merchant.toLowerCase() !== merchant.toLowerCase()) {
      throw new Error(`credential locked to merchant ${credential.merchant}`);
    }
    if (credential.amountAgorot !== amountAgorot) {
      throw new Error(`credential locked to amount ${credential.amountAgorot}`);
    }
    credential.status = 'redeemed';
    return credential;
  }

  sweepExpired(now: number): ReleasedHold[] {
    const released: ReleasedHold[] = [];
    for (const c of this.credentials) {
      if (c.status === 'active' && now > c.expiresAt) {
        c.status = 'expired';
        released.push({ credential: c });
      }
    }
    return released;
  }

  list(now: number): IssuedCredential[] {
    this.sweepExpired(now);
    return this.credentials.map((c) => ({ ...c }));
  }
}
