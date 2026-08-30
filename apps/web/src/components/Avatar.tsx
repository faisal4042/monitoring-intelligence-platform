import { useState } from 'react';

/**
 * Profile picture with a deterministic initials fallback.
 *
 * A missing or broken avatar is the normal case, not the exception: protected
 * accounts, deleted users and expired X CDN links all show up in real data.
 * The fallback colour is derived from the username so the same account always
 * looks the same and stays scannable in a long feed.
 */
export default function Avatar({
  src,
  name,
  username,
  size = 40,
  ring,
}: {
  src?: string | null;
  name?: string | null;
  username?: string | null;
  size?: number;
  ring?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  const seed = username ?? name ?? '?';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;

  const initial = [...(name ?? username ?? '?')][0] ?? '?';
  const showImage = src && !failed;

  return (
    <div
      className={`shrink-0 rounded-full overflow-hidden grid place-items-center select-none ${
        ring ? 'ring-2 ring-amber-400/70' : ''
      }`}
      style={{
        width: size,
        height: size,
        background: showImage ? 'transparent' : `hsl(${hue} 55% 42%)`,
        color: `hsl(${hue} 60% 93%)`,
        fontSize: size * 0.42,
        fontWeight: 600,
        lineHeight: 1,
      }}
      title={username ? `@${username}` : undefined}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}
