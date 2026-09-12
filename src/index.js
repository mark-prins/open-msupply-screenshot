#!/usr/bin/env node
/**
 * open-msupply-screenshot
 *
 * Captures documentation screenshots from a running Open mSupply web client
 * (the new UI), in every language the docs are published in, cropped to the
 * region of the screen the documentation actually shows, with arrows and
 * callouts drawn on.
 *
 *   yarn shoot                        every shot, every language
 *   yarn shoot --lang en              English only
 *   yarn shoot --only outbound        shots whose id contains "outbound"
 *   yarn shoot --tag replenishment    shots carrying a tag
 *   yarn shoot --headed               watch it run
 *   yarn shoot --in-place             write over the files in the docs repo
 *   yarn stores                       list store codes on the server
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { launch, login, resolveStore, listStores, setLanguage, gotoRoute, clearOverlays, DOC_LANGUAGES } from './session.js';
import { REGIONS, SKIP_REGIONS, resolveClip } from './regions.js';
import { runSteps, openFirstRow } from './steps.js';
import { capture, outputPath, DEFAULT_MASKS } from './capture.js';
import { drawAnnotations, clearAnnotations } from './annotate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { lang: null, only: null, tag: null, headed: false, inPlace: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') args.headed = true;
    else if (a === '--in-place') args.inPlace = true;
    else if (a === '--list') args.list = true;
    else if (a === '--lang') args.lang = argv[++i];
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--config') args.config = argv[++i];
  }
  return args;
}

async function loadConfig(file) {
  const raw = await fs.readFile(file, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.baseUrl = process.env.OMS_URL || cfg.baseUrl;
  cfg.username = process.env.OMS_USERNAME;
  cfg.password = process.env.OMS_PASSWORD;
  return cfg;
}

/**
 * Load every *.yaml under shots/, including shots/generated/ - the importer
 * writes there and those shots are usable as soon as they need no `clip`.
 */
async function loadShots(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const shots = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      shots.push(...(await loadShots(full, base)));
      continue;
    }
    if (!/\.ya?ml$/.test(entry.name) || entry.name.startsWith('_')) continue;
    const doc = YAML.parse(await fs.readFile(full, 'utf8'));
    for (const shot of doc.shots ?? []) {
      shots.push({ ...doc.defaults, ...shot, source: path.relative(base, full) });
    }
  }
  return shots;
}

/**
 * A hand-written shot in shots/ overrides the importer's stub of the same id
 * in shots/generated/. Without this, "promoting" a shot leaves both copies
 * loaded and the stub keeps being reported as pending forever.
 */
function dedupe(shots) {
  const byId = new Map();
  for (const shot of shots) {
    const generated = shot.source.startsWith('generated');
    const existing = byId.get(shot.id);
    if (!existing || (existing.source.startsWith('generated') && !generated)) {
      byId.set(shot.id, shot);
    }
  }
  return [...byId.values()];
}

