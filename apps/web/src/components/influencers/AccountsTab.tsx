import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ExternalLink, ListFilter, NotebookPen, Search, UserMinus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { DateRangeState } from '../../lib/useDateRange';
import { fmtCompact, fmtDate, fmtDateTime, fmtNum, fmtRelative } from '../../lib/format';
import {
  ACCOUNT_STATUS_LABELS, parseUsernames, useDebounced,
  type Account, type AccountPage, type AccountSort, type AccountStatus,
} from '../../lib/influencers';
import Avatar from '../Avatar';
import { Pill, StateBox } from './shared';
import { CardExportButton } from './CardExportDialog';

import { Button } from '../ui/Button';
const PAGE_SIZES = [25, 50, 100];

/** Invalidates everything derived from the roster after a change. */
export const invalidateRoster = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of ['influencer-accounts', 'influencer-accounts-pick', 'influencer-overview', 'influencer-analytics', 'influencers'])
    qc.invalidateQueries({ queryKey: [key] });
};

export default function AccountsTab({ date, canWrite, onShowPosts }: {
  date: DateRangeState; canWrite: boolean; onShowPosts: (username: string) => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [status, setStatus] = useState<AccountStatus>('all');
  const [sort, setSort] = useState<AccountSort>('period_posts');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [editing, setEditing] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  // Any filter change starts again from page 1.
  useEffect(() => { setPage(1); }, [q, status, sort, dir, pageSize, date.apiQuery]);

  const list = useQuery({
    queryKey: ['influencer-accounts', { q, status, sort, dir, page, pageSize, range: date.apiQuery }],
    enabled: Boolean(date.apiQuery),
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const p = new URLSearchParams(date.apiQuery);
      Object.entries({ status, sort, dir, page: String(page), pageSize: String(pageSize) }).forEach(([k, v]) => p.set(k, v));
      if (q) p.set('q', q);
      return api.get<AccountPage>(`/influencers/accounts?${p}`, signal);
    },
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  const sortBy = (key: AccountSort) => {
    if (sort === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSort(key); setDir(key === 'username' ? 'asc' : 'desc'); }
  };
  const Th = ({ k, children }: { k: AccountSort; children: ReactNode }) => (
    <th aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inf-sort" data-active={sort === k} onClick={() => sortBy(k)}>
        {children}{sort === k && (dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-3" role="tabpanel" id="inf-panel-accounts" aria-labelledby="inf-tab-accounts">
      <div className="card p-3 inf-toolbar">
        <label className="inf-search">
          <Search size={15} aria-hidden="true" />
          <input className="input" type="search" placeholder="ابحث باسم الحساب أو المعرف…" aria-label="البحث في الحسابات"
            value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <select className="input" aria-label="حالة النشاط" value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>
          {Object.entries(ACCOUNT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-xs muted ms-auto">«منشورات الفترة» تتبع منتقي الفترة أعلى الصفحة.</span>
      </div>

      <div className="card p-3">
        <StateBox
          loading={list.isLoading || (!date.apiQuery && !date.error)} error={date.error ? new Error(date.error) : list.error}
          onRetry={() => list.refetch()} height={360}
          empty={!list.data?.items.length}
          emptyText={q || status !== 'all' ? 'لا توجد حسابات تطابق البحث أو الحالة المختارة.' : 'لا توجد حسابات متابَعة بعد.'}
        >
          <div className="inf-table-wrap" aria-busy={list.isFetching}>
            <table className="inf-table">
              <thead>
                <tr>
                  <Th k="username">الحساب</Th>
                  <Th k="followers">المتابعون</Th>
                  <Th k="period_posts">منشورات الفترة</Th>
                  <Th k="total_posts">إجمالي المنشورات</Th>
                  <Th k="last_seen_at">آخر نشاط</Th>
                  <Th k="created_at">أُضيف</Th>
                  <th>ملاحظات</th>
                  <th><span className="sr-only">إجراءات</span></th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="inf-account">
                        <Avatar src={a.profile_image_url} name={a.display_name} username={a.username} size={32} ring={a.is_verified ?? false} />
                        <div className="min-w-0">
                          <span className="inf-account-name" title={a.author_bio ?? undefined}>{a.display_name ?? a.username}</span>
                          <a className="text-xs muted num hover:underline" href={`https://x.com/${encodeURIComponent(a.username)}`} target="_blank" rel="noreferrer"
                            aria-label={`فتح حساب ${a.username} على إكس`}>@{a.username}</a>
                          {!a.x_author_id && <> <Pill tone="warn" title="لم يُجمع أي منشور من هذا الحساب بعد، لذا لا تتوفر بيانات ملفه">لم يُرصد بعد</Pill></>}
                        </div>
                      </div>
                    </td>
                    <td data-label="المتابعون" className="whitespace-nowrap">{a.followers_count !== null ? <span className="num">{fmtCompact(a.followers_count)}</span> : <span className="muted">غير متوفر</span>}</td>
                    <td data-label="منشورات الفترة"><span className="num">{fmtNum(a.period_posts)}</span></td>
                    <td data-label="إجمالي المنشورات"><span className="num">{fmtNum(a.total_posts)}</span></td>
                    <td data-label="آخر نشاط" className="whitespace-nowrap" title={a.last_seen_at ? fmtDateTime(a.last_seen_at) : undefined}>
                      {a.last_seen_at ? <>{fmtRelative(a.last_seen_at)}</> : <span className="muted">لا يوجد</span>}</td>
                    <td data-label="أُضيف" className="whitespace-nowrap" title={fmtDateTime(a.created_at)}>{fmtDate(a.created_at)}</td>
                    <td data-label="ملاحظات"><span className="inf-note" title={a.notes ?? undefined}>{a.notes || '—'}</span></td>
                    <td>
                      <div className="inf-row-actions">
                        <button className="icon-button" title="عرض منشورات الحساب" aria-label={`عرض منشورات ${a.username}`} onClick={() => onShowPosts(a.username)}
                          disabled={a.total_posts === 0}><ListFilter size={15} /></button>
                        <CardExportButton account={a} />
                        <a className="icon-button" title="فتح الحساب على إكس" aria-label={`فتح ${a.username} على إكس`} href={`https://x.com/${encodeURIComponent(a.username)}`}
                          target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
                        {canWrite && <>
                          <button className="icon-button" title="تعديل الملاحظة" aria-label={`تعديل ملاحظة ${a.username}`} onClick={() => setEditing(a)}><NotebookPen size={15} /></button>
                          <button className="icon-button" title="إيقاف المتابعة" aria-label={`إيقاف متابعة ${a.username}`} onClick={() => setRemoving(a)}><UserMinus size={15} /></button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.data && (
            <div className="inf-pager">
              <span>
                <span className="num">{fmtNum((list.data.page - 1) * list.data.pageSize + 1)}–{fmtNum(Math.min(list.data.page * list.data.pageSize, list.data.total))}</span>
                {' '}من <span className="num">{fmtNum(list.data.total)}</span> حساب
              </span>
              <div className="inf-pager-buttons">
                <label className="flex items-center gap-1.5">
                  لكل صفحة
                  <select className="input !w-auto" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="عدد الحسابات في الصفحة">
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button className="icon-button" aria-label="الصفحة السابقة" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronRight size={16} /></button>
                <span className="num">{page} / {pages}</span>
                <button className="icon-button" aria-label="الصفحة التالية" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronLeft size={16} /></button>
              </div>
            </div>
          )}
        </StateBox>
      </div>

      {editing && <NoteDialog account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidateRoster(qc); }} />}
      {removing && <RemoveDialog account={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); invalidateRoster(qc); }} />}
    </div>
  );
}

function Dialog({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {


  return (
    <ModalSurface label={title} onClose={onClose} busy={busy} overlayClassName="modal-overlay" panelClassName="card modal-card p-5 w-full max-w-md" as="div">
        <h3 className="font-bold mb-1">{title}</h3>
        {children}
      </ModalSurface>
  );
}

function NoteDialog({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [notes, setNotes] = useState(account.notes ?? '');
  const save = useMutation({ mutationFn: () => api.patch(`/influencers/${account.id}`, { notes: notes.trim() || null }), onSuccess: onSaved });
  return (
    <Dialog title={`ملاحظة داخلية — @${account.username}`} busy={save.isPending} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-xs muted mb-3">تظهر للفريق فقط ولا تؤثر على الرصد أو الجمع.</p>
        <textarea className="input mb-1 text-sm" rows={4} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus data-dialog-initial-focus
          placeholder="مثال: حساب إعلامي، يغطي أخبار البرنامج" />
        <div className="text-xs muted mb-4 num">{notes.length}/500</div>
        <div className="flex gap-2 justify-end">
          <ModalCloseButton type="button" className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
          <Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</Button>
        </div>
        {save.error && <div className="text-xs text-(--status-danger) mt-3" role="alert">{(save.error as ApiError).message}</div>}
      </form>
    </Dialog>
  );
}

function RemoveDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const remove = useMutation({ mutationFn: () => api.del(`/influencers/${account.id}`), onSuccess: onDone });
  return (
    <Dialog title="إيقاف متابعة الحساب" busy={remove.isPending} onClose={onClose}>
      <p className="text-sm mb-2">سيتوقف جمع منشورات <span className="num font-bold">@{account.username}</span> الجديدة ضمن قائمة المؤثرين.</p>
      <p className="text-xs muted mb-4">لا يُحذف أي منشور سابق، ويمكن إعادة الحساب لاحقاً بإضافته من جديد.</p>
      <div className="flex gap-2 justify-end">
        <ModalCloseButton type="button" className="btn-ghost" onClick={onClose} autoFocus data-dialog-initial-focus>إلغاء</ModalCloseButton>
        <Button variant="danger" type="submit" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'جارٍ التنفيذ…' : 'إيقاف المتابعة'}</Button>
      </div>
      {remove.error && <div className="text-xs text-(--status-danger) mt-3" role="alert">{(remove.error as ApiError).message}</div>}
    </Dialog>
  );
}

export function AddAccountsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [raw, setRaw] = useState('');
  const parsed = parseUsernames(raw);
  const add = useMutation({
    mutationFn: () => api.post<{ added: string[] }>('/influencers', { usernames: parsed }),
    onSuccess: () => { invalidateRoster(qc); onClose(); },
  });
  return (
    <Dialog title="إضافة حسابات مؤثرة" busy={add.isPending} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (parsed.length > 0) add.mutate(); }}>
        <p className="text-xs muted mb-4">الصق حساباً واحداً أو أكثر — مفصولة بمسافة أو فاصلة أو سطر جديد، بـ@ أو بدونها.</p>
        <textarea className="input mb-2 font-mono text-sm" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)}
          placeholder={'@username1\n@username2\nusername3'} autoFocus data-dialog-initial-focus aria-label="المعرفات" />
        <div className="text-xs muted mb-4"><span className="num">{parsed.length}</span> حساب سيُضاف{parsed.length > 200 && ' — الحد الأقصى 200 في المرة الواحدة'}</div>
        <div className="flex gap-2 justify-end">
          <ModalCloseButton type="button" className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
          <Button variant="primary" type="submit" disabled={parsed.length === 0 || parsed.length > 200 || add.isPending}>{add.isPending ? 'جارٍ الإضافة…' : 'إضافة'}</Button>
        </div>
        {add.error && <div className="text-xs text-(--status-danger) mt-3" role="alert">{(add.error as ApiError).message}</div>}
      </form>
    </Dialog>
  );
}
