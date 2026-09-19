import { createProductionBatch, dramaErrorResponse, listProductionBatches } from "../../../../../lib/drama-server";

export async function GET(request: Request) {
  try {
    return Response.json(await listProductionBatches(request));
  } catch (error) {
    return dramaErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    return Response.json(await createProductionBatch(request), { status: 201 });
  } catch (error) {
    return dramaErrorResponse(error);
  }
}
