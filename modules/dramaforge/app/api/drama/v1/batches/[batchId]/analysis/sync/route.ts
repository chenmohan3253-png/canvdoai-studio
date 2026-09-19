import { mediaAnalysisErrorResponse, syncProductionAnalysis } from "../../../../../../../../lib/media-analysis-server";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await syncProductionAnalysis(request, batchId));
  } catch (error) {
    return mediaAnalysisErrorResponse(error);
  }
}
