import { dispatchErrorResponse, dispatchFetch } from "../../../../lib/dispatch";

export async function GET() {
  try {
    const [models, capabilities] = await Promise.all([
      dispatchFetch("/v1/models"),
      dispatchFetch("/v1/providers/capabilities"),
    ]);
    if (models.status >= 400) return Response.json(models.payload, { status: models.status });
    if (capabilities.status >= 400) return Response.json(capabilities.payload, { status: capabilities.status });
    return Response.json({ models: models.payload, capabilities: capabilities.payload });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
