export async function GET() {
  const healthUrl = process.env.DISPATCH_HEALTH_URL
    || (process.env.DISPATCH_API_BASE_URL ? `${process.env.DISPATCH_API_BASE_URL.replace(/\/$/, "")}/healthz` : undefined);
  if (!healthUrl) {
    return Response.json({ status: "unconfigured" }, { status: 503 });
  }
  try {
    const response = await fetch(healthUrl, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const payload = await response.json().catch(() => ({ status: response.ok ? "ok" : "error" })) as Record<string, unknown>;
    return Response.json({ ...payload, reachable: response.ok }, { status: response.ok ? 200 : 502 });
  } catch (error) {
    return Response.json({ status: "unreachable", reachable: false, message: error instanceof Error ? error.message : "健康检查失败" }, { status: 502 });
  }
}
