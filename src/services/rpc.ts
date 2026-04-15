export type RpcResponse<T = any> = {
  ok: boolean;
  op: string;
  data: T | null;
  error: string | null;
  code: string | null;
  degraded: boolean;
};

const PROXY_BASE = "https://vikarux-g2.centralus.cloudapp.azure.com:3001";
const DEVICE_TOKEN = (import.meta.env.VITE_DEVICE_RPC_TOKEN as string) ?? "";
const CLIENT_TIMEOUT_MS = 35_000;

export async function rpc<T = any>(
  op: string,
  context: Record<string, unknown>,
  sessionId?: string | null,
  personaId?: string | null,
): Promise<RpcResponse<T>> {
  const body = JSON.stringify({ op, context, sessionId: sessionId ?? null, personaId: personaId ?? null });

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`${PROXY_BASE}/api/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Token": DEVICE_TOKEN,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(tid);
      return res;
    } catch (err: any) {
      clearTimeout(tid);
      throw err;
    }
  };

  let res: Response;
  try {
    res = await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    try {
      res = await attempt();
    } catch (err2: any) {
      return {
        ok: false, op, data: null,
        error: err2?.message ?? "network error",
        code: "RPC_NETWORK", degraded: true,
      };
    }
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false, op, data: null,
      error: "malformed server response",
      code: "RPC_INTERNAL", degraded: true,
    };
  }

  if (res.status >= 500) {
    return {
      ok: false, op, data: null,
      error: parsed?.error ?? "server error",
      code: parsed?.code ?? "RPC_INTERNAL",
      degraded: true,
    };
  }

  if (res.status >= 400) {
    return {
      ok: false, op, data: null,
      error: parsed?.error ?? "client error",
      code: parsed?.code ?? "RPC_BAD_REQUEST",
      degraded: false,
    };
  }

  return {
    ok: parsed.ok ?? true,
    op: parsed.op ?? op,
    data: parsed.data ?? null,
    error: parsed.error ?? null,
    code: parsed.code ?? null,
    degraded: parsed.degraded ?? false,
  };
}
