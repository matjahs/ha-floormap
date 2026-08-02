export async function decodeImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

export async function preloadImages(urls: string[]): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  const unique = [...new Set(urls.filter(Boolean))];
  await Promise.all(
    unique.map(async (url) => {
      try {
        const img = await decodeImage(url);
        map.set(url, img);
      } catch {
        // leave missing; card will report
      }
    }),
  );
  return map;
}

/** Idle-time prefetch without blocking first paint. */
export function idlePrefetch(urls: string[]): void {
  const run = () => {
    void preloadImages(urls);
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => run(), { timeout: 2000 });
  } else {
    setTimeout(run, 100);
  }
}
