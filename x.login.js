import { chromium } from 'playwright';

// Directory to persist your logged-in browser profile
const USER_DATA_DIR = './.x-profile';

(async () => {
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,                 // better for initial login; use Xvfb on servers
    viewport: { width: 1280, height: 900 },
    // Spoofing some flags helps stability; keep it simple
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('👉 Please log in manually. Press CTRL+C after you see your home timeline.');
  // Heuristic: wait until we can see the composer or the side nav (means logged in)
  try {
    await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 180_000 });
    console.log('✅ Looks logged in. This profile is now persisted.');
  } catch {
    console.log('⚠️ Timed out waiting for login UI. If already logged in, you can ignore.');
  }

  // Keep browser open so you can finish 2FA if needed
  // Close manually when done; context is persisted to USER_DATA_DIR.
})();
