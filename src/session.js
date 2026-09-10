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
  // Kill animations and the text caret on EVERY document.
  //
  // `page.addStyleTag` was wrong here: there is no document yet on a fresh
  // context, so it threw and was swallowed, and it would not have survived a
  // navigation anyway. An init script runs before each document loads.
  await context.addInitScript(() => {
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = `*, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }`;
      document.head?.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Log in. Credentials come from the environment, never from config on disk.
 *
 * Selectors confirmed against the live login page:
 *   [data-testid="login-username-input"]
 *   [data-testid="login-password-input"]
 *   [data-testid="login-button"]
 *
 * Accessible locators are kept as a fallback, but note that
 * `getByLabel(/password/i)` matches TWO elements - the field and the
 * show/hide-password toggle button next to it - so it must not be used alone.
 */
export async function login(page, { baseUrl, username, password }) {
  if (!username || !password) {
    throw new Error(
      'Missing credentials. Set OMS_USERNAME and OMS_PASSWORD in the environment.'
    );
  }
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const user = page
    .locator('[data-testid="login-username-input"], input[name="username"]')
    .first();
  const pass = page
    .locator('[data-testid="login-password-input"], input[type="password"]')
    .first();
  const submit = page.locator('[data-testid="login-button"]').or(
    page.getByRole('button', { name: /log ?in/i })
  ).first();
  const authed = page
    .locator('[data-testid="drawer"], [data-testid^="store-select-option-"]')
    .first();

  // Wait for the SPA to render EITHER the login form or an already-signed-in
  // view, and decide from whichever appears.
  //
  // Do not ask "is the login button missing?" - `isVisible()` reports the
  // current DOM without auto-waiting, and at `domcontentloaded` React has not
  // rendered anything yet. That read always came back "no login button", so
  // login concluded it was already signed in and returned without ever
  // filling the form; the failure then surfaced at /resolve-store.
  let state;
  try {
    state = await Promise.any([
      user.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'form'),
      authed.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'authenticated'),
    ]);
  } catch {
    throw new Error(
      `Neither a login form nor a signed-in view appeared at ${baseUrl} within 30s. ` +
        `Is the server up and is OMS_URL correct?`
    );
  }
  if (state === 'authenticated') return;

  await user.fill(username);
  await pass.fill(password);
  await submit.click();

  // Wait for a POSITIVE signal that we are in.
  //
  // Do not test the URL for "/login": the client serves the login page from
  // the ROOT path, so any "not on /login" predicate is already true while the
  // form is still on screen. That silently let the run continue unauthenticated
  // and the failure surfaced much later, as a timeout waiting for store
  // options on /resolve-store.
  try {
    await Promise.any([
      page.locator('[data-testid^="store-select-option-"]').first().waitFor({ state: 'visible', timeout: 30000 }),
      page.locator('[data-testid="drawer"]').waitFor({ state: 'visible', timeout: 30000 }),
      page.waitForURL(/\/[0-9A-F]{32}(\/|$)/i, { timeout: 30000 }),
    ]);
  } catch {
    const message = await readLoginError(page);
    throw new Error(
      `Login did not complete${message ? `: ${message}` : ''}.\n` +
        `  Check OMS_USERNAME and OMS_PASSWORD, and that OMS_URL points at the right server.\n` +
        `  Currently: OMS_URL=${baseUrl} OMS_USERNAME=${username}`
    );
  }
}

/** Surface "Invalid username or password" rather than a bare timeout. */
async function readLoginError(page) {
  for (const selector of ['[role="alert"]', '[class*="error" i]', '[class*="helper" i]']) {
    const text = await page.locator(selector).first().innerText().catch(() => null);
    if (text?.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 200);
  }
  return null;
}


/**
 * Pick a store and return its id. The id is the first path segment of every
 * subsequent route, so callers cache it.
 *
 * @param storeCode e.g. "STR-BDR-HCC". Omit to take the default/first store.
 */
export async function resolveStore(page, { baseUrl, storeCode }) {
  await page.goto(`${baseUrl}/resolve-store`, { waitUntil: 'domcontentloaded' });

  // If the user has ticked "Always open the store I pick", /resolve-store
  // redirects straight into that store and never renders the picker. Take the
  // id from the URL - unless a specific store was asked for, in which case we
  // still need the picker.
  if (!storeCode) {
    const redirected = await page
      .waitForURL(/\/[0-9A-F]{32}(\/|$)/i, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (redirected) return new URL(page.url()).pathname.split('/')[1];
  }

  const option = storeCode
    ? page.locator(`[data-testid="store-select-option-${storeCode}"]`)
    : page.locator('[data-testid^="store-select-option-"]').first();

  try {
    await option.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    // Two very different causes land here, so say which.
    if (await page.getByRole('button', { name: /log ?in/i }).isVisible().catch(() => false)) {
      throw new Error(
        `Bounced back to the login page at ${baseUrl}/resolve-store - the session is not authenticated.`
      );
    }
    const available = await listStoreCodes(page);
    throw new Error(
      storeCode
        ? `Store "${storeCode}" is not available to this user on ${baseUrl}.` +
          (available.length ? ` Available: ${available.join(', ')}` : ' No stores offered.')
        : `No stores offered to this user on ${baseUrl}.`
    );
  }
  await option.click();

  await page.waitForURL(/\/[0-9A-F]{32}(\/|$)/i, { timeout: 20000 });
  const storeId = new URL(page.url()).pathname.split('/')[1];
  if (!storeId) throw new Error('Could not determine the store id after selecting a store.');
  return storeId;
}

/** Codes currently on screen, without navigating. Used in error messages. */
async function listStoreCodes(page) {
  return page
    .locator('[data-testid^="store-select-option-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid').replace('store-select-option-', ''))
    )
    .catch(() => []);
}

/** List the stores offered on the resolve-store screen, for `yarn stores`. */
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
