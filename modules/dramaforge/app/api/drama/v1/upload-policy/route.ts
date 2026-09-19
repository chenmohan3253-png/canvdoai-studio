import { configuredDramaUploadPolicy } from "../../../../../lib/drama-upload-policy";

export async function GET() {
  return Response.json(configuredDramaUploadPolicy(), {
    headers: { "cache-control": "private, max-age=60" },
  });
}
