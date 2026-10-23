/**
 * MCP server (stdio, אפס תלויות) — ערוץ הסוכן בלבד.
 * כלים: get_balance, request_spend, list_requests, get_ledger, redeem_credential
 *
 * הפרדת ערוצים נאכפת בקוד, לא רק בתיעוד:
 * פעולות בעלים (טעינה, אישור/דחייה, שינוי חוקים או מצב) לא קיימות כאן בכלל.
 * הן זמינות רק בשרת הבעלים (src/server.ts, פורט 3001) מאחורי OWNER_TOKEN,
 * ובעתיד — ממספר ה-WhatsApp המאומת של הבעלים בלבד.
 */
import { createInterface } from 'node:readline';
import { AgentWallet, formatILS } from './wallet.ts';

const wallet = new AgentWallet('approve-each', {
  perPurchaseAgorot: 5000,
  dailyAgorot: 10000,
  monthlyAgorot: 30000,
});

const tools = [
  {
    name: 'get_balance',
    description: 'יתרת הארנק: כוללת וזמינה (אחרי רזרבציות לאישורים פעילים), באגורות ובשקלים',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_spend',
    description: 'בקשת רכישה של הסוכן. במצב approve-each ממתינה לאישור הבעלים; במצב autonomous מוחזרת החלטה מיידית לפי החוקים',
    inputSchema: {
      type: 'object',
      properties: {
        merchant: { type: 'string' },
        amountAgorot: { type: 'integer' },
        description: { type: 'string' },
      },
      required: ['merchant', 'amountAgorot', 'description'],
    },
  },
  {
    name: 'list_requests',
    description: 'כל בקשות הרכישה וסטטוסן',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_ledger',
    description: 'פנקס התנועות המלא',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'redeem_credential',
    description: 'מימוש אישור תשלום חד־פעמי (הדמיה). נעול לבית העסק ולסכום שאושרו',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        merchant: { type: 'string' },
        amountAgorot: { type: 'integer' },
      },
      required: ['token', 'merchant', 'amountAgorot'],
    },
  },
];

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_balance':
      return {
        balanceAgorot: wallet.getBalanceAgorot(),
        balance: formatILS(wallet.getBalanceAgorot()),
        availableAgorot: wallet.getAvailableAgorot(),
        available: formatILS(wallet.getAvailableAgorot()),
      };
    case 'request_spend': {
      const { request, credential } = wallet.requestSpend(
        String(args.merchant), Number(args.amountAgorot), String(args.description));
      return { request, credential };
    }
    case 'list_requests':
      return wallet.getRequests();
    case 'get_ledger':
      return wallet.getLedger();
    case 'redeem_credential':
      return wallet.redeem(String(args.token), String(args.merchant), Number(args.amountAgorot));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function send(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const rl = createInterface({ input: process.stdin });
let buffer = '';
let expectedLength: number | null = null;

rl.on('line', (line) => {
  if (expectedLength === null) {
    const match = /^Content-Length: (\d+)$/i.exec(line.trim());
    if (match) expectedLength = Number(match[1]);
    return;
  }
  buffer += line;
  if (Buffer.byteLength(buffer) < expectedLength) return;
  const message = JSON.parse(buffer);
  buffer = '';
  expectedLength = null;
  handleMessage(message);
});

function handleMessage(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
  const id = msg.id ?? null;
  try {
    switch (msg.method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'agent-wallet-il', version: '0.1.0' },
          },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools } });
      case 'tools/call': {
        const params = msg.params as { name: string; arguments?: Record<string, unknown> };
        const result = callTool(params.name, params.arguments ?? {});
        return send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        });
      }
      default:
        if (id !== null) {
          return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        }
    }
  } catch (err) {
    if (id !== null) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
