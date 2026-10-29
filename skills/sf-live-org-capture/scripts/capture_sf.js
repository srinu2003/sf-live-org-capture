const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Fast Headless Chrome CDP Screenshot Capture for Salesforce Lightning Pages.
 *
 * Usage:
 *   node capture_sf.js [--url <full-url-or-path>] [--org <alias>] [--wait-for <selector>] [--click <selector>] [--settle-ms <ms>] [--out-dir <dir>]
 */
const CACHE_DIR = 'C:\\Users\\tsiri\\AppData\\Local\\Temp\\chrome_sf_cache';
const TARGET_CACHE_FILE = path.join(CACHE_DIR, 'workspace_targets.json');

function loadWorkspaceTarget(cwd) {
    try {
        if (fs.existsSync(TARGET_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(TARGET_CACHE_FILE, 'utf-8'));
            return data[cwd.toLowerCase()] || null;
        }
    } catch { }
    return null;
}

function saveWorkspaceTarget(cwd, urlPath, waitForSelector) {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        const data = fs.existsSync(TARGET_CACHE_FILE)
            ? JSON.parse(fs.readFileSync(TARGET_CACHE_FILE, 'utf-8'))
            : {};
        data[cwd.toLowerCase()] = {
            urlPath,
            waitForSelector: waitForSelector || data[cwd.toLowerCase()]?.waitForSelector || null,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(TARGET_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch { }
}

function normalizeLightningPath(input) {
    if (!input) return null;
    if (/^https?:\/\//i.test(input)) {
        try {
            const parsed = new URL(input);
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            return input;
        }
    }
    return input.startsWith('/') ? input : `/${input}`;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const cached = loadWorkspaceTarget(process.cwd());
    const opts = {
        org: null,
        urlPath: cached?.urlPath || null,
        waitForSelector: cached?.waitForSelector || null,
        clickSelector: null,
        settleMs: 2000,
        outDir: process.cwd()
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--org' && args[i + 1]) opts.org = args[++i];
        else if ((arg === '--path' || arg === '--url') && args[i + 1]) opts.urlPath = normalizeLightningPath(args[++i]);
        else if ((arg === '--wait-for' || arg === '--component') && args[i + 1]) opts.waitForSelector = args[++i];
        else if (arg === '--click' && args[i + 1]) opts.clickSelector = args[++i];
        else if (arg === '--settle-ms' && args[i + 1]) opts.settleMs = parseInt(args[++i], 10) || 2000;
        else if (arg === '--out-dir' && args[i + 1]) opts.outDir = args[++i];
    }
    if (!opts.urlPath) {
        opts.urlPath = '/lightning/page/home';
    } else {
        saveWorkspaceTarget(process.cwd(), opts.urlPath, opts.waitForSelector);
    }
    return opts;
}

async function run() {
    const opts = parseArgs();
    const orgFlag = opts.org ? `--target-org ${opts.org}` : '';
    const cmd = `sf org open ${orgFlag} --path "${opts.urlPath}" --url-only --json`.replace(/\s+/g, ' ').trim();

    console.log(`1. Getting frontdoor URL (${cmd})...`);
    const sfOutput = execSync(cmd, { encoding: 'utf-8' });
    const sfJson = JSON.parse(sfOutput);
    const frontdoorUrl = sfJson.result.url;

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const port = 9333;

    console.log('2. Starting Chrome with cached profile...');
    const chromeProc = spawn(chromePath, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${CACHE_DIR}`,
        '--window-size=1600,1000',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    ]);

    const killChrome = () => {
        try {
            chromeProc.kill();
            execSync(`taskkill /PID ${chromeProc.pid} /F /T`, { stdio: 'ignore' });
        } catch (e) { }
    };

    try {
        let versionData = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 150));
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json/version`);
                if (res.ok) {
                    versionData = await res.json();
                    break;
                }
            } catch (e) { }
        }

        if (!versionData) throw new Error('Chrome CDP failed on port ' + port);

        const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
        const targets = await targetsRes.json();
        const pageTarget = targets.find(t => t.type === 'page') || targets[0];
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

        let id = 1;
        const send = (method, params = {}) => {
            return new Promise((resolve, reject) => {
                const msgId = id++;
                const handler = (evt) => {
                    const data = JSON.parse(evt.data);
                    if (data.id === msgId) {
                        ws.removeEventListener('message', handler);
                        if (data.error) reject(data.error);
                        else resolve(data.result);
                    }
                };
                ws.addEventListener('message', handler);
                ws.send(JSON.stringify({ id: msgId, method, params }));
            });
        };

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        await send('Page.enable');
        await send('Runtime.enable');
        await send('Network.enable');
        await send('Network.setCacheDisabled', { cacheDisabled: true });

        if (process.env.THROTTLE_4G === 'true') {
            console.log('2.5. Applying 4G throttling (4 Mbps, 100ms latency)...');
            await send('Network.emulateNetworkConditions', {
                offline: false,
                latency: 100,
                downloadThroughput: (4 * 1024 * 1024) / 8,
                uploadThroughput: (3 * 1024 * 1024) / 8
            });
        }

        console.log(`3. Navigating to ${opts.urlPath}...`);
        await send('Page.navigate', { url: frontdoorUrl });

        console.log(`4. Waiting for page/component (${opts.waitForSelector || 'shell'}) and spinner removal...`);
        const startWait = Date.now();
        let snappedBeforeReady = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            await new Promise(r => setTimeout(r, 400));
            try {
                // If requested, snap BEFORE spinner is removed (i.e. before CONTENT_READY)
                if (process.env.SNAP_BEFORE_READY === 'true' && !snappedBeforeReady) {
                    const checkSpinner = await send('Runtime.evaluate', {
                        expression: `(() => {
                            function queryShadow(selector, root = document) {
                                if (!root) return null;
                                const el = root.querySelector(selector);
                                if (el) return el;
                                const elements = root.querySelectorAll('*');
                                for (const child of elements) {
                                    if (child.shadowRoot) {
                                        const res = queryShadow(selector, child.shadowRoot);
                                        if (res) return res;
                                    }
                                }
                                return null;
                            }
                            const comp = queryShadow('c-html-buider');
                            const spinner = comp ? (comp.shadowRoot ? comp.shadowRoot.querySelector('lightning-spinner') : null) : null;
                            return {
                                hasComp: !!comp,
                                hasSpinner: !!spinner
                            };
                        })()`,
                        returnByValue: true
                    });
                    const resVal = checkSpinner?.result?.value;
                    if (resVal?.hasComp) {
                        console.log(`[attempt ${attempt}] Component found! Spinner present: ${resVal.hasSpinner}`);
                        if (resVal.hasSpinner) {
                            console.log('>>> [BEFORE CONTENT_READY] Snapping screenshot while spinner is active! <<<');
                            const beforeShot = await send('Page.captureScreenshot', { format: 'png' });
                            const beforeFilename = 'live_org_capture_before_content_ready.png';
                            fs.writeFileSync(path.join(opts.outDir, beforeFilename), Buffer.from(beforeShot.data, 'base64'));
                            console.log(`Saved before shot: ${beforeFilename}`);
                            snappedBeforeReady = true;
                        }
                    }
                }

                const evalRes = await send('Runtime.evaluate', {
                    expression: `(() => {
                        function queryShadow(selector, root = document) {
                            if (!root) return null;
                            const el = root.querySelector(selector);
                            if (el) return el;
                            const elements = root.querySelectorAll('*');
                            for (const child of elements) {
                                if (child.shadowRoot) {
                                    const res = queryShadow(selector, child.shadowRoot);
                                    if (res) return res;
                                }
                            }
                            return null;
                        }
                        const targetSel = ${JSON.stringify(opts.waitForSelector)};
                        if (targetSel) {
                            const comp = queryShadow(targetSel);
                            if (!comp) return false;
                            const spinner = comp.shadowRoot && comp.shadowRoot.querySelector('lightning-spinner');
                            return !spinner;
                        }
                        const ready = document.readyState === 'complete' && !!document.querySelector('.oneHeader, one-appnav, .slds-template__container, lightning-tabset');
                        const globalSpinner = queryShadow('lightning-spinner');
                        return ready && !globalSpinner;
                    })()`
                });
                if (evalRes && evalRes.result && evalRes.result.value === true) {
                    console.log(`Page ready and spinner gone in ${Date.now() - startWait}ms, waiting ${opts.settleMs}ms to settle...`);
                    await new Promise(r => setTimeout(r, opts.settleMs));
                    break;
                }
            } catch (e) { }
        }

        if (opts.clickSelector) {
            const steps = opts.clickSelector.split('>>').map(s => s.trim()).filter(Boolean);
            for (const stepSel of steps) {
                console.log(`4.5. Clicking selector: ${stepSel}`);
                const clickRes = await send('Runtime.evaluate', {
                    expression: `(() => {
                        function queryShadow(selector, root = document) {
                            if (!root) return null;
                            const el = root.querySelector(selector);
                            if (el) return el;
                            const elements = root.querySelectorAll('*');
                            for (const child of elements) {
                                if (child.shadowRoot) {
                                    const res = queryShadow(selector, child.shadowRoot);
                                    if (res) return res;
                                }
                            }
                            return null;
                        }
                        const target = queryShadow(${JSON.stringify(stepSel)}, document);
                        if (target) {
                            const clickable = target.shadowRoot?.querySelector('button') || target;
                            clickable.click();
                            return { clicked: true, title: target.title || target.label || target.textContent?.trim() };
                        }
                        return { clicked: false, reason: 'selector not found' };
                    })()`,
                    returnByValue: true
                });
                console.log('4.5. Click result:', JSON.stringify(clickRes.result?.value));
                await new Promise(r => setTimeout(r, 1500));
                for (let w = 0; w < 15; w++) {
                    const spinCheck = await send('Runtime.evaluate', {
                        expression: `(() => {
                            function queryShadow(selector, root = document) {
                                if (!root) return null;
                                const el = root.querySelector(selector);
                                if (el) return el;
                                for (const child of root.querySelectorAll('*')) {
                                    if (child.shadowRoot) {
                                        const res = queryShadow(selector, child.shadowRoot);
                                        if (res) return res;
                                    }
                                }
                                return null;
                            }
                            return !queryShadow('lightning-spinner');
                        })()`
                    });
                    if (spinCheck?.result?.value === true) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        console.log('5. Snapping screenshot...');
        const snapStart = Date.now();
        const screenshotResult = await send('Page.captureScreenshot', { format: 'png' });
        const timestamp = Date.now();
        const filename = `live_org_capture_${timestamp}.png`;
        if (!fs.existsSync(opts.outDir)) {
            fs.mkdirSync(opts.outDir, { recursive: true });
        }
        const outputPath = path.join(opts.outDir, filename);
        fs.writeFileSync(outputPath, Buffer.from(screenshotResult.data, 'base64'));
        console.log(`Saved screenshot in ${Date.now() - snapStart}ms to ${outputPath}`);
        console.log(`CAPTURED_FILENAME: ${filename}`);

        ws.close();
    } finally {
        killChrome();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
