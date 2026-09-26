/** Test-only builders for the wiki API's shapes. */
import type { Level, MeOut, NodeDetailOut, NodeKind, NodeOut, SearchHit, SpaceOut } from '../lib/types';

const T = '2026-09-20T12:00:00Z';

export function makeSpace(over: Partial<SpaceOut> = {}): SpaceOut {
  return {
    id: 'space-1',
    key: 'ops',
    name: 'Operations',
    description: 'How we run moves',
    icon: '📘',
    color: '#1668a7',
    home_node_id: 'home-1',
    archived_at: null,
    my_level: 'edit',
    settings: {},
    created_at: T,
    updated_at: T,
    ...over,
  };
}

export function makeNode(
  id: string,
  over: Partial<NodeOut> & { kind?: NodeKind; my_level?: Level | null } = {},
): NodeOut {
  const kind = over.kind ?? 'page';
  return {
    id,
    space_id: 'space-1',
    space_key: 'ops',
    parent_id: null,
    kind,
    title: id,
    position: 0,
    inherit_permissions: true,
    owner: null,
    created_at: T,
    updated_at: T,
    updated_by: { id: 'p-1', name: 'Jimmy Henderson' },
    my_level: 'edit',
    has_children: false,
    is_favorite: false,
    page: kind === 'page'
      ? { is_home: false, published_version_id: null, published_at: null, has_unpublished_changes: false }
      : null,
    file: null,
    ...over,
  };
}

export function makeDetail(
  id: string, over: Partial<NodeDetailOut> = {},
): NodeDetailOut {
  return {
    ...makeNode(id, over),
    breadcrumbs: [],
    space: makeSpace(),
    ...over,
  };
}

export function makeMe(over: Partial<MeOut> = {}): MeOut {
  return {
    person: { id: 'p-1', name: 'Jimmy Henderson' },
    is_admin: false,
    can_create_spaces: false,
    ...over,
  };
}

export function makeSearchHit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    node: { id: 'n1', kind: 'page', title: 'Rack power', space_key: 'ops', space_name: 'Operations' },
    snippet_html: 'How to wire the <mark>rack</mark> power.',
    breadcrumbs: [],
    ...over,
  };
}
