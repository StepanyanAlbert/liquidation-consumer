import { chromium } from 'playwright';

const USER_DATA_DIR = './.x-profile';
const STATE_FILE = './x-storage-state.json';

(async () => {
    // Open the *same* profile you already logged into:
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, // for the first time; later you can use true + Xvfb on server
        args: ['--disable-blink-features=AutomationControlled'],
    });

    // Optional: navigate to ensure origin storage is available
    const page = await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });

    // Export cookies + localStorage
    await context.storageState({ path: STATE_FILE });
    console.log('Saved storage state to', STATE_FILE);

    await context.close();
})();
