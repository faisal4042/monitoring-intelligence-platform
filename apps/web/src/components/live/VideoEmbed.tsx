/**
 * Plays an X video inside the platform when only its preview was collected (no MP4 stored): X's own post player
 * (platform.twitter.com/embed) in a dialog. No API call, no key and no cost; the viewer's browser loads it from X.
 */
import {X as Close} from 'lucide-react';
import ModalSurface, {ModalCloseButton} from '../ModalSurface';

/** The X post id from a stored post link (x.com/…/status/<id>), or null. */
export const xPostIdOf = (url: string | null | undefined) => /^https:\/\/(?:x|twitter)\.com\/(?:[^/]+|i)\/status\/(\d{1,25})/.exec(url ?? '')?.[1] ?? null;
export const xEmbedUrl = (postId: string) =>
  `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(postId)}&lang=ar&dnt=true&hideThread=true&theme=light`;

export function XVideoFrame({postId, className = ''}: {postId: string; className?: string}) {
  return <iframe className={`x-video-frame ${className}`} src={xEmbedUrl(postId)} title="فيديو المنشور على X" loading="lazy"
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
    sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"/>;
}

export default function VideoEmbedModal({postId, onClose}: {postId: string; onClose: () => void}) {
  return <ModalSurface label="تشغيل الفيديو" onClose={onClose} panelClassName="card x-video-dialog">
    <header className="x-video-head"><h2>تشغيل الفيديو</h2>
      <ModalCloseButton type="button" className="ic-dialog-x" aria-label="إغلاق" onClick={onClose}><Close size={18}/></ModalCloseButton></header>
    <XVideoFrame postId={postId}/>
  </ModalSurface>;
}
