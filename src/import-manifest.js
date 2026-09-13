#!/usr/bin/env node
/**
 * Turn the documentation screenshot catalogue into shot stubs.
 *
 *   node src/import-manifest.js ../msupply_docs/screenshots/manifest.yaml
 *
 * The catalogue in msupply_docs/screenshots/manifest.yaml already records, for
 * all 734 images, which route the screenshot came from and which region of the
 * screen it shows. That is most of a shot definition. What it cannot know is
 * the interaction needed to reach the state (open this dialog, tick two rows)
 * or where the arrows point - so those come out as TODO comments for a human.
 *
 * Existing files in shots/ are never overwritten; the importer writes
 * shots/generated/ and you promote entries as you verify them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CENTRAL_PREFIXES = ['/manage/', '/programs/', '/catalogue/assets/log-reasons'];
const CENTRAL_EXACT = ['/replenishment/purchase-order', '/replenishment/inbound-shipment-external'];
const DISPENSARY_PREFIX = '/dispensary/';

const STORES = { remote: 'STR-BDR-DST', dispensary: 'STR-BDR-HCC' };

/** Regions that always need a hand-written `clip`. */
const NEEDS_CLIP = new Set(['nav-part', 'panel-part', 'modal-part', 'control', 'content-part']);

/** Routes that are not reachable in the web client at all. */
const NOT_A_ROUTE = new Set(['*', '-', 'dashboard', 'android']);

/** Top-level nav sections, i.e. the `data-testid="nav-<section>"` buttons in the drawer. */
const NAV_SECTIONS = new Set([
  'dashboard', 'replenishment', 'inventory', 'distribution', 'dispensary',
  'cold-chain', 'programs', 'reports', 'catalogue', 'manage', 'settings', 'help',
]);

/**
 * Every annotated `nav` shot in the catalogue is "Nav drawer, Section > Item"
 * with an arrow at the item for the shot's own route - so the annotation is
 * derivable, not something a human has to place.
 *
 * Leaf items carry no test id, but the one for the current route is marked
 * `data-selected="true"`, and the drawer auto-expands its section on that
 * route. Top-level sections (Settings, Reports) are their own button and do
 * have a test id. Routes that are not in the drawer at all (`sync` moved to
 * the footer) return null and stay TODO.
 */
function navAnnotation(route) {
  const [section, ...rest] = route.split('/');
  if (!NAV_SECTIONS.has(section)) return null;
  const to = rest.length
    ? '[data-testid="drawer"] button[data-selected="true"]'
    : `[data-testid="nav-${section}"]`;
  return [{ type: 'arrow', to, from: 'above-right', length: 100 }];
}

/**
 * Which server and store a route needs.
 *
 * The central-only routes are not a different STORE, they are a different
 * SERVER - on a remote site they redirect to the Dashboard. The central
 * server offers one store, so no code is needed there.
 */
function classify(route) {
  if (NOT_A_ROUTE.has(route)) return { skip: true };
  if (route.startsWith(DISPENSARY_PREFIX)) return { server: 'remote', store: STORES.dispensary };
  if (CENTRAL_EXACT.some((r) => route.startsWith(r))) return { server: 'central' };
  if (CENTRAL_PREFIXES.some((p) => route.startsWith(p))) return { server: 'central' };
  return { server: 'remote', store: STORES.remote };
}

/** "/distribution/outbound-shipment/{id}" -> {route, openFirstRow} */
function normaliseRoute(route) {
  const openFirstRow = /\/\{[a-zA-Z]+\}$/.test(route);
  const base = route.replace(/\/\{[a-zA-Z]+\}$/, '').replace(/^\//, '');
  return { route: base, openFirstRow };
}

function groupOf(route) {
  const seg = route.replace(/^\//, '').split('/')[0];
  return seg || 'misc';
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: node src/import-manifest.js <path to manifest.yaml>');
    process.exit(1);
  }
  const manifest = YAML.parse(await fs.readFile(manifestPath, 'utf8'));
  const outDir = path.join(ROOT, 'shots', 'generated');
  await fs.mkdir(outDir, { recursive: true });

  const groups = new Map();
  let skipped = 0;
  let derivedNav = 0;

  for (const s of manifest.shots) {
    const cls = classify(s.route);
    if (cls.skip || s.capture === 'manual') {
      skipped++;
      continue;
    }
    const { route, openFirstRow } = normaliseRoute(s.route);
    const shot = {
      id: s.id,
      file: s.file,
      route,
      region: s.region,
    };
    if (cls.server && cls.server !== 'remote') shot.server = cls.server;
    if (cls.store) shot.store = cls.store;
    if (openFirstRow) shot.openFirstRow = true;
    if (NEEDS_CLIP.has(s.region)) shot.clip = `TODO # ${s.description}`;
    if (s.annotated) {
      const derived = s.region === 'nav' ? navAnnotation(route) : null;
      if (derived) {
        shot.annotate = derived;
        derivedNav++;
      } else {
        shot.annotate = `TODO # ${s.description}`;
      }
    }
    shot['#'] = s.description;

    const g = groupOf(s.route);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(shot);
  }

  let written = 0;
  for (const [group, shots] of groups) {
    const lines = [
      `# Generated from ${path.basename(manifestPath)}. Review before use.`,
      '#',
      '# Each shot carries the route and region from the catalogue. Two things',
      '# still need a human:',
      '#   clip:     which element, for content-part / modal-part / control shots',
      '#   annotate: where the arrows and callouts go - open the current image',
      '#             in the docs repo and copy what is drawn on it',
      '',
      YAML.stringify({ defaults: { tags: [group] }, shots }, { lineWidth: 100 }),
    ];
    await fs.writeFile(path.join(outDir, `${group}.yaml`), lines.join('\n'));
    written += shots.length;
  }

  const needClip = [...groups.values()].flat().filter((s) => typeof s.clip === 'string').length;
  const needAnnotate = [...groups.values()].flat().filter((s) => typeof s.annotate === 'string').length;

  console.log(`Wrote ${written} shots across ${groups.size} files in shots/generated/`);
  console.log(`  ${skipped} skipped (not a web-client screen)`);
  console.log(`  ${needClip} need a clip selector`);
  console.log(`  ${needAnnotate} need annotation coordinates`);
  console.log(`  ${derivedNav} nav-drawer annotations derived automatically`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
