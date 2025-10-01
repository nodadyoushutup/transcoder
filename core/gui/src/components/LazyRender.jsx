import { useEffect, useRef, useState } from 'react';

export default function LazyRender({
  children,
  placeholder = null,
  root = null,
  rootMargin = '0px',
  threshold = 0,
  once = true,
  className = undefined,
  estimatedHeight = undefined,
}) {
  const containerRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return undefined;
    }

    let cancelled = false;

    const observer = new IntersectionObserver(
      (entries) => {
        if (cancelled) {
          return;
        }
        entries.forEach((entry) => {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            setVisible(true);
            if (once) {
              observer.disconnect();
            }
          } else if (!once) {
            setVisible(false);
          }
        });
      },
      { root, rootMargin, threshold },
    );

    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [root, rootMargin, threshold, once]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={estimatedHeight ? { minHeight: estimatedHeight } : undefined}
    >
      {visible ? children : placeholder}
    </div>
  );
}
