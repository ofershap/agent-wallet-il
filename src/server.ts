/**
 * שרתי HTTP מינימליים (אפס תלויות) — שני ערוצים נפרדים, נאכף בקוד:
 *
 *   ערוץ סוכן   http://localhost:3000  — state (קריאה), request, redeem בלבד.
 *   ערוץ בעלים  http://localhost:3001  — טעינה, אישור/דחייה, מצב, חוקים.
 *                                        כל נתיב דורש כותרת  x-owner-token
 *                                        ששווה ל-OWNER_TOKEN (משתנה סביבה או
 *                                        אסימון אקראי שמודפס ל-console בעלייה).
 *
 * npm start מרים את שניהם. הסוכן מקבל רק את כתובת פורט 3000 (או את שרת ה-MCP);
 * אין בו שום דרך להגיע לפעולות הבעלים.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentWallet, formatILS } from './wallet.ts';

const wallet = new AgentWallet('approve-each', {
  perPurchaseAgorot: 5000,
  dailyAgorot: 10000,
  monthlyAgorot: 30000,
});

const OWNER_TOKEN = process.env.OWNER_TOKEN ?? randomBytes(16).toString('hex');

function state() {
  return {
    mode: wallet.getMode(),
    rules: wallet.getRules(),
    balanceAgorot: wallet.getBalanceAgorot(),
    balance: formatILS(wallet.getBalanceAgorot()),
    availableAgorot: wallet.getAvailableAgorot(),
    available: formatILS(wallet.getAvailableAgorot()),
    requests: wallet.getRequests(),
    pending: wallet.getPendingRequests(),
    ledger: wallet.getLedger(),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/* ---------- ערוץ סוכן ---------- */
const agentServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state());
    if (url.pathname === '/api/request' && req.method === 'POST') {
      const { merchant, amountAgorot, description } = await readBody(req);
      const result = wallet.requestSpend(String(merchant), Number(amountAgorot), String(description ?? ''));
      return json(res, 200, { ok: true, ...result, state: state() });
    }
    if (url.pathname === '/api/redeem' && req.method === 'POST') {
      const { token, merchant, amountAgorot } = await readBody(req);
      return json(res, 200, { ok: true, entry: wallet.redeem(String(token), String(merchant), Number(amountAgorot)), state: state() });
    }
    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'agent-wallet-il — ערוץ סוכן',
        endpoints: ['GET /api/state', 'POST /api/request', 'POST /api/redeem'],
        note: 'פעולות בעלים (טעינה/אישור/חוקים) לא קיימות בפורט הזה בכלל',
      });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/* ---------- ערוץ בעלים ---------- */
const ownerServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'owner.html'), 'utf-8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    // כל נתיב API בערוץ הבעלים דורש אימות
    if (req.headers['x-owner-token'] !== OWNER_TOKEN) {
      return json(res, 401, { error: 'owner authentication required (x-owner-token)' });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state());
    if (url.pathname === '/api/topup' && req.method === 'POST') {
      const { amountAgorot } = await readBody(req);
      return json(res, 200, { ok: true, entry: wallet.topUp(Number(amountAgorot)), state: state() });
    }
    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const { requestId } = await readBody(req);
      const result = wallet.approve(String(requestId));
      return json(res, 200, { ok: true, ...result, state: state() });
    }
    if (url.pathname === '/api/decline' && req.method === 'POST') {
      const { requestId, reason } = await readBody(req);
      return json(res, 200, { ok: true, request: wallet.decline(String(requestId), reason ? String(reason) : undefined), state: state() });
    }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      const { mode } = await readBody(req);
      wallet.setMode(mode === 'autonomous' ? 'autonomous' : 'approve-each');
      return json(res, 200, { ok: true, state: state() });
    }
    if (url.pathname === '/api/rules' && req.method === 'POST') {
      wallet.setRules(await readBody(req) as never);
      return json(res, 200, { ok: true, rules: wallet.getRules(), state: state() });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

const agentPort = Number(process.env.AGENT_PORT ?? 3000);
const ownerPort = Number(process.env.OWNER_PORT ?? 3001);
agentServer.listen(agentPort, () => {
  console.log(`ערוץ סוכן   → http://localhost:${agentPort}  (state/request/redeem בלבד)`);
});
ownerServer.listen(ownerPort, () => {
  console.log(`ערוץ בעלים  → http://localhost:${ownerPort}  (דורש x-owner-token)`);
  if (!process.env.OWNER_TOKEN) {
    console.log(`OWNER_TOKEN לא הוגדר — נוצר אסימון זמני להפעלה זו: ${OWNER_TOKEN}`);
  }
  console.log('הדמיה בלבד — לא כסף אמיתי');
});
