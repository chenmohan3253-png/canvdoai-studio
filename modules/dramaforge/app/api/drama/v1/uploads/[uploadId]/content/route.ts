import { dramaUploadErrorResponse, readUploadedObject } from "../../../../../../../lib/drama-upload-server";

export async function GET(request: Request) {
  try {
    return await readUploadedObject(request);
  } catch (error) {
    return dramaUploadErrorResponse(error);
  }
}
