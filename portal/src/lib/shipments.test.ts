import { describe, expect, it } from 'vitest';

import type { TruckFeedEvent, TruckItem } from './api';
import { LIST_FIT, listGridStyle } from './listTools';
import {
  appendOlderPage, DEFAULT_REFRESH_SEC, feedEventText, type FeedState, locationText, mergeFeedPage,
  REFRESH_OPTIONS,
  SHIPMENT_COLUMNS, SHIPMENT_PRIMARY_COL, SHIPMENT_STATUSES, shipmentCellText,
  shipmentMoveOptions, shipmentSortValue, shipmentTrucks, trucksMapQuery, trucksFeedQuery,
} from './shipments';

function ev(over: Partial<TruckFeedEvent>): TruckFeedEvent {
  return {
    id: 'loc:1', at: '2026-10-10T12:00:00Z', kind: 'location',
    truck_id: 't1', truck_name: 'Truck 1', load_number: 'L-1',
    initiative_id: 'i1', initiative_name: 'Denver move', actor_name: null,
    location: null, lat: null, lng: null, address: null, source: null,
    from_status: null, from_label: null, from_color: null,
    to_status: null, to_label: null, to_color: null,
    via: null, container_id: null, container_name: null, asset_count: null,
    from_truck: null, device: null,
    ...over,
  };
}

