import { dramaErrorResponse, readProductionBatch } from "../../../../../../lib/drama-server";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await readProductionBatch(request, batchId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
