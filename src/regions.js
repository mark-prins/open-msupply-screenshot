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
    selector: 'header[class^="_header_"]',
    description: 'Breadcrumb, action buttons, detail toolbar and tab strip.',
  },

  /** The field row inside a detail header (Customer name, Customer reference). */
  'detail-header': {
    selector: 'div[class^="_toolbar_"]',
    description: 'Detail view field row.',
  },

  /** Tab strip of a detail view. Individual tabs are [data-testid^="tab-"]. */
  tab: {
    selector: 'div[class^="_list_158sc"]',
    description: 'Detail view tab strip.',
  },

  /**
   * Detail footer: hold toggle, status crumbs, status-change split button.
   * NOT the same element as the app footer - see `footer-app`.
   */
  footer: {
    selector: 'div[class^="_footer_mrv2s"]',
    description: 'Detail status bar (hold, status crumbs, confirm button).',
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
