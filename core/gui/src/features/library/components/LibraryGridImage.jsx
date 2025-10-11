import { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faImage } from '@fortawesome/free-solid-svg-icons';
import placeholderPoster from '../../../img/placeholder.png';
import { plexImageUrl } from '../../../lib/api.js';

export default function LibraryGridImage({ item, shouldLoad }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [posterError, setPosterError] = useState(false);
  const [posterSrc, setPosterSrc] = useState(null);
  const posterPath = item?.thumb ?? null;
  const showUnavailableMessage = shouldLoad && (posterError || !posterPath);

  useEffect(() => {
    if (!shouldLoad || !posterPath) {
      setPosterSrc(null);
      setImageLoaded(false);
      setPosterError(false);
      return;
    }

    const resolvedUrl = plexImageUrl(posterPath, {
      width: 360,
      height: 540,
      upscale: 1,
      variant: 'grid',
    });
    setPosterSrc(resolvedUrl);
  }, [posterPath, shouldLoad]);

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-border/40">
      <img
        src={placeholderPoster}
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
          imageLoaded && !posterError ? 'opacity-0' : 'opacity-100'
        }`}
      />
      {posterSrc ? (
        <img
          src={posterSrc}
          alt={item.title ?? 'Poster'}
          loading="lazy"
          onLoad={() => setImageLoaded(true)}
          onError={() => {
            setPosterError(true);
            setImageLoaded(false);
          }}
          className={`relative h-full w-full object-cover transition duration-500 group-hover:scale-105 ${
            imageLoaded && !posterError ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ) : null}
      {showUnavailableMessage ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-border/40 text-center">
          <FontAwesomeIcon icon={faImage} className="text-lg text-muted" />
          <span className="px-3 text-xs font-medium uppercase tracking-wide text-subtle">
            Artwork unavailable
          </span>
        </div>
      ) : null}
    </div>
  );
}
