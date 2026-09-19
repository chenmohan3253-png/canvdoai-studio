import { addProductionReferenceAsset, dramaErrorResponse } from "../../../../../../../lib/drama-server";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await addProductionReferenceAsset(request, batchId), { status: 201 });
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
