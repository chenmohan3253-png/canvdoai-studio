import { createDirectUpload, dramaUploadErrorResponse } from "../../../../../lib/drama-upload-server";

export async function POST(request: Request) {
  try {
    return Response.json(await createDirectUpload(request), { status: 201 });
  } catch (error) {
    return dramaUploadErrorResponse(error);
  }
}
