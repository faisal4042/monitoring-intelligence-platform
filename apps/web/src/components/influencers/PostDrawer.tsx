import ModalSurface from '../ModalSurface';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Filter, Heart, History, MessageCircle, Repeat2, X } from 'lucide-react';
import { PERMISSIONS } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Post } from '../../lib/types';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { RELEVANCE, SENTIMENT } from '../../lib/influencers';
import Avatar from '../Avatar';
import DateTime from '../DateTime';
import Lightbox from '../Lightbox';
import AuthorHistoryModal from '../AuthorHistoryModal';
import { Pill } from './shared';

import { Button } from '../ui/Button';
interface WhyCollected {
  matched_keywords: string[] | null; filter_reason: string | null; status: string;
  query_id: string | null; query_name: string | null; version: number | null; compiled: string | null;
  relevance: string | null; reason_ar: string | null; stage: number | null;
}

/**
 * Side panel with everything the old full-size card showed — plus "why was
 * this collected?" inline — so the feed rows can stay one or two lines tall.
 */
export default function PostDrawer({ post: p, onClose, onFilterAccount }: {
  post: Post; onClose: () => void; onFilterAccount?: () => void;
}) {
  const { can } = useAuth();
  const canHistory = can(PERMISSIONS.CUSTOMERS_READ);
  const [history, setHistory] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);


  const why = useQuery({
    queryKey: ['why', p.id],
    queryFn: () => api.get<WhyCollected>(`/posts/${p.id}/why-collected`),
  });



  const rel = p.status === 'duplicate' ? { text: 'مكرر', tone: 'info' as const }
    : p.status === 'filtered_out' ? { text: 'مستبعد بالفلتر الأولي', tone: 'muted' as const }
    : RELEVANCE[p.relevance ?? 'unknown'] ?? RELEVANCE.unknown;
  const sent = p.sentiment ? SENTIMENT[p.sentiment] : null;

  return (
    <><ModalSurface label={'تفاصيل المنشور'} onClose={onClose} overlayClassName="inf-drawer" panelClassName="card">
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">تفاصيل المنشور</h2>
          <button  className="icon-button" aria-label="إغلاق التفاصيل" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="flex items-start gap-3">
          <Avatar src={p.profile_image_url} name={p.display_name} username={p.username} size={48} ring={p.is_verified ?? false} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-bold">
              <span className="truncate">{p.display_name ?? 'حساب غير معروف'}</span>
              {p.is_verified && <span className="verified-mark" title="حساب موثّق" aria-label="حساب موثّق">✓</span>}
            </div>
            <div className="text-xs muted">
              {p.username && <span className="num">@{p.username}</span>}
              {' · '}{p.followers_count !== null ? <><span className="num">{fmtNum(p.followers_count)}</span> متابع</> : 'عدد المتابعين غير متوفر'}
            </div>
            {p.author_bio && <p className="mt-1 text-xs leading-5 muted">{p.author_bio}</p>}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <a className="btn-primary" href={p.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> فتح المنشور على إكس</a>
          {canHistory && <Button variant="ghost" type="submit" onClick={() => setHistory(true)}><History size={15} /> سجل العميل</Button>}
          {onFilterAccount && <Button variant="ghost" type="submit" onClick={onFilterAccount}><Filter size={15} /> كل منشورات هذا الحساب</Button>}
        </div>

        <p className="inf-full-text">{p.text}</p>

        {!!p.media?.length && (
          <div className="flex flex-wrap gap-2">
            {p.media.filter((m) => m.url || m.previewImageUrl).map((m, i) => (
              <button key={i} type="button" className="overflow-hidden rounded-lg" aria-label="تكبير الصورة"
                onClick={() => setLightbox((m.url ?? m.previewImageUrl)!)}>
                <img src={(m.previewImageUrl ?? m.url)!} alt="" loading="lazy" className="block h-28 w-auto max-w-full object-cover" />
              </button>
            ))}
          </div>
        )}

        <dl className="inf-dl">
          <dt>وقت النشر</dt><dd><DateTime value={p.posted_at} /></dd>
          {p.collected_at && <><dt>وقت الجمع</dt><dd>{fmtDateTime(p.collected_at)}</dd></>}
          <dt>البرنامج</dt>
          <dd>{p.program_name
            ? <span className="inline-flex items-center gap-1.5"><span className="inf-dot" style={{ background: p.program_color ?? 'var(--accent)' }} />{p.program_name}</span>
            : <span className="muted">غير مرتبط ببرنامج</span>}</dd>
          <dt>حالة الارتباط</dt><dd><Pill tone={rel.tone}>{rel.text}</Pill>{p.stage ? <span className="muted text-xs num"> · S{p.stage}</span> : null}</dd>
          <dt>المشاعر</dt><dd>{sent ? <Pill tone={sent.tone}>{sent.text}</Pill> : <span className="muted">لم تُصنَّف بعد</span>}</dd>
          <dt>الموضوع</dt><dd>{p.topic_name ?? <span className="muted">غير مصنَّف</span>}</dd>
          <dt>التفاعل</dt>
          <dd className="flex flex-wrap gap-3 text-xs">
            <span className="inline-flex items-center gap-1" title="الردود"><MessageCircle size={14} aria-hidden="true" /><span className="num">{fmtNum(p.reply_count)}</span> رد</span>
            <span className="inline-flex items-center gap-1" title="إعادات النشر"><Repeat2 size={14} aria-hidden="true" /><span className="num">{fmtNum(p.repost_count)}</span> إعادة نشر</span>
            <span className="inline-flex items-center gap-1" title="الإعجابات"><Heart size={14} aria-hidden="true" /><span className="num">{fmtNum(p.like_count)}</span> إعجاب</span>
          </dd>
        </dl>

        <div className="inf-why">
          <h3 className="mb-2 font-bold text-sm">لماذا جمعنا هذا المنشور؟</h3>
          {why.isLoading && <p className="muted">جارٍ التحميل…</p>}
          {why.error && <p role="alert" className="text-(--status-danger)">{(why.error as Error).message}</p>}
          {why.data && (
            <dl className="inf-dl">
              <dt>الاستعلام</dt><dd>{why.data.query_name ?? <span className="muted">غير محدد</span>}{why.data.version ? <span className="muted num"> · v{why.data.version}</span> : null}</dd>
              <dt>الكلمات المطابقة</dt>
              <dd>{why.data.matched_keywords?.length
                ? <span className="inf-keywords">{why.data.matched_keywords.map((k) => <Pill key={k}>{k}</Pill>)}</span>
                : <span className="muted">لا توجد</span>}</dd>
              {why.data.reason_ar && <><dt>سبب التصنيف</dt><dd>{why.data.reason_ar}</dd></>}
              {why.data.filter_reason && <><dt>سبب الاستبعاد</dt><dd className="num">{why.data.filter_reason}</dd></>}
              {why.data.compiled && <><dt>نص الاستعلام</dt><dd><code className="block text-xs leading-5 num" style={{ direction: 'ltr', textAlign: 'left', whiteSpace: 'pre-wrap' }}>{why.data.compiled}</code></dd></>}
            </dl>
          )}
        </div>
      </ModalSurface>{history && <div onClick={(e) => e.stopPropagation()}><AuthorHistoryModal xAuthorId={p.x_author_id} onClose={() => setHistory(false)} /></div>}
      {lightbox && <div onClick={(e) => e.stopPropagation()}><Lightbox url={lightbox} onClose={() => setLightbox(null)} /></div>}</>
  );
}
