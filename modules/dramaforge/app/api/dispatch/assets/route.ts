import { dispatchErrorResponse, dispatchFetch } from "../../../../lib/dispatch";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: { category: "validation_error", message: "请选择有效素材" } }, { status: 400 });
    }
    const upstream = new FormData();
    upstream.set("file", file, file.name);
    const result = await dispatchFetch("/v1/assets", { method: "POST", body: upstream });
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
