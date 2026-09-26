/** /analytics — how the wiki is being used, for wiki admins (every space,
 *  or any one) and space managers (the spaces they manage; everyone else
 *  sees NotFound). A space picker and a period (7/30/90 days, a year),
 *  both kept in the URL, then the cards: views over time, top pages,
 *  helpfulness, recent "No" comments, searches with no results (admins
 *  only — a search isn't tied to a space), stale pages and overdue
 *  reviews. The numbers come from `GET /wiki/analytics`. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import ComboBox, { type ComboOption } from '@portal/components/ComboBox';
import { longDate, relativeTime } from '@portal/lib/format';

import NodeIcon from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import type { AnalyticsDays, AnalyticsNodeRef, AnalyticsOut, SpaceOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { errorMessage, getAnalytics, listSpaces } from '../lib/wikiApi';
import NotFound from '../pages/NotFound';
import { ShareBar, ViewsBars } from './charts';

const PERIODS: { days: AnalyticsDays; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];
const DEFAULT_DAYS: AnalyticsDays = 30;

function parseDays(raw: string | null): AnalyticsDays {
  const n = Number(raw);
  return PERIODS.some((p) => p.days === n) ? (n as AnalyticsDays) : DEFAULT_DAYS;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: AnalyticsOut }
  | { status: 'error'; message: string };

const TOP_GRID = { gridTemplateColumns: 'minmax(200px, 1fr) 72px 72px' };
const HELP_GRID = { gridTemplateColumns: 'minmax(180px, 1fr) 52px 52px 60px minmax(80px, 120px)' };
const SEARCH_GRID = { gridTemplateColumns: 'minmax(180px, 1fr) 84px 110px' };
const DATE_GRID = { gridTemplateColumns: 'minmax(200px, 1fr) 150px' };

function Card({ title, hint, wide, children }: {
  title: string; hint?: string; wide?: boolean; children: ReactNode;
}) {
  return (
    <section className={`panel wiki-an-card${wide ? ' wide' : ''}`} aria-label={title}>
      <div className="panel-head">
        <h3>{title}</h3>
        {hint && <span className="page-hint wiki-an-hint">{hint}</span>}
      </div>
      <div className="wiki-an-card-body">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="dir-empty wiki-an-empty">{children}</div>;
}

/** A node's title as a link, with its icon (and its space, over all spaces). */
function NodeCell({ node, showSpace }: { node: AnalyticsNodeRef; showSpace: boolean }) {
  return (
    <div className="cell cell-primary">
      <NodeIcon node={{ kind: node.kind, title: node.title, file: null }} className="wiki-row-icon" />
      <div className="pn">
        <Link className="wiki-row-link" to={`/n/${node.id}`} title={node.title}><b>{node.title}</b></Link>
        {showSpace && <span className="cell-sub cell-line mono">{node.space_key}</span>}
      </div>
    </div>
  );
}

function Rows({ label, grid, head, children }: {
  label: string; grid: { gridTemplateColumns: string }; head: string[]; children: ReactNode;
}) {
  return (
    <div className="dir-list wiki-an-list">
      <div className="list-head" style={grid} aria-hidden="true">
        {head.map((h, i) => <span key={h || i}>{h}</span>)}
      </div>
      <div role="list" aria-label={label}>{children}</div>
    </div>
  );
}

