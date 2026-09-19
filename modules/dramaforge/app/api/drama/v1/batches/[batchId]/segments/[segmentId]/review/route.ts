import { dramaErrorResponse, reviewProductionSegments } from "../../../../../../../../../lib/drama-server";

export async function PATCH(request: Request, context: { params: Promise<{ batchId: string; segmentId: string }> }) {
  try {
    const { batchId, segmentId } = await context.params;
    return Response.json(await reviewProductionSegments(request, batchId, segmentId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
