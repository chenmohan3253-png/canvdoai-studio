export const REVIEW_PAGE_SIZE = 12;
export function reviewPage<T>(segments: T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(segments.length / REVIEW_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  return { page, pages, items: segments.slice(page * REVIEW_PAGE_SIZE, (page + 1) * REVIEW_PAGE_SIZE) };
}