function Report({ data, isAdmin }: { data: AnalyticsOut; isAdmin: boolean }) {
  const showSpace = data.space_key === null;
  const period = PERIODS.find((p) => p.days === data.days)?.label ?? `${data.days} days`;
  const total = data.views_by_day.reduce((sum, d) => sum + d.views, 0);

  return (
    <div className="wiki-an-grid">
      <Card title="Views over time" wide>
        <div className="wiki-an-total"><b>{total}</b><span>{total === 1 ? 'view' : 'views'} in the last {period}</span></div>
        {total > 0 ? <ViewsBars days={data.views_by_day} /> : <Empty>No views in this period.</Empty>}
      </Card>

      <Card title="Top pages" hint="Most opened pages and files">
        {data.top_pages.length === 0 ? <Empty>Nothing was opened in this period.</Empty> : (
          <Rows label="Top pages" grid={TOP_GRID} head={['Page', 'Views', 'Viewers']}>
            {data.top_pages.map((t) => (
              <div className="dir-row" role="listitem" key={t.node.id}>
                <div className="row-main" style={TOP_GRID}>
                  <NodeCell node={t.node} showSpace={showSpace} />
                  <div className="cell num"><span>{t.views}</span></div>
                  <div className="cell num"><span>{t.viewers}</span></div>
                </div>
              </div>
            ))}
          </Rows>
        )}
      </Card>

      <Card title="Helpfulness" hint="“Was this page helpful?” answers">
        {data.helpfulness.length === 0 ? <Empty>Nobody has rated a page in this period.</Empty> : (
          <Rows label="Helpfulness" grid={HELP_GRID} head={['Page', 'Yes', 'No', '% yes', '']}>
            {data.helpfulness.map((h) => (
              <div className="dir-row" role="listitem" key={h.node.id}>
                <div className="row-main" style={HELP_GRID}>
                  <NodeCell node={h.node} showSpace={showSpace} />
                  <div className="cell num"><span>{h.yes}</span></div>
                  <div className="cell num"><span>{h.no}</span></div>
                  <div className="cell num"><span>{h.pct}%</span></div>
                  <div className="cell"><ShareBar pct={h.pct} label={`${h.node.title}: ${h.pct}% found it helpful`} /></div>
                </div>
              </div>
            ))}
          </Rows>
        )}
      </Card>

      <Card title="Recent “No” comments" hint="What readers said was missing or wrong">
        {data.recent_no_comments.length === 0 ? <Empty>No comments in this period.</Empty> : (
          <ul className="wiki-an-comments">
            {data.recent_no_comments.map((c) => (
              <li key={`${c.node.id}-${c.at}`}>
                <p className="wiki-an-quote">{c.comment}</p>
                <span className="cell-sub">
                  <Link className="wiki-row-link" to={`/n/${c.node.id}`}>{c.node.title}</Link>
                  {' · '}
                  <span title={new Date(c.at).toLocaleString()}>{relativeTime(c.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isAdmin && (
        <Card title="Searches with no results" hint="Across the whole wiki">
          {data.failed_searches.length === 0 ? <Empty>Every search found something.</Empty> : (
            <Rows label="Searches with no results" grid={SEARCH_GRID} head={['Search', 'Times', 'Last searched']}>
              {data.failed_searches.map((f) => (
                <div className="dir-row" role="listitem" key={f.query}>
                  <div className="row-main" style={SEARCH_GRID}>
                    <div className="cell cell-primary"><span className="cell-line" title={f.query}>{f.query}</span></div>
                    <div className="cell num"><span>{f.count}</span></div>
                    <div className="cell"><span className="cell-line">{relativeTime(f.last_at)}</span></div>
                  </div>
                </div>
              ))}
            </Rows>
          )}
        </Card>
      )}

      <Card title="Stale pages" hint="Published pages not updated in a year">
        {data.stale_pages.length === 0 ? <Empty>Every published page was updated in the last year.</Empty> : (
          <Rows label="Stale pages" grid={DATE_GRID} head={['Page', 'Last updated']}>
            {data.stale_pages.map((p) => (
              <div className="dir-row" role="listitem" key={p.node.id}>
                <div className="row-main" style={DATE_GRID}>
                  <NodeCell node={p.node} showSpace={showSpace} />
                  <div className="cell"><span className="cell-line">{longDate(p.updated_at)}</span></div>
                </div>
              </div>
            ))}
          </Rows>
        )}
      </Card>

      <Card title="Overdue reviews" hint="Pages past their periodic review">
        {data.overdue_reviews.length === 0 ? <Empty>No reviews are overdue.</Empty> : (
          <Rows label="Overdue reviews" grid={DATE_GRID} head={['Page', 'Review was due']}>
            {data.overdue_reviews.map((r) => (
              <div className="dir-row" role="listitem" key={r.node.id}>
                <div className="row-main" style={DATE_GRID}>
                  <NodeCell node={r.node} showSpace={showSpace} />
                  <div className="cell"><span className="cell-line">{longDate(r.next_review_at)}</span></div>
                </div>
              </div>
            ))}
          </Rows>
        )}
      </Card>
    </div>
  );
}

export default function AnalyticsPage() {
  const me = useWikiMe();
  const { setCurrentNode } = useWikiShell();
  const [params, setParams] = useSearchParams();
  const [spaces, setSpaces] = useState<SpaceOut[] | null>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const isAdmin = !!me?.is_admin;

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  // admins may pick an archived space too
  useEffect(() => {
    if (!me) return undefined;
    let live = true;
    listSpaces(isAdmin)
      .then((s) => { if (live) setSpaces(s); })
      .catch(() => { if (live) setSpaces([]); });
    return () => { live = false; };
  }, [me, isAdmin]);

  const managed = (spaces ?? []).filter((s) => s.my_level === 'manage');
  const eligible = isAdmin || managed.length > 0;
  const days = parseDays(params.get('days'));
  const asked = params.get('space') ?? '';
  // a manager always looks at one of their spaces; an admin may look at all
  const space = isAdmin ? asked : (managed.find((s) => s.key === asked) ?? managed[0])?.key ?? '';
  const ready = !!me && spaces !== null && eligible;

  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    setState({ status: 'loading' });
    getAnalytics({ space: space || undefined, days })
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch((err) => {
        if (live) setState({ status: 'error', message: errorMessage(err, 'Couldn\'t load the analytics.') });
      });
    return () => { live = false; };
  }, [ready, space, days]);

  if (!me || spaces === null) {
    return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  }
  if (!eligible) return <NotFound />;

  const patch = (next: { space?: string; days?: AnalyticsDays }) => setParams((cur) => {
    const p = new URLSearchParams(cur);
    if (next.space !== undefined) { if (next.space) p.set('space', next.space); else p.delete('space'); }
    if (next.days !== undefined) {
      if (next.days === DEFAULT_DAYS) p.delete('days'); else p.set('days', String(next.days));
    }
    return p;
  }, { replace: true });

  const options: ComboOption[] = (isAdmin ? spaces : managed).map((s) => ({
    value: s.key, label: s.name, sub: s.archived_at ? 'Archived' : null,
  }));

  return (
    <div className="portal-page wiki-page wiki-analytics-page" data-testid="analytics-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">{isAdmin ? <Link to="/admin">Wiki admin</Link> : 'Wiki'}</div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-hint">What people read, whether it helped, and what needs attention.</p>
        </div>
      </div>

      <div className="dir-toolbar wiki-an-filters">
        <ComboBox
          options={options}
          value={space}
          onChange={(v) => patch({ space: v })}
          placeholder="All libraries"
          ariaLabel="Library"
          clearable={isAdmin}
        />
        <div className="segmented wiki-an-period" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" className={days === p.days ? 'on' : undefined}
                    aria-pressed={days === p.days} onClick={() => patch({ days: p.days })}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' && <p className="page-hint">Loading…</p>}
      {state.status === 'error' && <p className="pf-error">{state.message}</p>}
      {state.status === 'ready' && <Report data={state.data} isAdmin={isAdmin} />}
    </div>
  );
}
