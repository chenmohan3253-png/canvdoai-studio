export function videoAssetReceipt(receipt: unknown, kind: string, role: string, order: number): Record<string, unknown> {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw Error('素材上传返回的数据无效');
  const data = receipt as Record<string, unknown>;
  if (!['image', 'video', 'audio'].includes(kind) || !['first_frame', 'last_frame', 'reference'].includes(role) || !Number.isInteger(order) || order < 0) throw Error('素材角色或顺序无效');
  if (role !== 'reference' && kind !== 'image') throw Error('首尾帧必须使用图片');
  const key = typeof data.object_key === 'string' ? data.object_key.trim() : '';
  const url = typeof data.cdn_url === 'string' ? data.cdn_url.trim() : '';
  if (!key && !url) throw Error('素材上传未返回可引用的文件标识');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw Error('素材上传返回的地址无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('素材上传返回的地址无效');
  }
  if (data.kind !== undefined && data.kind !== kind) throw Error('素材上传返回的类型不匹配');
  if (data.sha256 !== undefined && (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(data.sha256))) throw Error('素材上传返回的校验值无效');
  const {object_key: _key, cdn_url: _cdn, url: _url, ...metadata} = data;
  return {...metadata, ...(key ? {object_key: key} : {}), ...(url ? {cdn_url: url, url} : {}), kind, role, order};
}
