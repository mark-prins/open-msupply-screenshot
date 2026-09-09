/**
 * Browser session: launch, log in, resolve a store, switch language.
 *
 * All of this targets the new Open mSupply web client, which:
 *   - scopes every route under the store id: /{storeId}/distribution/...
 *   - keeps the language picker in Settings > Display settings
 *   - renders modals as native <dialog> and dropdowns as [role="menu"]
 */

import { chromium } from 'playwright';

/** Locales the documentation is published in. */
export const DOC_LANGUAGES = ['en', 'fr', 'es', 'pt'];

/** Right-to-left locales the client offers; layout mirrors in these. */
export const RTL_LANGUAGES = new Set(['ar', 'prs', 'ps']);

const SETTLE_MS = 400;

export async function launch({ headed = false, viewport, deviceScaleFactor }) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    reducedMotion: 'reduce',
    // The client renders dates and relative times; pin them so captures of the
    // same screen are byte-comparable between runs.
    locale: 'en-GB',
    timezoneId: 'Pacific/Auckland',
  });
  const page = await context.newPage();
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition-duration: 0s !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  }).catch(() => {}); // no document yet on a fresh context; re-applied per navigation
  return { browser, context, page };
}

/**
 * Log in. Credentials come from the environment, never from config on disk.
 *
 * The login form has no test ids, so this uses accessible locators. If test ids
 * are added to the client later, prefer them.
 */
export async function login(page, { baseUrl, username, password }) {
  if (!username || !password) {
    throw new Error(
      'Missing credentials. Set OMS_USERNAME and OMS_PASSWORD in the environment.'
    );
  }
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // Already signed in? The client bounces straight to store resolution.
  if (await isAuthenticated(page)) return;

  const user = page.getByLabel(/username/i).or(page.locator('input[name="username"]')).first();
  const pass = page.getByLabel(/password/i).or(page.locator('input[type="password"]')).first();
  await user.waitFor({ state: 'visible', timeout: 15000 });
  await user.fill(username);
  await pass.fill(password);
  await page.getByRole('button', { name: /log ?in/i }).click();

  await page.waitForURL((url) => !/\/login\b/.test(url.pathname), { timeout: 20000 });
}

async function isAuthenticated(page) {
  const onLogin = await page
    .getByRole('button', { name: /log ?in/i })
    .isVisible()
    .catch(() => false);
  return !onLogin;
}

/**
 * Pick a store and return its id. The id is the first path segment of every
 * subsequent route, so callers cache it.
 *
 * @param storeCode e.g. "STR-BDR-HCC". Omit to take the default/first store.
 */
export async function resolveStore(page, { baseUrl, storeCode }) {
  await page.goto(`${baseUrl}/resolve-store`, { waitUntil: 'domcontentloaded' });

  const option = storeCode
    ? page.locator(`[data-testid="store-select-option-${storeCode}"]`)
    : page.locator('[data-testid^="store-select-option-"]').first();

  await option.waitFor({ state: 'visible', timeout: 15000 });
  await option.click();

  await page.waitForURL(/\/[0-9A-F]{32}(\/|$)/i, { timeout: 20000 });
  const storeId = new URL(page.url()).pathname.split('/')[1];
  if (!storeId) throw new Error('Could not determine the store id after selecting a store.');
  return storeId;
}

/** List the stores offered on the resolve-store screen, for `list-stores`. */
export async function listStores(page, { baseUrl }) {
  await page.goto(`${baseUrl}/resolve-store`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid^="store-select-option-"]').first().waitFor({ timeout: 15000 });
  return page.locator('[data-testid^="store-select-option-"]').evaluateAll((els) =>
    els.map((el) => ({
      code: el.getAttribute('data-testid').replace('store-select-option-', ''),
      label: el.innerText.split('\n')[0].trim(),
    }))
  );
}

/**
 * Switch the interface language.
 *
 * Lives in Settings > Display settings. Options are
 * [data-testid="settings-language-option-<code>"] for
 * ar, prs, en, es, fr, fr-DJ, ps, pt, ru, tet.
 */
export async function setLanguage(page, { baseUrl, storeId, language }) {
  await page.goto(`${baseUrl}/${storeId}/settings`, { waitUntil: 'domcontentloaded' });

  const trigger = page.locator('[data-testid="settings-language"]');
  if (!(await trigger.isVisible().catch(() => false))) {
    await page.locator('[data-testid="accordion-trigger-display-settings"]').click();
    await trigger.waitFor({ state: 'visible', timeout: 10000 });
  }

  const current = await trigger
    .locator('xpath=ancestor::*[1]')
    .evaluate(() => document.querySelector('[data-testid^="settings-language-option-"][data-current="true"]')?.getAttribute('data-testid'))
    .catch(() => null);
  if (current === `settings-language-option-${language}`) return;

  await trigger.click();
  const option = page.locator(`[data-testid="settings-language-option-${language}"]`);
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click();
  await page.waitForTimeout(SETTLE_MS);
}

/** Navigate to a store-scoped route and wait for it to settle. */
export async function gotoRoute(page, { baseUrl, storeId, route, settleMs = SETTLE_MS }) {
  const path = route.replace(/^\/+/, '');
  const url = path ? `${baseUrl}/${storeId}/${path}` : `${baseUrl}/${storeId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(settleMs);
  return url;
}

/**
 * Dismiss anything overlaying the screen that the shot did not ask for.
 *
 * Three of these show up on the demo servers in practice:
 *   - the unexpected-error modal, thrown when a background sync fails
 *   - the "A new version is available" stale-bundle modal, which appears as
 *     soon as the server is redeployed mid-run
 *   - toasts left over from a previous step
 */
export async function clearOverlays(page) {
  await page.locator('[data-testid="unexpected-error-close"]').click({ timeout: 800 }).catch(() => {});
  await page.getByRole('button', { name: /refresh|reload|dismiss/i }).first()
    .click({ timeout: 800 }).catch(() => {});
  await page.locator('[role="alert"] button[aria-label*="close" i]').first()
    .click({ timeout: 800 }).catch(() => {});

  // Anything still modal that the shot did not open itself.
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach((d) => {
      const stale = /version|unexpected|error/i.test(d.innerText || '');
      if (stale) try { d.close(); } catch {}
    });
  }).catch(() => {});
}
