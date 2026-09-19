import { abortDirectUpload, dramaUploadErrorResponse } from "../../../../../../lib/drama-upload-server";

export async function DELETE(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  try {
    const { uploadId } = await context.params;
    return Response.json(await abortDirectUpload(request, uploadId));
  } catch (error) {
    return dramaUploadErrorResponse(error);
  }
}
