// Best-effort UI automation against walmart.com. Walmart has no public stock API,
// so this drives a real (headed) browser the same way a person would: set a
// ZIP/store, search a term, and read the pickup/stock badges off the results.
// Walmart's bot detection (Akamai) and page layout can both change without notice,
// so selectors below favor visible text/roles over CSS classes, and every step
// logs clearly and captures a debug screenshot on failure so it's fixable in place.

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

const config = require("./config.json");

const LOG_DIR = path.join(__dirname, "logs");
const DEBUG_DIR = path.join(__dirname, "debug");
const PROFILE_DIR = path.join(__dirname, ".wm-profile");
const DEBUG = !!process.env.DEBUG;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  ensureDir(LOG_DIR);
  fs.appendFileSync(path.join(LOG_DIR, "checker.log"), line + "\n");
}

async function saveDebugArtifacts(page, label) {
  try {
    ensureDir(DEBUG_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(DEBUG_DIR, `${stamp}-${label}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await page.content().catch(() => ""));
    log(`Saved debug artifacts: ${base}.png / .html`);
  } catch (err) {
    log(`Could not save debug artifacts: ${err.message}`);
  }
}

async function checkForBlock(page) {
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const blocked =
    /\/blocked(\?|$)/i.test(url) ||
    /robot or human|access denied|px-captcha|are you a human/i.test(bodyText);
  if (blocked) {
    await saveDebugArtifacts(page, "blocked");
    throw new Error(
      `Walmart's bot detection blocked this request at ${url}. ` +
        "Try running once manually (headless: false), solving any challenge shown, then re-run."
    );
  }
}

// Interactive challenges (e.g. Akamai "press & hold") replace the page content until a
// human clears them. Racing past one with scripted input is itself a bot signal, so pause
// and poll until the challenge text is gone (or the timeout elapses) before doing anything else.
async function waitForHumanChallenge(page, maxWaitMs = 120000) {
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < maxWaitMs) {
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const challengePresent = /press\s*(&|and)\s*hold|verify you are human|human verification|additional verification|security check/i.test(
      bodyText
    );
    if (!challengePresent) return;
    if (!announced) {
      log("A Walmart security challenge appeared in the browser window — please complete it now. Waiting...");
      announced = true;
    }
    await page.waitForTimeout(2000);
  }
  log("Gave up waiting for the security challenge to clear after 2 minutes.");
}

async function openStoreFinder(page, zip) {
  await page.goto("https://www.walmart.com/store/finder", { waitUntil: "domcontentloaded" });
  await waitForHumanChallenge(page);
  await checkForBlock(page);

  const input = page
    .getByRole("textbox", { name: /city|zip|location|search/i })
    .or(page.getByPlaceholder(/city.*zip|zip.*code|location/i));

  await input.first().waitFor({ timeout: 15000 });
  await input.first().fill(zip);
  await input.first().press("Enter");
  await page.waitForTimeout(3000);
  await waitForHumanChallenge(page);
  await checkForBlock(page);
}

async function getNearbyStores(page, radiusMiles) {
  // Store finder results render as repeated blocks each containing a "X.X mi" distance
  // and a link into /store/<id>-.... Walk up from the distance text to the block.
  const distanceNodes = page.locator("text=/\\d+(\\.\\d+)?\\s*mi\\b/i");
  const count = await distanceNodes.count();
  log(`Store finder: found ${count} candidate distance labels near ZIP ${config.zip}.`);

  const stores = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    const distNode = distanceNodes.nth(i);
    const distText = (await distNode.innerText().catch(() => "")) || "";
    const distMatch = distText.match(/(\d+(?:\.\d+)?)\s*mi/i);
    if (!distMatch) continue;
    const distanceMiles = parseFloat(distMatch[1]);
    if (distanceMiles > radiusMiles) continue;

    const block = distNode.locator(
      "xpath=ancestor::*[self::li or self::article or self::div][1]"
    );
    const link = block.locator('a[href*="/store/"]').first();
    const href = await link.getAttribute("href").catch(() => null);
    if (!href) continue;

    const storeIdMatch = href.match(/\/store\/(\d+)/);
    const storeId = storeIdMatch ? storeIdMatch[1] : href;
    if (seen.has(storeId)) continue;
    seen.add(storeId);

    const name = (await block.innerText().catch(() => "")).split("\n")[0] || `Store ${storeId}`;
    const url = href.startsWith("http") ? href : `https://www.walmart.com${href}`;

    stores.push({ storeId, name: name.trim(), distanceMiles, url });
  }

  log(`Found ${stores.length} store(s) within ${radiusMiles} miles of ${config.zip}.`);
  return stores;
}

