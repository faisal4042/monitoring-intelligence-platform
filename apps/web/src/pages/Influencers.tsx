import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Post } from '../lib/types';
import { PERMISSIONS } from '@mip/shared';
import { Check, Pencil, Plus, UsersRound, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import PostCard from '../components/PostCard';
import Lightbox from '../components/Lightbox';
import AuthorHistoryModal from '../components/AuthorHistoryModal';

interface Influencer {
  id: string; username: string; notes: string | null; created_at: string;
  x_author_id: string | null; display_name: string | null; profile_image_url: string | null;
  author_bio: string | null; followers_count: number | null; is_verified: boolean | null;
  post_count: number; last_seen_at: string | null;
}

/** Splits on commas, whitespace or newlines and strips a leading @ — matches pasting a whole watchlist at once. */
function parseUsernames(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.replace(/^@/, '').trim()).filter(Boolean))];
}

export default function Influencers() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canWrite = can(PERMISSIONS.INFLUENCERS_WRITE);
  const [adding, setAdding] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [raw, setRaw] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [historyAuthorId, setHistoryAuthorId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['influencers'],
    queryFn: () => api.get<{ items: Influencer[] }>('/influencers'),
  });

  const { data: posts, isLoading: postsLoading } = useQuery({
    queryKey: ['influencer-posts', selected],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '50', influencersOnly: 'true' });
      if (selected) p.set('username', selected);
      return api.get<{ items: Post[] }>(`/posts?${p}`);
    },
  });

  const { data: whyData } = useQuery({
    queryKey: ['why', why],
    queryFn: () => api.get<Record<string, unknown>>(`/posts/${why}/why-collected`),
    enabled: !!why,
  });

  const add = useMutation({
    mutationFn: () => api.post<{ added: string[] }>('/influencers', { usernames: parseUsernames(raw) }),
    onSuccess: () => { setRaw(''); setAdding(false); qc.invalidateQueries({ queryKey: ['influencers'] }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/influencers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['influencers'] }),
  });

  const parsedCount = parseUsernames(raw).length;
  const withPosts = (data?.items ?? []).filter((i) => i.post_count > 0).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><UsersRound size={22} className="text-brand-500" /> العملاء المؤثرون</h1>
          <p className="text-sm muted">
            متابعة حسابات محدَّدة — تُجلب تغريداتها فقط إن طابقت قاموس أحد برامجنا، تماماً كأي منشور آخر.
            {data && <> {withPosts} من {data.items.length} تكلّموا عن برامجنا حتى الآن.</>}
          </p>
        </div>
        {canWrite && (
          <div className="flex gap-2 shrink-0">
            <button
              className={editMode ? 'btn-primary' : 'btn-ghost'}
              onClick={() => setEditMode((v) => !v)}
            >
              {editMode ? <Check size={15} /> : <Pencil size={15} />} {editMode ? 'تم' : 'تعديل'}
            </button>
            <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> إضافة حسابات</button>
          </div>
        )}
      </div>

      {isLoading && <div className="card p-8 text-center muted text-sm">جارٍ التحميل…</div>}

      {!isLoading && !data?.items?.length && (
        <div className="card p-10 text-center"><p className="muted">لا توجد حسابات متابَعة بعد.</p></div>
      )}

      {/* Compact roster — click one to filter the feed below to just them. */}
      {!!data?.items?.length && (
        <div className="flex flex-wrap gap-1.5">
          <button
            className={`badge ${!selected ? 'bg-brand-500/15 text-brand-600 dark:text-brand-400' : 'bg-[var(--surface-3)]'}`}
            onClick={() => setSelected(null)}
          >
            الكل ({data.items.length})
          </button>
          {data.items.map((inf) => (
            <button
              key={inf.id}
              className={`badge group ${selected === inf.username ? 'bg-brand-500/15 text-brand-600 dark:text-brand-400' : 'bg-[var(--surface-3)]'}`}
              onClick={() => setSelected(inf.username === selected ? null : inf.username)}
              title={inf.author_bio ?? undefined}
            >
              <Avatar src={inf.profile_image_url} name={inf.display_name} username={inf.username} size={16} />
              {inf.display_name ?? inf.username}
              {inf.post_count > 0 && <span className="num text-[10px] opacity-70">{inf.post_count}</span>}
              {editMode && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="text-red-600 hover:text-red-700"
                  onClick={(e) => { e.stopPropagation(); remove.mutate(inf.id); }}
                  title="إزالة من المتابعة"
                ><X size={12} /></span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* The actual point of this page: real tweets from these accounts, related to our programs. */}
      <div>
        <h2 className="text-sm font-medium mb-2 muted">
          {selected ? `تغريدات ${selected}@` : 'أحدث تغريدات العملاء المؤثرين المرتبطة ببرامجنا'}
        </h2>

        {postsLoading && <div className="card p-8 text-center muted text-sm">جارٍ التحميل…</div>}

        {!postsLoading && !posts?.items?.length && (
          <div className="card p-10 text-center">
            <p className="muted">
              {selected
                ? 'لا توجد تغريدات مطابقة لبرامجنا من هذا الحساب حتى الآن.'
                : 'لا توجد تغريدات مطابقة لبرامجنا من أي حساب متابَع حتى الآن — سيظهر أي تفاعل جديد تلقائياً.'}
            </p>
          </div>
        )}

        <div className="space-y-2">
          {(posts?.items ?? []).map((p) => (
            <PostCard key={p.id} post={p} onWhy={setWhy} onHistory={setHistoryAuthorId} onLightbox={setLightboxUrl} />
          ))}
        </div>
      </div>

      {adding && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setAdding(false)}>
          <form
            className="card p-5 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); if (parsedCount > 0) add.mutate(); }}
          >
            <h3 className="font-bold mb-1">إضافة حسابات مؤثرة</h3>
            <p className="text-xs muted mb-4">
              الصق حساباً واحداً أو أكثر — مفصولة بمسافة أو فاصلة أو سطر جديد، بـ@ أو بدونها.
            </p>
            <textarea
              className="input mb-2 font-mono text-sm"
              rows={8}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'@username1\n@username2\nusername3'}
              autoFocus
            />
            <div className="text-xs muted mb-4">{parsedCount} حساب سيُضاف</div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>إلغاء</button>
              <button className="btn-primary" disabled={parsedCount === 0 || add.isPending}>إضافة</button>
            </div>
            {add.error && <div className="text-xs text-red-600 mt-3">{(add.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {why && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setWhy(null)}>
          <div className="card p-5 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold mb-1">لماذا جمعنا هذا المنشور؟</h3>
            <pre className="text-xs p-3 rounded-lg overflow-auto max-h-96 whitespace-pre-wrap"
                 style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>
              {JSON.stringify(whyData ?? {}, null, 2)}
            </pre>
            <div className="flex justify-end mt-4">
              <button className="btn-ghost" onClick={() => setWhy(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {historyAuthorId && <AuthorHistoryModal xAuthorId={historyAuthorId} onClose={() => setHistoryAuthorId(null)} />}
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
