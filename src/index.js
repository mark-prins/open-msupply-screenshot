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

async function loadShots(dir) {
  const files = (await fs.readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  const shots = [];
  for (const f of files) {
    const doc = YAML.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    for (const shot of doc.shots ?? []) {
      shots.push({ ...doc.defaults, ...shot, source: f });
    }
  }
  return shots;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(args.config ?? path.join(ROOT, 'config.json'));
  const outDir = args.outDir ?? path.join(ROOT, 'images');
  const languages = args.lang ? [args.lang] : cfg.languages ?? DOC_LANGUAGES;

  let shots = await loadShots(path.join(ROOT, 'shots'));
  if (args.only) shots = shots.filter((s) => s.id.includes(args.only));
  if (args.tag) shots = shots.filter((s) => (s.tags ?? []).includes(args.tag));

  const skipped = shots.filter((s) => SKIP_REGIONS.has(s.region) || s.capture === 'manual');
  shots = shots.filter((s) => !SKIP_REGIONS.has(s.region) && s.capture !== 'manual');

  if (args.list) {
    for (const s of shots) console.log(`${s.id.padEnd(44)} ${s.region.padEnd(14)} ${s.route}`);
    console.log(`\n${shots.length} shots, ${skipped.length} skipped (not a web-client screen)`);
    return;
  }

  const { browser, context, page } = await launch({
    headed: args.headed,
    viewport: cfg.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: cfg.deviceScaleFactor ?? 2,
  });

  const results = { ok: 0, failed: [], skipped: skipped.length };

  try {
    await login(page, cfg);

    // Shots are grouped by the store they need: a dispensary store for
    // /dispensary/*, the central server for /manage/* and /programs/*.
    const storeIds = new Map();
    const storeFor = async (code) => {
      const key = code ?? '__default__';
      if (!storeIds.has(key)) storeIds.set(key, await resolveStore(page, { ...cfg, storeCode: code }));
      return storeIds.get(key);
    };

    for (const language of languages) {
      const firstStore = await storeFor(shots[0]?.store);
      await setLanguage(page, { ...cfg, storeId: firstStore, language });

      for (const shot of shots) {
        const label = `${shot.id} [${language}]`;
        try {
          const storeId = await storeFor(shot.store);
          await gotoRoute(page, { ...cfg, storeId, route: shot.route });
          await clearOverlays(page);

          if (shot.openFirstRow) await openFirstRow(page);
          if (shot.steps) await runSteps(page, shot.steps);

          if (shot.annotate) {
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
            pad: shot.pad ?? (shot.annotate ? 24 : 0),
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
