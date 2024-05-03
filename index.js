import { Browser, By, Builder, until } from 'selenium-webdriver';
import { Options } from 'selenium-webdriver/chrome.js';
import config from './config.json' assert { type: 'json' };
import fs from 'fs';

const languages = ['en', 'fr', 'es', 'ru'];
const buildUrl = (path) => `${config.baseUrl}${path}`;
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

const dismissToast = async (driver) => {
  try {
    const snackbarButton = await driver.findElement(By.css('.notistack-Snackbar button'));
    await snackbarButton.click();
    await sleep(300);
  } catch (e) {
    console.log(`Unable to dismiss toast: ${e.message}`);
  }
};

const takeScreenshots = async (driver, filename) => {
  for (const language of languages) {
    let languageSelector = await driver.findElement(By.className('language-selector'));
    await languageSelector.click();
    await sleep(300);
    const languageButton = await driver.findElement(By.name(language));
    const isEnabled = await languageButton.isEnabled();
    if (isEnabled) {
      await languageButton.click();
      await sleep(500);
      await dismissToast(driver);
    }

    await driver.takeScreenshot().then((data) => {
      const file = `./images/${filename}.${language}.png`;
      console.log(`Saving screenshot to ${file}`);
      fs.writeFileSync(file, data, 'base64', (err) => {
        if (err) {
          console.log(err);
        }
      });
    });
  }
};

const shoot = async (driver) => {
  await driver.get(buildUrl(config.login.url));
  await driver.manage().setTimeouts({ implicit: 500 });

  const userInput = await driver.findElement(By.name('username'));
  await userInput.sendKeys(config.login.username);

  const passwordInput = await driver.findElement(By.name('password'));
  await passwordInput.sendKeys(config.login.password);

  const loginButton = await driver.findElement(By.className('MuiButton-outlinedPrimary'));
  await loginButton.click();

  await driver.wait(until.urlMatches(new RegExp(buildUrl('/dashboard'))), 2000);
  await sleep(500);
  await dismissToast(driver);

  for (const screenshot of config.screenshots) {
    const url = buildUrl(screenshot.url);
    await driver.get(url);
    await driver.wait(until.urlContains(screenshot.url), 2000);
    await sleep(500);
    await dismissToast(driver);
    await takeScreenshots(driver, screenshot.filename);
  }

  await sleep(1000);
};

(async () => {
  try {
    const options = new Options();
    const driver = await new Builder()
      .forBrowser(Browser.CHROME)
      .setChromeOptions(options.addArguments('--headless=new'))
      .build();
    await shoot(driver).finally(() => driver.quit());
  } catch (err) {
    console.log(err);
  }
})();
