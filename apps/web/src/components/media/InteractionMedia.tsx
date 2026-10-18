/**
 * Photos and videos attached to a post. Shared by live, queue and customer
 * history cards; kept apart from interaction-card.css so importing it does not
 * restyle the queue card.
 */
import {useState} from 'react';
import {ExternalLink, Play} from 'lucide-react';
import {interactionLabel, safeExternalUrl} from '../live/interaction';
import VideoEmbedModal, {xPostIdOf} from '../live/VideoEmbed';
import VideoPlayer, {VideoPlayerDialog} from './VideoPlayer';
import './interaction-media.css';

/** Only the post link and its media are read, so queue and history cards can reuse it. */
export type MediaSource = { url?: string | null; media?: Array<{ url: string | null; type: string; previewImageUrl: string | null }> | null };
export function InteractionMedia({ post, onLightbox, full = false }: { post: MediaSource; onLightbox: (url: string) => void; full?: boolean }) {
  const media = post.media ?? [];
  const [playing, setPlaying] = useState(false);
  const [theatre, setTheatre] = useState<{src: string; poster?: string} | null>(null);
  const xId = xPostIdOf(post.url);
  if (!media.length) return null;
  return <div className={`ic-media ${full ? 'ic-media-full' : ''}`} aria-label="وسائط التفاعل">
    {media.map((item, i) => {
      const preview = safeExternalUrl(item.previewImageUrl ?? (item.type === 'photo' ? item.url : null));
      const url = safeExternalUrl(item.url);
      const motion = item.type === 'video' || item.type === 'animated_gif';
      // A stored MP4 plays here; a video collected without its file (older collections) plays on X.
      const playable = motion && url && /\.mp4(\?|#|$)/i.test(url) ? url : undefined;
      const onX = safeExternalUrl(post.url) ?? url;
      // No MP4 stored: X's own player, inside the platform (dialog), not a jump to X.
      // Details: the platform player in place. Cards: a thumbnail that opens the player large.
      if (playable) return <div className="ic-media-item" key={i}>
        {full || item.type === 'animated_gif'
          ? <VideoPlayer src={playable} poster={preview} gif={item.type === 'animated_gif'} fallbackUrl={onX} title="فيديو المنشور" className={full ? 'vp-inline' : 'vp-card-gif'}/>
          : <button type="button" className="ic-media-play" onClick={() => setTheatre({src: playable, poster: preview})} aria-label="تشغيل الفيديو">
            {preview ? <img src={preview} alt="معاينة الفيديو" loading="lazy"/> : <span className="ic-video-blank"/>}<span className="ic-play-badge" aria-hidden="true"><Play size={18} fill="currentColor"/></span></button>}
      </div>;
      if (motion && preview) return <div className="ic-media-item" key={i}>
        {xId ? <button type="button" className="ic-media-play" onClick={() => setPlaying(true)} aria-label="تشغيل الفيديو">
          <img src={preview} alt="معاينة الفيديو" loading="lazy"/><span className="ic-play-badge" aria-hidden="true"><Play size={18} fill="currentColor"/></span></button>
          : <a className="ic-media-play" href={onX} target="_blank" rel="noreferrer" aria-label="تشغيل الفيديو على X">
          <img src={preview} alt="معاينة الفيديو" loading="lazy"/><span className="ic-play-badge" aria-hidden="true"><Play size={18} fill="currentColor"/></span></a>}
      </div>;
      return <div className="ic-media-item" key={i}>
        {preview && <button onClick={() => onLightbox(preview)} aria-label={`تكبير الوسائط ${i + 1}`}><img src={preview} alt={item.type === 'photo' ? 'صورة مرفقة بالمنشور' : 'معاينة الفيديو'} loading="lazy"/></button>}
        {item.type !== 'photo' && url && <a href={url} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden="true"/>{item.type === 'video' ? 'فتح الفيديو' : 'فتح الوسائط'}</a>}
        {!preview && !url && <span className="ic-chip">وسائط {interactionLabel(item.type)} — المعاينة غير متوفرة</span>}
      </div>;
    })}
    {playing && xId && <VideoEmbedModal postId={xId} onClose={() => setPlaying(false)}/>}
    {theatre && <VideoPlayerDialog src={theatre.src} poster={theatre.poster} fallbackUrl={safeExternalUrl(post.url)} title="فيديو المنشور" onClose={() => setTheatre(null)}/>}
  </div>;
}
