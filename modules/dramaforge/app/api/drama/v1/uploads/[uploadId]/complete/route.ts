import { completeDirectUpload, dramaUploadErrorResponse } from "../../../../../../../lib/drama-upload-server";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await context.params;
    return Response.json(await completeDirectUpload(request, uploadId));
  } catch (error) {
    return dramaUploadErrorResponse(error);
  }
}
