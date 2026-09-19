import { dramaErrorResponse, retryProductionSegment } from "../../../../../../../../../lib/drama-server";

export async function POST(request: Request, context: { params: Promise<{ batchId: string; segmentId: string }> }) {
  try {
    const { batchId, segmentId } = await context.params;
    return Response.json(await retryProductionSegment(request, batchId, segmentId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