async function selectStore(page, store) {
  await page.goto(store.url, { waitUntil: "domcontentloaded" });
  await waitForHumanChallenge(page);
  await checkForBlock(page);

  const setStoreButton = page.getByRole("button", {
    name: /make.*(my )?store|shop this store|set as my store|choose this store/i,
  });

  try {
    await setStoreButton.first().waitFor({ timeout: 8000 });
    await setStoreButton.first().click();
    await page.waitForTimeout(1500);
    log(`Selected store as active pickup location: ${store.name} (${store.distanceMiles} mi)`);
  } catch (err) {
    log(
      `Could not find a "make this my store" button for ${store.name} — it may already be selected, ` +
        `or Walmart changed this page. Continuing anyway. (${err.message})`
    );
  }
}

async function searchTermInStock(page, term) {
  const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(term)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await waitForHumanChallenge(page);
  await checkForBlock(page);
  await page.waitForTimeout(2000);

  const pickupTab = page.getByRole("tab", { name: /pickup/i }).or(
    page.getByRole("button", { name: /^pickup$/i })
  );
  try {
    await pickupTab.first().waitFor({ timeout: 5000 });
    await pickupTab.first().click();
    await page.waitForTimeout(2000);
  } catch {
    log(`No "Pickup" filter tab found for "${term}" — scanning all results instead.`);
  }

  const productLinks = page.locator('a[href*="/ip/"]');
  const count = await productLinks.count();
  log(`Search "${term}": scanning ${count} result tile(s).`);

  const hits = [];
  const seenUrls = new Set();

  for (let i = 0; i < count; i++) {
    const link = productLinks.nth(i);
    const href = await link.getAttribute("href").catch(() => null);
    if (!href) continue;
    const url = href.startsWith("http") ? href : `https://www.walmart.com${href}`;
    if (seenUrls.has(url)) continue;

    const block = link.locator("xpath=ancestor::*[self::li or self::div][2]");
    const text = (await block.innerText().catch(() => "")) || (await link.innerText().catch(() => ""));

    const outOfStock = /out of stock|currently unavailable|not sold in stores/i.test(text);
    const inStock = /pickup today|pickup tomorrow|free pickup|in stock/i.test(text);

    if (inStock && !outOfStock) {
      seenUrls.add(url);
      const title = text.split("\n").find((line) => line.trim().length > 3) || term;
      const priceMatch = text.match(/\$\d[\d,]*\.\d{2}/);
      hits.push({ title: title.trim(), price: priceMatch ? priceMatch[0] : "unknown", url });
    }
  }

  log(`Search "${term}": ${hits.length} in-stock-for-pickup match(es).`);
  return hits;
}

async function sendEmail(allHits) {
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!appPassword) {
    log("GMAIL_APP_PASSWORD is not set (check .env) — skipping email, results are still logged above.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: config.sender, pass: appPassword },
  });

  const lines = [];
  for (const { store, term, hits } of allHits) {
    lines.push(`${term} — ${store.name} (${store.distanceMiles} mi):`);
    for (const hit of hits) {
      lines.push(`  - ${hit.title} (${hit.price}) ${hit.url}`);
    }
  }

  const subject = `Walmart stock alert: ${allHits.reduce((n, h) => n + h.hits.length, 0)} match(es) found`;
  const text = lines.join("\n");

  await transporter.sendMail({
    from: config.sender,
    to: config.recipients.join(","),
    subject,
    text,
  });

  log(`Email sent to ${config.recipients.join(", ")}.`);
}

async function main() {
  ensureDir(PROFILE_DIR);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: config.headless,
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    log(`Starting check for [${config.searchTerms.join(", ")}] near ZIP ${config.zip} (${config.radiusMiles} mi).`);

    await openStoreFinder(page, config.zip);
    const stores = await getNearbyStores(page, config.radiusMiles);

    if (stores.length === 0) {
      log("No stores found within radius — nothing to check. If this is unexpected, Walmart's store finder page layout may have changed.");
      await saveDebugArtifacts(page, "no-stores-found");
      return;
    }

    const allHits = [];
    for (const store of stores) {
      await selectStore(page, store);
      for (const term of config.searchTerms) {
        const hits = await searchTermInStock(page, term);
        if (hits.length > 0) {
          allHits.push({ store, term, hits });
        }
      }
    }

    if (allHits.length > 0) {
      log(`RESULT: found stock at ${allHits.length} store/term combination(s).`);
      await sendEmail(allHits);
    } else {
      log("RESULT: nothing in stock this run.");
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (DEBUG) await saveDebugArtifacts(page, "fatal-error");
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main();
