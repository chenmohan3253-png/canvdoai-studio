import { dramaErrorResponse, generateProductionStoryboards } from "../../../../../../../../lib/drama-server";

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    return Response.json(await generateProductionStoryboards(request, batchId));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
