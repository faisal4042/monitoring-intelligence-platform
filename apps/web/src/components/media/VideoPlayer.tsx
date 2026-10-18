/**
 * The platform's video player (no third-party player, no extra dependency): poster with a large play button,
 * scrubbable progress with buffered range and hover time, ±10 s, volume, speed, picture-in-picture, fullscreen,
 * auto-hiding controls, loading and error states, and keyboard control. Media controls stay left-to-right (time
 * flows that way in every player); labels are Arabic.
 */
import {useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {Gauge, Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Volume2, VolumeX, X as Close} from 'lucide-react';
import ModalSurface, {ModalCloseButton} from '../ModalSurface';
import './video-player.css';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const clock = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

export interface VideoPlayerProps {
  src: string; poster?: string | null; title?: string;
  /** Loop silently with no controls (animated GIFs). */
  gif?: boolean; autoPlay?: boolean; className?: string;
  /** Where to watch when the file cannot play here. */
  fallbackUrl?: string | null;
}

export default function VideoPlayer({src, poster, title = 'فيديو', gif = false, autoPlay = false, className = '', fallbackUrl}: VideoPlayerProps) {
  const box = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), bar = useRef<HTMLDivElement>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [started, setStarted] = useState(autoPlay || gif);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0), [duration, setDuration] = useState(0), [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1), [muted, setMuted] = useState(gif);
  const [rate, setRate] = useState(1), [speedOpen, setSpeedOpen] = useState(false);
  const [waiting, setWaiting] = useState(false), [failed, setFailed] = useState(false);
  const [full, setFull] = useState(false), [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{x: number; t: number} | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const v = () => video.current!;
  const wake = useCallback(() => {
    setIdle(false); clearTimeout(hide.current);
    hide.current = setTimeout(() => { if (video.current && !video.current.paused) setIdle(true); }, 2600);
  }, []);
  const toggle = useCallback(() => {
    const el = video.current; if (!el) return;
    setStarted(true);
    if (el.paused) void el.play().catch(() => setFailed(true)); else el.pause();
    wake();
  }, [wake]);
  const seekBy = (d: number) => { const el = v(); el.currentTime = Math.min(Math.max(0, el.currentTime + d), el.duration || 0); wake(); };
  const setVol = (x: number) => { const el = v(); el.volume = x; el.muted = x === 0; setVolume(x); setMuted(x === 0); };
  const toggleMute = () => { const el = v(); el.muted = !el.muted; if (!el.muted && el.volume === 0) setVol(0.6); setMuted(el.muted); };
  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void box.current?.requestFullscreen?.(); };
  const pip = async () => {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v().requestPictureInPicture(); } catch { /* not supported */ }
  };
  const ratioAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
  };
  const scrub = (e: PointerEvent<HTMLDivElement>) => { const el = v(); if (el.duration) el.currentTime = ratioAt(e.clientX) * el.duration; };

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); clearTimeout(hide.current); };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowright') { e.preventDefault(); seekBy(5); }
    else if (k === 'arrowleft') { e.preventDefault(); seekBy(-5); }
    else if (k === 'arrowup') { e.preventDefault(); setVol(Math.min(1, v().volume + 0.1)); }
    else if (k === 'arrowdown') { e.preventDefault(); setVol(Math.max(0, v().volume - 0.1)); }
    else if (k === 'm') toggleMute();
    else if (k === 'f') toggleFull();
  };

  const pct = duration ? (time / duration) * 100 : 0;
  return <div ref={box} className={`vp ${full ? 'is-full' : ''} ${idle && playing && !speedOpen ? 'is-idle' : ''} ${gif ? 'is-gif' : ''} ${className}`}
    dir="ltr" tabIndex={0} role="region" aria-label={`مشغّل الفيديو: ${title}`} onKeyDown={gif ? undefined : onKey}
    onPointerMove={wake} onPointerLeave={() => { if (playing) setIdle(true); }}>
    <video ref={video} className="vp-video" src={src} poster={poster ?? undefined} preload="metadata" playsInline
      autoPlay={autoPlay || gif} loop={gif} muted={muted} aria-label={title}
      onClick={gif ? undefined : toggle} onDoubleClick={gif ? undefined : toggleFull}
      onPlay={() => { setPlaying(true); setStarted(true); wake(); }} onPause={() => { setPlaying(false); setIdle(false); }}
      onTimeUpdate={(e) => { if (!scrubbing) setTime(e.currentTarget.currentTime); }}
      onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onDurationChange={(e) => setDuration(e.currentTarget.duration)}
      onProgress={(e) => { const b = e.currentTarget.buffered; if (b.length) setBuffered(b.end(b.length - 1)); }}
      onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
      onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
      onError={() => setFailed(true)}/>

    {gif && <span className="vp-gif-tag">GIF</span>}
    {!gif && !started && !failed && <button type="button" className="vp-big-play" onClick={toggle} aria-label="تشغيل">
      <span className="vp-big-play-icon"><Play size={30} fill="currentColor"/></span>{duration > 0 && <span className="vp-big-play-time">{clock(duration)}</span>}</button>}
    {waiting && started && !failed && <span className="vp-spinner" aria-label="جارٍ التحميل" role="status"><Loader2 size={38}/></span>}
    {failed && <div className="vp-error" role="alert" dir="rtl"><p>تعذّر تشغيل الفيديو هنا.</p>
      {fallbackUrl && <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">مشاهدته في المصدر</a>}</div>}

    {!gif && started && !failed && <div className="vp-controls" onPointerDown={(e) => e.stopPropagation()}>
      <div ref={bar} className="vp-progress" role="slider" aria-label="موضع التشغيل" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
        aria-valuetext={`${clock(time)} من ${clock(duration)}`} tabIndex={-1}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setScrubbing(true); scrub(e); setTime(ratioAt(e.clientX) * duration); }}
        onPointerMove={(e) => { setHover({x: ratioAt(e.clientX) * 100, t: ratioAt(e.clientX) * duration}); if (scrubbing) { scrub(e); setTime(ratioAt(e.clientX) * duration); } }}
        onPointerUp={(e) => { setScrubbing(false); e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerLeave={() => setHover(null)}>
        <span className="vp-track"><span className="vp-buffered" style={{width: `${duration ? (buffered / duration) * 100 : 0}%`}}/>
          <span className="vp-played" style={{width: `${pct}%`}}/><span className="vp-thumb" style={{left: `${pct}%`}}/></span>
        {hover && <span className="vp-hover-time" style={{left: `${hover.x}%`}}>{clock(hover.t)}</span>}
      </div>
      <div className="vp-row">
        <button type="button" className="vp-btn" onClick={toggle} aria-label={playing ? 'إيقاف مؤقت' : 'تشغيل'} title={playing ? 'إيقاف مؤقت (K)' : 'تشغيل (K)'}>
          {playing ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button>
        <button type="button" className="vp-btn" onClick={() => seekBy(-10)} aria-label="رجوع 10 ثوانٍ" title="رجوع 10 ثوانٍ"><RotateCcw size={18}/><span className="vp-ten">10</span></button>
        <button type="button" className="vp-btn" onClick={() => seekBy(10)} aria-label="تقديم 10 ثوانٍ" title="تقديم 10 ثوانٍ"><RotateCw size={18}/><span className="vp-ten">10</span></button>
        <span className="vp-volume">
          <button type="button" className="vp-btn" onClick={toggleMute} aria-label={muted ? 'تشغيل الصوت' : 'كتم الصوت'} title={muted ? 'تشغيل الصوت (M)' : 'كتم الصوت (M)'}>
            {muted || volume === 0 ? <VolumeX size={19}/> : <Volume2 size={19}/>}</button>
          <input className="vp-volume-range" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="مستوى الصوت"
            onChange={(e) => setVol(Number(e.target.value))} style={{['--vp-vol' as string]: `${(muted ? 0 : volume) * 100}%`}}/>
        </span>
        <span className="vp-time"><bdi>{clock(time)}</bdi> / <bdi>{clock(duration)}</bdi></span>
        <span className="vp-spacer"/>
        <span className="vp-speed">
          <button type="button" className="vp-btn vp-speed-btn" aria-haspopup="menu" aria-expanded={speedOpen} aria-label="سرعة التشغيل" title="سرعة التشغيل"
            onClick={() => setSpeedOpen(!speedOpen)}><Gauge size={18}/><span>{rate}×</span></button>
          {speedOpen && <span className="vp-menu" role="menu" dir="rtl">{SPEEDS.map((s) => <button key={s} type="button" role="menuitemradio" aria-checked={rate === s}
            className={rate === s ? 'is-on' : ''} onClick={() => { v().playbackRate = s; setRate(s); setSpeedOpen(false); }}>{s === 1 ? 'عادية' : `${s}×`}</button>)}</span>}
        </span>
        {'pictureInPictureEnabled' in document && <button type="button" className="vp-btn" onClick={() => void pip()} aria-label="صورة داخل صورة" title="صورة داخل صورة"><PictureInPicture2 size={18}/></button>}
        <button type="button" className="vp-btn" onClick={toggleFull} aria-label={full ? 'الخروج من ملء الشاشة' : 'ملء الشاشة'} title={full ? 'الخروج من ملء الشاشة (F)' : 'ملء الشاشة (F)'}>
          {full ? <Minimize size={19}/> : <Maximize size={19}/>}</button>
      </div>
    </div>}
  </div>;
}

/** The player in a large dialog (cards show a thumbnail; playing opens the theatre). */
export function VideoPlayerDialog({onClose, ...player}: VideoPlayerProps & {onClose: () => void}) {
  return <ModalSurface label="تشغيل الفيديو" onClose={onClose} panelClassName="vp-dialog" overlayClassName="modal-overlay vp-overlay">
    <ModalCloseButton type="button" className="vp-dialog-close" aria-label="إغلاق المشغّل" onClick={onClose}><Close size={22}/></ModalCloseButton>
    <VideoPlayer {...player} autoPlay className="vp-theatre"/>
  </ModalSurface>;
}
