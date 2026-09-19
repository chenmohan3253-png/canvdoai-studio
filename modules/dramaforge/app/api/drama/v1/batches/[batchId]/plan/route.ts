import { dramaErrorResponse, updateProductionPlan } from "../../../../../../../lib/drama-server";

export async function PATCH(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await updateProductionPlan(request, batchId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
