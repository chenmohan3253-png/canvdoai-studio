import { dispatchErrorResponse, dispatchFetch } from "../../../../lib/dispatch";

export async function GET() {
  try {
    const result = await dispatchFetch("/v1/usage");
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
