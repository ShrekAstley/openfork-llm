import { vi } from "vitest";
import { registerAdminBotRoutes } from "../../src/server/AdminBotRoutes";
import { GameServer } from "../../src/server/GameServer";

// The admin-bot routes (key check skipped, see AdminBotAuth.test) behind a
// fetch, so the Brain Host talks to the real routes and GameServer in-process.
export function fetchInto(game: GameServer): typeof fetch {
  const table: Record<string, (req: any, res: any) => void> = {};
  const add =
    (method: string) =>
    (path: string, ...h: ((req: any, res: any) => void)[]) => {
      table[`${method} ${path}`] = h[h.length - 1];
    };
  const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  registerAdminBotRoutes({
    app: { get: add("GET"), post: add("POST") } as any,
    gm: { game: () => game } as any,
    workerId: 0,
    log,
  });
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const m = /^\/api\/adminbot\/game\/([^/]+)\/(\w+)$/.exec(u.pathname)!;
    const route = `${init.method ?? "GET"} /api/adminbot/game/:id/${m[2]}`;
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    table[route](
      {
        params: { id: m[1] },
        query: Object.fromEntries(u.searchParams),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      },
      res,
    );
    return new Response(JSON.stringify(res.body), { status: res.statusCode });
  }) as unknown as typeof fetch;
}
