/**
 * Region -> selector map for the Open mSupply web client (new UI).
 *
 * Verified by walking https://release-demo-open.msupply.org (remote site) and
 * :8888 (central server) at a 1440x900 viewport on 2026-09-10, client build
 * v0.0.368-rc0.
 *
 * CSS-module class names carry a per-build hash (`_header_csm0t_9`), so every
 * structural selector here prefix-matches (`[class^="_header_"]`). If a build
 * renames a module the prefix still holds; only the hash changes.
 *
 * Prefer `data-testid` wherever the client exposes one - those are stable.
 */

export const REGIONS = {
  /** Whole browser window. No clip - the runner takes a viewport screenshot. */
  full: {
    selector: null,
    description: 'The whole app window: drawer + content + footer.',
  },

  /** Main content pane plus the app footer, drawer excluded. */
  content: {
    selector: 'div[class^="_main_"]:has(> div[class^="_content_"])',
    description: 'Content pane and app footer, navigation drawer excluded.',
  },

  /**
   * Top band of the content pane. In the new UI the breadcrumb, the action
   * buttons, the detail toolbar and the tab strip all live in one <header>,
   * so this is a single element rather than a union of several.
   */
  'content-top': {
    // Scoped to the page: `header[class^="_header_"]` alone also matches the
    // command palette's screen-reader-only header (`_header_a0a74 _srOnly`),
    // which sits earlier in the DOM inside a closed <dialog>, so `.first()`
    // picked a hidden element and the capture timed out. The page header is
    // the only <header> that is a direct child of the page's main column.
    selector: 'div[class^="_page_"] > div[class^="_main_"] > header',
    description: 'Breadcrumb and action buttons; on detail views also the field row and tab strip.',
    hint:
      'Does NOT include the table filter bar - in the new UI that sits below ' +
      'the header, in the body. Use `filter-bar` for it.',
  },

  /** The field row inside a detail header (Customer name, Customer reference). */
  'detail-header': {
    // Two `_toolbar_` modules exist: the detail field row (inside the page
    // header) and the table's filter toolbar (`_toolbar_txd3y`, in the body).
    // Scope to the header so a list page can never resolve to the wrong one.
    selector: 'div[class^="_page_"] > div[class^="_main_"] > header div[class^="_toolbar_"]',
    description: 'Detail view field row.',
    hint:
      'Only exists on DETAIL views (an opened record). On a list page there is ' +
      'no field row - for the search/filter bar above a table use `filter-bar`.',
  },

  /**
   * The filter/search bar that sits above a table - "Add filter", the active
   * filter chips, the search box. In the old UI this lived in the header band;
   * in the new UI it is the first child of the table root, in the body, so it
   * is NOT part of `content-top`. Anchored on the filters menu button, which
   * every filterable table carries.
   */
  'filter-bar': {
    selector: 'div[class^="_toolbar_"]:has([data-testid="filters-menu"])',
    description: 'Search / filter bar above a table (list pages and detail line tables).',
  },

  /** Tab strip of a detail view. Individual tabs are [data-testid^="tab-"]. */
  tab: {
    // Identify the strip by what it contains rather than by a build hash:
    // the tabs themselves carry [data-testid="tab-*"] and are direct children.
    selector: 'div[class^="_list_"]:has(> [data-testid^="tab-"])',
    description: 'Detail view tab strip.',
    hint: 'Only exists on DETAIL views. Set `openFirstRow: true` on a list route.',
  },

  /**
   * Detail footer: hold toggle, status crumbs, status-change split button.
   * NOT the same element as the app footer - see `footer-app`.
   */
  footer: {
    // Same idea: the detail footer is the one that contains the status crumbs.
    // The app footer is a <footer> element with its own test id, so it can't
    // match `div[class^="_footer_"]` either way.
    selector: 'div[class^="_footer_"]:has([data-testid="status-crumbs"])',
    description: 'Detail status bar (hold, status crumbs, confirm button).',
    hint:
      'Only exists on DETAIL views. For the purple store/user/sync bar at the ' +
      'very bottom use `footer-app`.',
  },

  /** App footer: store selector, user menu, central-server chip, sync. */
  'footer-app': {
    selector: '[data-testid="app-footer"]',
    description: 'Application footer bar.',
  },

  nav: {
    selector: '[data-testid="drawer"]',
    description: 'Navigation drawer.',
  },

  'nav-part': {
    selector: null, // caller supplies e.g. [data-testid="nav-distribution"]
    description: 'A single navigation item. Supply `clip` per shot.',
  },

  /** Right-hand detail panel. Open it first with `openDetailPanel: true`. */
  panel: {
    selector: '[data-testid="detail-panel"]',
    description: 'Right-hand detail panel.',
    hint: 'Closed by default - add a step `- openDetailPanel: true`.',
  },

  'panel-part': {
    selector: null, // e.g. [data-testid="panel-section-additional-info"]
    description: 'One panel section. Supply `clip` per shot.',
  },

  /** Every modal in the new client is a native <dialog>. */
  modal: {
    selector: 'dialog[open]',
    description: 'An open dialog.',
  },

  'modal-part': {
    selector: null,
    description: 'A block inside a dialog. Supply `clip` per shot.',
  },

  /**
   * Dropdowns render as [role="menu"]; filter panels, the colour picker and
   * the nav flyout use the Popover API instead.
   */
  menu: {
    selector: '[role="menu"], [popover]:popover-open',
    description: 'An open dropdown menu or popover.',
  },

  /**
   * UNVERIFIED. No toast container exists in the DOM until one fires, and no
   * toast could be triggered during the walk. These are the candidates in
   * priority order - confirm against a real toast and then prune this list.
   */
  toast: {
    selector: '[role="alert"], [role="status"]:not([class*="_srOnly"]), [class*="toast" i], [class*="snack" i]',
    description: 'A snackbar or notification banner. Selector not yet confirmed.',
    unverified: true,
  },

  control: {
    selector: null,
    description: 'A single button or field. Supply `clip` per shot.',
  },
};

/** Regions that are never captured from the web client. */
export const SKIP_REGIONS = new Set(['icon', 'external']);

/** Resolve a shot to the selector to clip to, or null for a full capture. */
export function resolveClip(shot) {
  if (shot.clip) return shot.clip;
  const region = REGIONS[shot.region];
  if (!region) throw new Error(`Unknown region "${shot.region}" in shot "${shot.id}"`);
  return region.selector;
}