function truck(over: Partial<TruckItem>): TruckItem {
  return {
    id: 't1', legacy_id: null, name: 'Truck 1',
    driver_name: null, co_driver_name: null, team_drive: false, contact_info: '',
    status: 'in_transit', status_label: 'In transit', status_color: '#2f6fed',
    load_number: 'L-1', seal_id: null, tracking_type: {},
    initiative_id: 'i1', initiative_name: 'Denver move',
    start_site_id: 's1', start_site_name: 'DC-East',
    end_site_id: 's2', end_site_name: 'DC-West',
    container_count: 2, last_update: null, archived_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

describe('refresh options', () => {
  it('offers Off / 15 s / 30 s / 60 s / 5 min and defaults to 30 s', () => {
    expect(REFRESH_OPTIONS.map((o) => [o.label, o.seconds])).toEqual([
      ['Off', 0], ['15 s', 15], ['30 s', 30], ['60 s', 60], ['5 min', 300],
    ]);
    expect(DEFAULT_REFRESH_SEC).toBe(30);
  });
});

describe('query strings', () => {
  it('map asks for the current trip of the three live statuses, optionally one move', () => {
    expect(trucksMapQuery(null)).toBe('trip=true&statuses=active,in_transit,at_destination');
    expect(trucksMapQuery('abc')).toBe(
      'trip=true&statuses=active,in_transit,at_destination&initiative_id=abc');
    expect(SHIPMENT_STATUSES).toEqual(['active', 'in_transit', 'at_destination']);
  });

  it('feed passes the cursor back verbatim, URL-encoded', () => {
    expect(trucksFeedQuery({ initiativeId: null, limit: 50 })).toBe('limit=50');
    expect(trucksFeedQuery({
      initiativeId: 'i1', limit: 50, before: '2026-10-10T12:00:00.000000Z~audit:x:load:y',
    })).toBe('limit=50&initiative_id=i1&before=2026-10-10T12%3A00%3A00.000000Z~audit%3Ax%3Aload%3Ay');
  });
});

describe('feedEventText', () => {
  it('location: address and source, falling back to the raw location then lat, lng', () => {
    expect(feedEventText(ev({ address: 'Newark, NJ', source: 'manual' }))).toBe('Newark, NJ · manual');
    expect(feedEventText(ev({ location: '40.7, -73.9', source: 'seed' }))).toBe('40.7, -73.9 · seed');
    expect(feedEventText(ev({ lat: 40.7, lng: -73.9 }))).toBe('40.7, -73.9');
    expect(locationText(ev({}))).toBe('Location reported');
  });

  it('status: from → to by actor', () => {
    const e = ev({ kind: 'status', from_label: 'Active', to_label: 'In transit', actor_name: 'Ada' });
    expect(feedEventText(e)).toBe('Active → In transit by Ada');
    expect(feedEventText({ ...e, actor_name: null })).toBe('Active → In transit');
    expect(feedEventText({ ...e, from_label: null, from_status: null })).toBe('— → In transit by Ada');
  });

  it('load: container, asset count and how it was loaded', () => {
    const e = ev({ kind: 'load', container_name: 'Crate 7', asset_count: 12, via: 'kiosk' });
    expect(feedEventText(e)).toBe('Loaded Crate 7 (12 assets) · kiosk');
    expect(feedEventText({ ...e, asset_count: 1 })).toBe('Loaded Crate 7 (1 asset) · kiosk');
    expect(feedEventText({ ...e, asset_count: null, via: 'import' })).toBe('Loaded Crate 7 · import');
    expect(feedEventText({ ...e, container_name: null, via: 'portal' }))
      .toBe('Loaded a removed container (12 assets) · portal');
  });

  it('unload: container and how it was unloaded', () => {
    const e = ev({ kind: 'unload', container_name: 'Crate 7', via: 'portal' });
    expect(feedEventText(e)).toBe('Unloaded Crate 7 · portal');
    expect(feedEventText({ ...e, via: null })).toBe('Unloaded Crate 7');
  });
});

describe('feed paging', () => {
  const older: FeedState = {
    events: [
      ev({ id: 'b', at: '2026-10-10T11:00:00Z' }),
      ev({ id: 'a', at: '2026-10-10T10:00:00Z' }),
    ],
    nextBefore: 'cursor-a',
  };
  const page = (events: TruckFeedEvent[], next: string | null = 'cursor-new') =>
    ({ events, next_before: next });

  it('first page: takes the events and the cursor as given', () => {
    expect(mergeFeedPage(null, page([ev({ id: 'x' })]))).toEqual({
      events: [ev({ id: 'x' })], nextBefore: 'cursor-new',
    });
  });

  it('refresh prepends unseen events and keeps every older page already loaded', () => {
    const out = mergeFeedPage(older, page([
      ev({ id: 'c', at: '2026-10-10T12:00:00Z' }),
      ev({ id: 'b', at: '2026-10-10T11:00:00Z' }),
    ]));
    expect(out.events.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(out.nextBefore).toBe('cursor-a'); // Show older still continues from the oldest page
  });

  it('keeps newest-first order (at, then id descending) when a backdated event arrives', () => {
    const out = mergeFeedPage(older, page([
      ev({ id: 'c', at: '2026-10-10T12:00:00Z' }),
      ev({ id: 'b', at: '2026-10-10T11:00:00Z' }),
      ev({ id: 'z', at: '2026-10-10T10:00:00Z' }),
    ]));
    expect(out.events.map((e) => e.id)).toEqual(['c', 'b', 'z', 'a']);
  });

  it('a fresh page that shares nothing with a longer feed replaces it (no silent gap)', () => {
    const out = mergeFeedPage(older, page([ev({ id: 'x', at: '2026-10-10T13:00:00Z' })], 'cursor-x'));
    expect(out).toEqual({ events: [ev({ id: 'x', at: '2026-10-10T13:00:00Z' })], nextBefore: 'cursor-x' });
  });

  it('no gap when the fresh page is the whole feed, or nothing was loaded yet', () => {
    const fresh = ev({ id: 'x', at: '2026-10-10T13:00:00Z' });
    expect(mergeFeedPage(older, page([fresh], null)).events.map((e) => e.id)).toEqual(['x', 'b', 'a']);
    const empty: FeedState = { events: [], nextBefore: null };
    expect(mergeFeedPage(empty, page([fresh]))).toEqual({ events: [fresh], nextBefore: 'cursor-new' });
  });

  it('Show older appends the next page and moves the cursor', () => {
    const out = appendOlderPage(older, 'cursor-a', page([
      ev({ id: 'a', at: '2026-10-10T10:00:00Z' }), // overlap is dropped
      ev({ id: 'z0', at: '2026-10-10T09:00:00Z' }),
    ], null));
    expect(out!.events.map((e) => e.id)).toEqual(['b', 'a', 'z0']);
    expect(out!.nextBefore).toBeNull();
  });

  it('Show older is ignored when the feed was replaced while it was loading', () => {
    const replaced: FeedState = { events: [ev({ id: 'x' })], nextBefore: 'cursor-x' };
    expect(appendOlderPage(replaced, 'cursor-a', page([ev({ id: 'z0' })]))).toBe(replaced);
  });
});

describe('trucks table', () => {
  const rows = [
    truck({ id: 't1', name: 'Truck 10', status: 'in_transit' }),
    truck({ id: 't2', name: 'Truck 2', status: 'active', initiative_id: 'i2', initiative_name: 'Austin move' }),
    truck({ id: 't3', name: 'Truck 3', status: 'historical' }),
    truck({ id: 't4', name: 'Truck 4', status: 'at_destination', archived_at: '2026-10-02T00:00:00Z' }),
    truck({ id: 't5', name: 'Truck 5', status: 'created' }),
    truck({ id: 't6', name: 'Truck 6', status: 'at_destination', initiative_id: null, initiative_name: null }),
  ];

  it('keeps non-archived trucks in the three live statuses, optionally one move', () => {
    expect(shipmentTrucks(rows, null).map((t) => t.id)).toEqual(['t1', 't2', 't6']);
    expect(shipmentTrucks(rows, 'i2').map((t) => t.id)).toEqual(['t2']);
  });

  it('move options: All moves first, then each move with a non-archived truck, naturally sorted', () => {
    expect(shipmentMoveOptions(rows, null)).toEqual([
      { value: '', label: 'All moves' },
      { value: 'i2', label: 'Austin move' },
      { value: 'i1', label: 'Denver move' },
    ]);
    // archived moves (known from the initiatives list) drop out
    expect(shipmentMoveOptions(rows, new Set(['i1'])).map((o) => o.value)).toEqual(['', 'i2']);
  });

  it('cell text and sort values', () => {
    const t = truck({
      container_count: 3,
      last_update: { recorded_at: '2026-10-10T00:00:00Z', lat: 1, lng: 2, approximate_address: '' },
    });
    expect(shipmentCellText(t, 'primary')).toBe('Truck 1');
    expect(shipmentCellText(t, 'load')).toBe('L-1');
    expect(shipmentCellText(t, 'route')).toBe('DC-East → DC-West');
    expect(shipmentCellText(t, 'location')).toBe('1, 2');
    expect(shipmentCellText(truck({ last_update: null }), 'location')).toBe('—');
    expect(shipmentCellText(t, 'containers')).toBe('3');
    expect(shipmentSortValue(t, 'containers')).toBe(3);
    expect(shipmentSortValue(t, 'last_update')).toBe('2026-10-10T00:00:00Z');
  });

  it('default columns fit a dashboard panel', () => {
    const { minWidth } = listGridStyle([SHIPMENT_PRIMARY_COL, ...SHIPMENT_COLUMNS]);
    expect(minWidth).toBeLessThanOrEqual(LIST_FIT.dashPanel);
    expect(SHIPMENT_COLUMNS.map((c) => c.label)).toEqual([
      'Status', 'Load #', 'Route', 'Last location', 'Last update', 'Containers',
    ]);
  });
});