/** A shot the importer left for a human: `clip: "TODO # ..."`. */
function pendingReview(shot) {
  const todo = (v) => typeof v === 'string' && v.trimStart().startsWith('TODO');
  if (todo(shot.clip)) return 'needs a clip selector';
  if (todo(shot.annotate)) return 'needs annotation coordinates';
  if (shot.annotate != null && !Array.isArray(shot.annotate)) return 'annotate must be a list';
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(args.config ?? path.join(ROOT, 'config.json'));
  const outDir = args.outDir ?? path.join(ROOT, 'images');
  const languages = args.lang ? [args.lang] : cfg.languages ?? DOC_LANGUAGES;

  const all = dedupe(await loadShots(path.join(ROOT, 'shots')));
  let shots = all;
  if (args.only) shots = shots.filter((s) => s.id.includes(args.only) || s.source.includes(args.only));
  if (args.tag) shots = shots.filter((s) => (s.tags ?? []).includes(args.tag));

  const matched = shots.length;
  const skipped = shots.filter((s) => SKIP_REGIONS.has(s.region) || s.capture === 'manual');
  shots = shots.filter((s) => !SKIP_REGIONS.has(s.region) && s.capture !== 'manual');

  const pending = shots.map((s) => [s, pendingReview(s)]).filter(([, r]) => r);
  shots = shots.filter((s) => !pendingReview(s));

  if (args.list) {
    for (const s of shots) console.log(`${s.id.padEnd(44)} ${s.region.padEnd(14)} ${s.route}`);
    console.log(
      `\n${shots.length} ready, ${pending.length} pending review, ` +
        `${skipped.length} skipped (not a web-client screen)`
    );
    if (pending.length) {
      console.log('\nPending review:');
      for (const [s, reason] of pending.slice(0, 20)) {
        console.log(`  ${s.id.padEnd(44)} ${reason}`);
      }
      if (pending.length > 20) console.log(`  ... and ${pending.length - 20} more`);
    }
    return;
  }

  // Fail fast and clearly rather than launching a browser and logging in to
  // discover there is nothing to do.
  if (!matched) {
    const filter = args.only ? `--only ${args.only}` : args.tag ? `--tag ${args.tag}` : 'no filter';
    console.error(`No shots matched (${filter}). ${all.length} shots are defined; try \`yarn shot-list\`.`);
    process.exitCode = 1;
    return;
  }
  if (!shots.length) {
    console.error(
      `All ${matched} matching shots are unavailable: ` +
        `${pending.length} pending review, ${skipped.length} not a web-client screen.`
    );
    if (pending.length) {
      console.error('\nPending review:');
      for (const [s, reason] of pending) console.error(`  ${s.id.padEnd(44)} ${reason}`);
      console.error('\nFill in the TODO fields in shots/generated/, or promote them into shots/.');
    }
    process.exitCode = 1;
    return;
  }

  if (!cfg.username || !cfg.password) {
    console.error(
      'Missing credentials. Set them in the environment before running:\n' +
        '  export OMS_USERNAME=Documentation\n' +
        '  export OMS_PASSWORD=...\n' +
        `  export OMS_URL=${cfg.baseUrl}   # optional, overrides config.json`
    );
    process.exitCode = 1;
    return;
  }

  const { browser, context, page } = await launch({
    headed: args.headed,
    viewport: cfg.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: cfg.deviceScaleFactor ?? 2,
  });

  const results = { ok: 0, failed: [], skipped: skipped.length };

  try {
    // A shot names the server it needs ("remote" by default, "central" for
    // /manage/*, /programs/* and purchase orders) and optionally a store code
    // (/dispensary/* needs a dispensary-mode store). Both are resolved lazily
    // and cached: cookies are per-origin, so logging in to both servers in one
    // context lets us switch between them freely.
    const serverUrl = (name) => {
      const url = name === 'central' ? cfg.centralUrl : cfg.baseUrl;
      if (!url) {
        throw new Error(
          `This shot needs the "${name}" server but config.json has no ` +
            `${name === 'central' ? 'centralUrl' : 'baseUrl'}.`
        );
      }
      return url;
    };
    const loggedIn = new Set();
    const useServer = async (name) => {
      const baseUrl = serverUrl(name);
      if (!loggedIn.has(name)) {
        await login(page, { ...cfg, baseUrl });
        loggedIn.add(name);
      }
      return baseUrl;
    };

    const storeIds = new Map();
    const storeFor = async (server, code) => {
      const key = `${server}:${code ?? '__default__'}`;
      if (!storeIds.has(key)) {
        const baseUrl = await useServer(server);
        storeIds.set(key, await resolveStore(page, { ...cfg, baseUrl, storeCode: code }));
      }
      return storeIds.get(key);
    };

    for (const language of languages) {
      const first = shots[0];
      const firstServer = first?.server ?? 'remote';
      const firstStore = await storeFor(firstServer, first?.store);
      await setLanguage(page, { ...cfg, baseUrl: serverUrl(firstServer), storeId: firstStore, language });

      for (const shot of shots) {
        const label = `${shot.id} [${language}]`;
        try {
          const server = shot.server ?? 'remote';
          const baseUrl = await useServer(server);
          const storeId = await storeFor(server, shot.store);
          await gotoRoute(page, { ...cfg, baseUrl, storeId, route: shot.route });
          await clearOverlays(page);

          if (shot.openFirstRow) await openFirstRow(page);
          if (shot.steps) await runSteps(page, shot.steps);

          if (Array.isArray(shot.annotate)) {
            await drawAnnotations(page, shot.annotate, cfg.annotationStyle);
          }

          const outFile = outputPath({
            outDir,
            shot,
            language,
            inPlace: args.inPlace,
            docsRoot: cfg.docsRoot ? path.resolve(ROOT, cfg.docsRoot) : ROOT,
          });

          await capture(page, {
            outFile,
            clipSelector: resolveClip(shot),
            region: shot.region,
            pad: shot.pad ?? (Array.isArray(shot.annotate) ? 24 : 0),
            masks: shot.masks ?? (shot.noMask ? [] : DEFAULT_MASKS),
            fullPage: shot.fullPage ?? false,
          });

          await clearAnnotations(page);
          results.ok++;
          console.log(`  ok   ${label} -> ${path.relative(ROOT, outFile)}`);
        } catch (err) {
          await clearAnnotations(page).catch(() => {});
          results.failed.push({ label, error: err.message });
          console.log(`  FAIL ${label}: ${err.message}`);
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(
    `\n${results.ok} captured, ${results.failed.length} failed, ${results.skipped} skipped.`
  );
  if (results.failed.length) process.exitCode = 1;
}

async function stores() {
  const cfg = await loadConfig(path.join(ROOT, 'config.json'));
  const { browser, context, page } = await launch({
    headed: false,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await login(page, cfg);
    for (const s of await listStores(page, cfg)) console.log(`${s.code.padEnd(16)} ${s.label}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

const command = process.argv[2] === 'stores' ? stores : main;
command().catch((err) => {
  console.error(err);
  process.exit(1);
});
