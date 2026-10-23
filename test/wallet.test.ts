import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentWallet, formatILS } from '../src/wallet.ts';

const rules = { perPurchaseAgorot: 5000, dailyAgorot: 10000, monthlyAgorot: 30000 };

test('formatILS', () => {
  assert.equal(formatILS(12345), '₪123.45');
});

test('approve-each: בקשה ממתינה לאישור, ואישור מנפיק אישור תשלום נעול', () => {
  const w = new AgentWallet('approve-each', rules);
  w.topUp(20000);
  const { request } = w.requestSpend('איקאה', 4500, 'מנורה');
  assert.equal(request.status, 'pending');
  const { credential } = w.approve(request.id);
  assert.equal(credential.merchant, 'איקאה');
  assert.equal(credential.amountAgorot, 4500);
  assert.equal(credential.simulated, true);
  const entry = w.redeem(credential.token, 'איקאה', 4500);
  assert.equal(entry.kind, 'spend');
  assert.equal(w.getBalanceAgorot(), 15500);
});

test('approve-each: אישור נכשל אם החוקים השתנו מאז הבקשה', () => {
  const w = new AgentWallet('approve-each', rules);
  w.topUp(20000);
  const { request } = w.requestSpend('איקאה', 4500, 'מנורה');
  w.setRules({ perPurchaseAgorot: 1000 });
  assert.throws(() => w.approve(request.id), /rules changed/);
  assert.equal(w.getRequests()[0].status, 'declined');
});

test('autonomous: אישור אוטומטי בתוך החוקים, דחייה מעל התקרה', () => {
  const w = new AgentWallet('autonomous', rules);
  w.topUp(20000);
  const ok = w.requestSpend('שופרסל', 3000, 'קניות');
  assert.equal(ok.request.status, 'auto-approved');
  assert.ok(ok.credential);
  const tooBig = w.requestSpend('איקאה', 6000, 'ספה');
  assert.equal(tooBig.request.status, 'auto-declined');
  assert.match(tooBig.request.reason ?? '', /per-purchase-cap/);
});

test('autonomous: תקרה יומית מצטברת', () => {
  const w = new AgentWallet('autonomous', rules);
  w.topUp(50000);
  for (let i = 0; i < 2; i++) {
    const { credential } = w.requestSpend('שופרסל', 5000, `קנייה ${i}`);
    w.redeem(credential!.token, 'שופרסל', 5000);
  }
  const third = w.requestSpend('שופרסל', 5000, 'קנייה שלישית');
  assert.equal(third.request.status, 'auto-declined');
  assert.match(third.request.reason ?? '', /daily-cap/);
});

test('יתרה לא מספיקה', () => {
  const w = new AgentWallet('autonomous', rules);
  w.topUp(1000);
  const res = w.requestSpend('שופרסל', 3000, 'קניות');
  assert.equal(res.request.status, 'auto-declined');
  assert.match(res.request.reason ?? '', /insufficient-balance/);
});

test('רשימת בתי עסק מותרים וחסומים', () => {
  const w = new AgentWallet('autonomous', { ...rules, allowedMerchants: ['שופרסל'], blockedMerchants: ['קזינו'] });
  w.topUp(50000);
  assert.equal(w.requestSpend('שופרסל', 1000, 'x').request.status, 'auto-approved');
  assert.equal(w.requestSpend('איקאה', 1000, 'x').request.status, 'auto-declined');
  const w2 = new AgentWallet('autonomous', { ...rules, blockedMerchants: ['קזינו'] });
  w2.topUp(50000);
  assert.match(w2.requestSpend('קזינו', 1000, 'x').request.reason ?? '', /merchant-blocked/);
});

test('אישור תשלום: חד־פעמי, נעול לבית עסק ולסכום', () => {
  const w = new AgentWallet('approve-each', rules);
  w.topUp(20000);
  const { request } = w.requestSpend('איקאה', 4500, 'מנורה');
  const { credential } = w.approve(request.id);
  assert.throws(() => w.redeem(credential.token, 'שופרסל', 4500), /locked to merchant/);
  assert.throws(() => w.redeem(credential.token, 'איקאה', 4000), /locked to amount/);
  w.redeem(credential.token, 'איקאה', 4500);
  assert.throws(() => w.redeem(credential.token, 'איקאה', 4500), /already used/);
});

test('טעינה חייבת להיות סכום חיובי שלם', () => {
  const w = new AgentWallet('autonomous', rules);
  assert.throws(() => w.topUp(0));
  assert.throws(() => w.topUp(-500));
  assert.throws(() => w.topUp(10.5));
});

test('רזרבציה: אישור אחד נועל את הכסף — אישור שני על אותו הכסף נכשל', () => {
  const w = new AgentWallet('approve-each', { perPurchaseAgorot: 100000, dailyAgorot: 100000, monthlyAgorot: 100000 });
  w.topUp(10000);
  const r1 = w.requestSpend('איקאה', 6000, 'כיסא');
  const r2 = w.requestSpend('איקאה', 6000, 'שולחן');
  w.approve(r1.request.id); // רזרבציה של 6000
  assert.equal(w.getBalanceAgorot(), 10000); // יתרה כוללת לא השתנתה
  assert.equal(w.getAvailableAgorot(), 4000); // זמינה — כן
  assert.throws(() => w.approve(r2.request.id), /insufficient-balance/);
  assert.equal(w.getRequests()[1].status, 'declined');
});

test('רזרבציה נספרת בתקרה היומית גם לפני מימוש', () => {
  const w = new AgentWallet('autonomous', { perPurchaseAgorot: 100000, dailyAgorot: 10000, monthlyAgorot: 100000 });
  w.topUp(50000);
  const first = w.requestSpend('שופרסל', 8000, 'קנייה גדולה');
  assert.equal(first.request.status, 'auto-approved'); // hold של 8000, עוד לא נממש
  const second = w.requestSpend('שופרסל', 3000, 'עוד קנייה');
  assert.equal(second.request.status, 'auto-declined');
  assert.match(second.request.reason ?? '', /daily-cap/);
});

test('אישור שפג תוקפו משחרר את הרזרבציה ולא ניתן למימוש', () => {
  const w = new AgentWallet('approve-each', { perPurchaseAgorot: 100000, dailyAgorot: 100000, monthlyAgorot: 100000 });
  w.topUp(10000);
  const { request } = w.requestSpend('איקאה', 6000, 'כיסא');
  const { credential } = w.approve(request.id);
  assert.equal(w.getAvailableAgorot(), 4000);
  // מדלגים 11 דקות קדימה — האישור פג (TTL = 10 דקות)
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    assert.equal(w.getAvailableAgorot(), 10000); // הרזרבציה שוחררה
    assert.throws(() => w.redeem(credential.token, 'איקאה', 6000), /expired/);
    // והתקרות חוזרות לאפשר רכישה חדשה
    const again = w.requestSpend('איקאה', 6000, 'כיסא אחר');
    assert.equal(again.request.status, 'pending');
    w.approve(again.request.id);
  } finally {
    Date.now = realNow;
  }
});

test('אישור כפול על אותה בקשה לא אפשרי', () => {
  const w = new AgentWallet('approve-each', rules);
  w.topUp(20000);
  const { request } = w.requestSpend('איקאה', 1000, 'x');
  w.approve(request.id);
  assert.throws(() => w.approve(request.id), /not pending/);
});
