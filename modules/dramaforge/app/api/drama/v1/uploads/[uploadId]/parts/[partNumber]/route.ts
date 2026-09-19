import { dramaUploadErrorResponse, uploadDirectPart } from "../../../../../../../../lib/drama-upload-server";

export async function PUT(request: Request, context: { params: Promise<{ uploadId: string; partNumber: string }> }) {
  try {
    const { uploadId, partNumber } = await context.params;
    return Response.json(await uploadDirectPart(request, uploadId, partNumber));
  } catch (error) {
    return dramaUploadErrorResponse(error);
  }
}
