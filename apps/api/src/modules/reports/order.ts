import type {ReportType} from './definitions.js';
/** Positional sort keys refer to canonical definitions, never the user's selected projection. */
export function reportOrderBy(def:Pick<ReportType,'orderBy'|'columns'>):string{
 if(!/^\s*\d+(?:\s+(?:ASC|DESC))?(?:\s*,\s*\d+(?:\s+(?:ASC|DESC))?)*\s*$/i.test(def.orderBy))return def.orderBy;
 return def.orderBy.replace(/\b(\d+)\b/g,(_m,position:string)=>{
  const column=def.columns[Number(position)-1];
  if(!column)throw Error('Invalid canonical report sort position');
  return column.expr;
 });
}
