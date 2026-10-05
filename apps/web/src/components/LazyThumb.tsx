import { useEffect, useRef, useState } from "react";

/**
 * Defers mounting the real `<img>`/`<video>` until this element is near the viewport - same
 * `IntersectionObserver` pattern as `VideoThumbnail` in `VideoMedia.tsx`, generalized for a
 * plain signed-URL thumbnail (Studio's timeline clips and media library grid, which render one
 * of these per scene/asset with no upper bound). Off-screen items stay an empty placeholder
 * (the caller's own background/border classes on `className` already show something), so a
 * project with many scenes never mounts dozens of real video decoders/image fetches at once -
 * only what's actually scrolled into view. `<video>` always uses `preload="metadata"` (never
 * the browser default, which can eagerly buffer the whole file) since these clips are muted
 * background previews, never meant to play.
 */
export function LazyThumb({ kind, url, alt = "", className = "", rootMargin = "150px" }: {
  kind: "image" | "video";
  url: string;
  alt?: string;
  className?: string;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className={className}>
      {visible ? (
        kind === "video" ? (
          <video src={url} muted preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <img src={url} alt={alt} loading="lazy" className="h-full w-full object-cover" />
        )
      ) : null}
    </div>
  );
}
