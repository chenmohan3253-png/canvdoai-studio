import { dramaErrorResponse, exportProductionBatch } from "../../../../../../../../lib/drama-server";

export async function GET(request: Request, context: { params: Promise<{ batchId: string; format: string }> }) {
  try {
    const { batchId, format } = await context.params;
    return await exportProductionBatch(request, batchId, format);
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
