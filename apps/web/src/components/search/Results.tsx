import {useBrowsingParams} from '../../lib/useBrowsingParams';
import {useLocation} from 'react-router-dom';
import QueueDrawer from '../QueueDrawer';
import { Fragment, type ReactNode } from 'react';
import { ExternalLink, Newspaper, PanelLeftOpen, Search } from 'lucide-react';
import type { SearchEntity } from '@mip/shared';
import Avatar from '../Avatar';
import DateTime from '../DateTime';
import { Pill } from '../influencers/shared';
import { fmtCompact, fmtNum } from '../../lib/format';
import InteractionList from '../live/InteractionList';
import type { Interaction } from '../live/interaction';
import { VALUE_LABELS, type View } from '../../lib/search';
import { QUEUE_STATUS_LABELS, type QueueStatus } from '@mip/shared';

type Row = Record<string, any>;

/**
 * Best-effort highlight of the searched words in the original text. Matching
 * itself happens on the normalized text in SQL; here the needles are folded
 * the same way so "ايجار" also marks "الإيجار".
 */
const DROP = /[ً-ٰٟـ]/;
const FOLD: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي' };
/** Folds like the server normalizer and keeps, for every folded char, its index in the original. */
function foldWithMap(text: string) {
  let folded = ''; const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (DROP.test(ch)) continue;
    folded += (FOLD[ch] ?? ch).toLowerCase(); at.push(i);
  }
  return { folded, at };
}
function Highlight({ text, needles }: { text: string; needles: string[] }) {
  if (!needles.length || !text) return <>{text}</>;
  const { folded, at } = foldWithMap(text);
  const marks: Array<[number, number]> = [];
  for (const n of needles) {
    const f = foldWithMap(n).folded; if (f.length < 2) continue;
    let i = folded.indexOf(f);
    while (i >= 0 && marks.length < 50) { marks.push([at[i], at[i + f.length - 1] + 1]); i = folded.indexOf(f, i + f.length); }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((x, y) => x[0] - y[0]);
  const out: ReactNode[] = []; let pos = 0;
  for (const [s, e] of marks) { if (s < pos) continue; out.push(text.slice(pos, s), <mark key={s} className="as-mark">{text.slice(s, e)}</mark>); pos = e; }
  out.push(text.slice(pos));
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}

export default function Results({ tab, items, view, needles, onSearch }: {
  tab: SearchEntity; items: Row[]; view: View; needles: string[]; onSearch: (q: string, tab?: SearchEntity) => void;
}) {
  const [params,setParams]=useBrowsingParams();const location=useLocation();const ticket=params.get('item');
  const openTicket=(id:string|null)=>setParams(old=>{const next=new URLSearchParams(old);id?next.set('item',id):next.delete('item');return next;},{state:location.state});
  if (tab === 'posts') return <InteractionList syncUrl posts={items as Interaction[]} onAccount={username => onSearch(`user:@${username}`)} renderText={post => needles.length ? <Highlight text={post.text} needles={needles}/> : undefined}/>;
  const Item = { news: NewsItem, accounts: AccountItem, tickets: TicketItem }[tab];
  return (
    <><div className={view === 'cards' ? 'as-cards' : 'as-list'} role="list">
      {items.map((r) => <div role="listitem" key={r.id as string}><Item r={r} needles={needles} onSearch={onSearch} onTicket={()=>openTicket(r.id as string)}/></div>)}
    </div>{tab==='tickets'&&ticket&&<QueueDrawer key={ticket} id={ticket} onClose={()=>openTicket(null)}/>}</>
  );
}

interface ItemProps { r: Row; needles: string[]; onSearch: (q: string, tab?: SearchEntity) => void;onTicket?:()=>void }

/** Some feeds put markup in descriptions; show text only. */
const plain = (s: string | null) => (s ?? '').replace(/<[^>]*>?/g, ' ').replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ').replace(/\s+/g, ' ').trim();

function NewsItem({ r, needles }: ItemProps) {
  const description = plain(r.description);
  return (
    <article className="as-item as-item--news">
      {r.image_url ? <img src={r.image_url} alt="" loading="lazy" className="as-thumb" /> : null}
      <div className="as-item-main">
        <div className="as-item-kicker">
          <span className="as-source"><Newspaper size={13} aria-hidden="true" />{r.source_name ?? 'مصدر غير معروف'}</span>
          <span aria-hidden="true">·</span>
          <DateTime value={r.published_at ?? r.discovered_at} />
          {r.language && <span className="num as-lang">{r.language}</span>}
        </div>
        <h3 className="as-title"><a href={r.url} target="_blank" rel="noreferrer" dir="auto"><Highlight text={r.title} needles={needles} /></a></h3>
        {description && <p className="as-item-text" dir="auto"><Highlight text={description} needles={needles} /></p>}
        <div className="as-item-foot">
          <div className="as-tags">
            {r.program_name && <span className="as-tag"><span className="inf-dot" style={{ background: r.program_color ?? 'var(--accent)' }} />{r.program_name}</span>}
            {r.topic_name && <Pill tone="info">{r.topic_name}</Pill>}
            <Pill tone={r.is_relevant ? 'ok' : 'muted'}>{r.is_relevant ? 'مرتبط' : 'غير مرتبط'}</Pill>
          </div>
          <a className="as-action" href={r.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" /> فتح الخبر</a>
        </div>
      </div>
    </article>
  );
}

function AccountItem({ r, needles, onSearch }: ItemProps) {
  return (
    <article className="as-item as-item--account">
      <Avatar src={r.profile_image_url} name={r.display_name} username={r.username} size={44} ring={r.is_verified ?? false} />
      <div className="as-item-main">
        <div className="as-item-head">
          <h3 className="as-name"><Highlight text={r.display_name ?? r.username} needles={needles} /></h3>
          {r.is_verified && <span className="verified-mark" aria-label="موثّق">✓</span>}
          {r.is_influencer && <Pill tone="warn">مؤثر متابَع</Pill>}
        </div>
        <div className="as-handle num" dir="ltr">@{r.username}</div>
        {r.description && <p className="as-item-text" dir="auto"><Highlight text={r.description} needles={needles} /></p>}
        <dl className="as-stats">
          <div><dt>المتابعون</dt><dd className="num">{fmtCompact(r.followers_count)}</dd></div>
          <div><dt>منشورات مجمّعة</dt><dd className="num">{fmtNum(r.post_count)}</dd></div>
          {r.last_seen_at && <div><dt>آخر نشاط</dt><dd><DateTime value={r.last_seen_at} /></dd></div>}
        </dl>
        <div className="as-item-foot">
          <button type="button" className="as-action as-action--primary" onClick={() => onSearch(`user:@${r.username}`, 'posts')}><Search size={14} aria-hidden="true" /> عرض منشوراته</button>
          <a className="as-action" href={`https://x.com/${encodeURIComponent(r.username)}`} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" /> الحساب على إكس</a>
        </div>
      </div>
    </article>
  );
}

function TicketItem({ r, needles, onTicket }: ItemProps) {
  return (
    <article className="as-item as-item--ticket">
      <div className="as-item-main">
        <div className="as-item-head">
          <span className={`queue-status-badge queue-status-badge--${r.status}`}>{QUEUE_STATUS_LABELS[r.status as QueueStatus] ?? r.status}</span>
          {r.priority === 'high' && <Pill tone="bad">أولوية عالية</Pill>}
          <Pill>{VALUE_LABELS[r.section] ?? r.section}</Pill>
          <code className="as-id num" title={r.id} dir="ltr">#{String(r.id).slice(0, 8)}</code>
        </div>
        <p className="as-item-text as-item-text--strong" dir="auto"><Highlight text={r.story_title ?? r.text ?? ''} needles={needles} /></p>
        <div className="as-item-kicker">
          <span>دخل <DateTime value={r.entered_at} /></span>
          {r.program_name && <span className="as-tag"><span className="inf-dot" style={{ background: r.program_color ?? 'var(--accent)' }} />{r.program_name}</span>}
          {r.team_name && <span>الفريق: {r.team_name}</span>}
          <span>المسند إليه: {r.assignee_name ?? 'غير مسند'}</span>
          {r.username && <span className="num" dir="ltr">@{r.username}</span>}
        </div>
        <div className="as-item-foot">
          <button type="button" className="as-action as-action--primary" onClick={onTicket}><PanelLeftOpen size={14} aria-hidden="true" /> فتح تفاصيل التذكرة</button>
          {r.url && <a className="as-action" href={r.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" /> المنشور على إكس</a>}
        </div>
      </div>
    </article>
  );
}
