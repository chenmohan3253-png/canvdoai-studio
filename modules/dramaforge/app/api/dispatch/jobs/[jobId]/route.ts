import { dispatchErrorResponse, dispatchFetch } from "../../../../../lib/dispatch";

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const result = await dispatchFetch(`/v1/video-jobs/${encodeURIComponent(jobId)}`);
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const result = await dispatchFetch(`/v1/video-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
