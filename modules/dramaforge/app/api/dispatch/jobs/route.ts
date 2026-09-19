import { CreateVideoJobInput, dispatchErrorResponse, dispatchFetch, enforceDramaForgeSeedancePolicy } from "../../../../lib/dispatch";

export async function POST(request: Request) {
  try {
    const body = enforceDramaForgeSeedancePolicy((await request.json()) as CreateVideoJobInput);
    const result = await dispatchFetch("/v1/video-jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
