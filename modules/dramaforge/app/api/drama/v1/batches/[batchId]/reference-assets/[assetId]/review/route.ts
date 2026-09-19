import { dramaErrorResponse, reviewProductionReferenceAsset } from "../../../../../../../../../lib/drama-server";

export async function PATCH(request: Request, context: { params: Promise<{ batchId: string; assetId: string }> }) {
  try {
    const { batchId, assetId } = await context.params;
    return Response.json(await reviewProductionReferenceAsset(request, batchId, assetId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
