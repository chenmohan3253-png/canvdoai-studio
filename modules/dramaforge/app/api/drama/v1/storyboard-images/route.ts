import { readStoryboardImage, storyboardErrorResponse } from "../../../../../lib/storyboard-server";

export async function GET(request: Request) {
  try {
    return await readStoryboardImage(request);
  } catch (error) {
    return storyboardErrorResponse(error);
  }
}
