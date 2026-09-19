import { mediaAnalysisErrorResponse, startProductionAnalysis } from "../../../../../../../lib/media-analysis-server";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await startProductionAnalysis(request, batchId), { status: 202 });
  } catch (error) {
    return mediaAnalysisErrorResponse(error);
  }
}
