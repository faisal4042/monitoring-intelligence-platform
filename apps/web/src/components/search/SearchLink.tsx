import { Link } from 'react-router-dom';
import { SearchCode } from 'lucide-react';
import type { SearchEntity } from '@mip/shared';
import { useAuth } from '../../lib/auth';
import { SEARCH_PERMS, searchHref } from '../../lib/search';

/** "Advanced search" entry point for other pages, with that page's context prefilled. */
export default function SearchLink({ q = '', tab = 'posts', label = 'بحث متقدم' }: { q?: string; tab?: SearchEntity; label?: string }) {
  const { can } = useAuth();
  if (!can(...SEARCH_PERMS)) return null;
  return <Link className="btn-ghost" to={searchHref(q, tab)} title="فتح البحث المتقدم بهذه الشروط"><SearchCode size={15} aria-hidden="true" /> {label}</Link>;
}
