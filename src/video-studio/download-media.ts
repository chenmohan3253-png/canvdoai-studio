function clickDownload(href: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Download media through an object URL so same-origin API assets are saved
 * instead of replacing the current SPA page. A direct-link fallback keeps
 * data/blob URLs and permissive remote providers usable.
 */
export async function downloadMedia(url: string, filename: string): Promise<void> {
  if (typeof document === "undefined") throw new Error("当前环境不支持文件下载。");
  let objectUrl: string | undefined;
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`下载服务返回 HTTP ${response.status}。`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("下载结果为空。");
    objectUrl = URL.createObjectURL(blob);
    clickDownload(objectUrl, filename);
  } catch (reason) {
    if (/^(data:|blob:|\/)/i.test(url)) {
      clickDownload(url, filename);
      return;
    }
    throw reason;
  } finally {
    if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 1_000);
  }
}
