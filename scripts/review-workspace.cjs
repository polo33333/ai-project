// Isolated visual smoke check: serves frontend files and mocks read-only API responses.
// Run with PLAYWRIGHT_MODULE pointing at an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../src/frontend');
const output = path.resolve(__dirname, '../artifacts/ui-review');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    const data = url.pathname === '/api/auth/me' ? { authenticated: !req.headers.referer?.includes('/login.html'), account: { displayName: 'Admin AI' } }
      : url.pathname === '/api/qdrant/status' ? { connected: false }
      : [];
    return res.end(JSON.stringify(data));
  }
  const file = path.resolve(root, `.${url.pathname.includes('.') ? url.pathname : '/index.html'}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#header-notification-count').isVisible(), true);
    await page.locator('#header-notification-btn').click();
    assert.equal(await page.locator('#header-notification-panel').isVisible(), true);
    assert.ok((await page.locator('#header-notification-panel').textContent()).includes('Beta 1.0.1'));
    await page.screenshot({ path: path.join(output, 'notifications-beta.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#header-notification-panel').isVisible(), false);
    await page.locator('#header-notification-btn').click();
    await page.locator('#notification-mark-read').click();
    assert.equal(await page.locator('#header-notification-count').isVisible(), false);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#header-notification-count').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'desktop-expanded.png') });
    await page.locator('#sidebar-toggle-btn').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#app-sidebar').evaluate(el => el.getBoundingClientRect().width), 76);
    await page.locator('#nav-library a').hover();
    assert.equal(await page.locator('.sidebar-tooltip').isVisible(), true);
    await page.screenshot({ path: path.join(output, 'desktop-mini.png') });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#app-sidebar').evaluate(el => el.classList.contains('collapsed')), true);
    await page.locator('#nav-api-docs a').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#nav-api-docs a').getAttribute('aria-current'), 'page');
    await page.screenshot({ path: path.join(output, 'api-mini.png') });
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
      await page.locator('#header-notification-btn').click();
      const notificationBox = await page.locator('#header-notification-panel').boundingBox();
      assert.ok(notificationBox.x >= 0 && notificationBox.x + notificationBox.width <= width, `Notification fits ${width}`);
      await page.keyboard.press('Escape');
      if (width <= 860) {
        await page.locator('#sidebar-toggle-btn').click();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#app-sidebar').evaluate(el => el.getBoundingClientRect().width), width < 328 ? width - 48 : 280);
        assert.equal(await page.locator('#sidebar-backdrop').isVisible(), true);
        assert.equal(await page.locator('main.main-content').evaluate(el => el.inert), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#sidebar-backdrop').isVisible(), false);
        await page.locator('#sidebar-toggle-btn').click();
        await page.locator('#nav-library a').click();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#app-sidebar').evaluate(el => el.getBoundingClientRect().width), width <= 620 ? 64 : 76);
        assert.equal(await page.locator('#sidebar-backdrop').isVisible(), false);
        assert.equal(await page.locator('main.main-content').evaluate(el => el.inert), false);
      }
      if (width === 390) {
        await page.screenshot({ path: path.join(output, 'mobile-mini.png') });
        await page.locator('#sidebar-toggle-btn').click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(output, 'mobile-menu.png') });
        await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const routes = await page.locator('.nav-item a').evaluateAll(links => links.map(link => link.getAttribute('onclick').match(/'([^']+)'/)[1]));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of routes) {
        await page.evaluate(route => window.switchMainTab(route), route);
        await page.waitForTimeout(100);
        const active = page.locator('.sidebar-nav .nav-item.active a');
        assert.equal(await active.count(), 1, `One active tab: ${route}`);
        assert.equal(await active.getAttribute('aria-current'), 'page');
        const activeLayout = await active.evaluate(link => {
          const box = link.getBoundingClientRect(), icon = link.querySelector('svg').getBoundingClientRect();
          return { marker: getComputedStyle(link, '::before').content, offsetX: Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2), offsetY: Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2) };
        });
        assert.ok(['none', 'normal'].includes(activeLayout.marker), 'No detached active marker');
        assert.ok(activeLayout.offsetX < 1 && activeLayout.offsetY < 1, `Centered active icon: ${route}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow: ${route} at ${width}`);
        const clippedHeroes = await page.locator('.system-tools-hero').evaluateAll(heroes => heroes.filter(hero => hero.getClientRects().length).flatMap(hero => [...hero.children].filter(child => child.getBoundingClientRect().right > innerWidth + 1).map(child => child.className)));
        assert.deepEqual(clippedHeroes, [], `Clipped hero: ${route} at ${width}`);
        if (route === 'page-chat' && width === 390) {
          assert.equal(await page.locator('#page-chat-user-input').isVisible(), true);
          assert.ok(await page.locator('.chat-main').evaluate(el => el.getBoundingClientRect().width > 250));
          await page.locator('.chat-sessions-toggle').click();
          assert.equal(await page.locator('#chat-sessions-list').isVisible(), true);
          await page.locator('.chat-sessions-toggle').click();
          assert.equal(await page.locator('#chat-sessions-list').isVisible(), false);
        }
        await page.screenshot({ path: path.join(output, `${route}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.switchMainTab('chat-feedback'));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.chatFeedbackData = [
        { auditId: 'preview-1', rating: 'like', reviewStatus: 'approved', model: 'Demo model', createdAt: '2026-09-05T08:00:00Z', audit: { question: 'Tổng hợp doanh thu theo tháng', replyText: 'Đây là dữ liệu minh họa để kiểm tra giao diện.', sqlQuery: 'SELECT month, revenue FROM monthly_report', tokenUsage: { inputTokens: 120, outputTokens: 80 } } },
        { auditId: 'preview-2', rating: 'dislike', reviewStatus: 'pending', model: 'Demo model', createdAt: '2026-09-05T08:10:00Z', audit: { question: 'So sánh số lượng đơn hàng', replyText: 'Câu trả lời minh họa đang chờ kiểm duyệt.' } }
      ];
      renderChatFeedbackTable();
    });
    assert.equal(await page.locator('#chat-feedback-tbody > tr').count(), 2);
    await page.locator('.feedback-answer summary').first().click();
    await page.screenshot({ path: path.join(output, 'feedback-populated.png') });
    await page.locator('#feedback-rating-filter').selectOption('dislike');
    assert.equal(await page.locator('#chat-feedback-tbody > tr').count(), 1);
    assert.ok((await page.locator('#chat-feedback-tbody').textContent()).includes('So sánh'));
    await page.locator('#feedback-search').fill('không có kết quả này');
    assert.ok((await page.locator('#chat-feedback-tbody').textContent()).includes('Không có đánh giá'));
    await page.evaluate(() => window.switchMainTab('chat-history'));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.chatHistoryData = [{ id: 'scroll-preview', timestamp: '05/09/2026 15:00', question: 'Kiểm tra thanh cuộn JSON', modelName: 'Demo model', status: 'SUCCESS', requestPayload: { rows: Array.from({ length: 30 }, (_, i) => ({ index: i, description: 'Dữ liệu minh họa kiểm tra thanh cuộn trong khung JSON.' })) } }];
      renderChatHistoryTable();
    });
    const jsonViewer = page.locator('#view-chat-history .json-audit-card pre').first();
    assert.ok(await jsonViewer.evaluate(el => { el.scrollTop = 60; return el.scrollTop > 0; }));
    await jsonViewer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'history-scroll.png') });
    await page.evaluate(() => window.switchMainTab('training-core'));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.trainingReportData = {
        summary: { total: 30, passed: 0, failed: 30, disliked: 30 }, failureCounts: { MISSING_SQL: 30, REVIEW_REQUESTED: 10 },
        cases: Array.from({ length: 30 }, (_, i) => ({ id: `preview-${i}`, question: `Câu hỏi kiểm tra cuộn số ${i + 1}`, reply: 'Nội dung minh họa kiểm tra giao diện.', failures: ['MISSING_SQL'], rating: 'dislike', suggestions: [] }))
      };
      renderTrainingReport();
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const scrollState = await page.evaluate(() => {
        const main = document.querySelector('main.main-content');
        const cases = document.getElementById('training-cases');
        cases.scrollTop = 200;
        return { pageOverflow: main.scrollHeight - main.clientHeight, casesScroll: cases.scrollTop, casesHeight: cases.clientHeight, bottom: cases.getBoundingClientRect().bottom };
      });
      assert.ok(scrollState.pageOverflow <= 1, `Training page overflow at ${width}: ${JSON.stringify(scrollState)}`);
      assert.ok(scrollState.casesScroll > 0 && scrollState.casesHeight > 100 && scrollState.bottom <= 900, `Internal scroll at ${width}: ${JSON.stringify(scrollState)}`);
      await page.screenshot({ path: path.join(output, `training-scroll-${width}.png`) });
    }
    await page.evaluate(() => window.switchMainTab('library'));
    assert.equal(await page.locator('main.main-content').evaluate(el => el.classList.contains('training-workspace')), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-theme-toggle]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    const brightSurfaces = [];
    for (const route of routes) {
      await page.evaluate(route => window.switchMainTab(route), route);
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(output, `dark-${route}.png`) });
      const bright = await page.evaluate(() => [...document.querySelectorAll('main.main-content *')].filter(el => {
        const box = el.getBoundingClientRect(), rgb = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
        return box.width > 70 && box.height > 25 && box.top < innerHeight && box.bottom > 0 && rgb && (rgb.length < 4 || rgb[3] > .8) && rgb[0] > 190 && rgb[1] > 190 && rgb[2] > 190;
      }).map(el => ({ tag: el.tagName, class: el.className, id: el.id })).slice(0, 10));
      if (bright.length) brightSurfaces.push({ route, bright });
    }
    assert.deepEqual(brightSurfaces, [], 'No bright legacy surfaces in dark mode');
    // Exercise populated renderers: empty states cannot reveal legacy row colors.
    const populatedChecks = [
      ['overview', () => renderDashboardLogs([{ level: 'SUCCESS', module: 'AI Assistant', message: 'Preview response completed', timestamp: '05/09/2026' }]), '.dashboard-log-item'],
      ['sql-connector', () => { window.dbSourcesData = [{ id: 'preview', dbName: 'Preview', host: 'localhost', isDefault: true }]; renderDbSourcesTable(); }, '.db-source-default td'],
      ['dictionary', () => { window.groupedTablesData = [{ tableName: 'Preview', tableDescription: 'Preview table', isActive: false, columns: [{ columnName: 'Id', dataType: 'INT', isPrimaryKey: true }] }]; renderDataDictionary(); openDictionaryDrawer('Preview'); }, '.dictionary-drawer-header'],
      ['page-chat', () => { document.getElementById('page-chat-messages-container').innerHTML = '<div style="background:#fff;padding:18px"><div>AI Assistant</div><div class="chat-ai-answer">Readable answer<ul><li>Preview result</li></ul></div><details class="chat-technical-details" open><summary>Thinking</summary><div class="chat-technical-content">Preview steps</div></details><div class="chat-token-usage"><span>Input: 120</span><span class="chat-token-total">Total: 150</span></div></div>'; }, '.chat-technical-details']
    ];
    for (const [route, populate, selector] of populatedChecks) {
      await page.evaluate(route => window.switchMainTab(route), route);
      await page.waitForTimeout(200);
      await page.evaluate(populate);
      await page.waitForTimeout(350);
      const surface = await page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
      assert.ok(surface.match(/\d+/g).slice(0, 3).every(n => Number(n) < 90), `Populated dark surface ${selector}: ${surface}`);
      if (route === 'page-chat') {
        assert.equal(await page.locator('.chat-ai-answer').evaluate(el => getComputedStyle(el).color), 'rgb(225, 232, 245)');
      }
      await page.screenshot({ path: path.join(output, `dark-populated-${route}.png`) });
      if (route === 'dictionary') await page.evaluate(() => closeDictionaryDrawer());
    }
    await page.evaluate(() => openCopilotPopup());
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#copilot-modal .copilot-modal-dialog').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(21, 31, 48)');
    await page.screenshot({ path: path.join(output, 'dark-copilot.png') });
    await page.locator('#copilot-modal .modal-close-btn').click();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of routes) {
      await page.evaluate(route => window.switchMainTab(route), route);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Dark mobile overflow: ${route}`);
    }
    await page.locator('#header-notification-btn').click();
    await page.screenshot({ path: path.join(output, 'dark-mobile.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.address().port}/login.html`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.screenshot({ path: path.join(output, 'dark-login.png') });
    await page.locator('[data-theme-toggle]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    const systemPage = await browser.newPage({ colorScheme: 'dark' });
    await systemPage.goto(`http://127.0.0.1:${server.address().port}/login.html`, { waitUntil: 'networkidle' });
    assert.equal(await systemPage.locator('html').getAttribute('data-theme'), 'dark');
    await systemPage.emulateMedia({ colorScheme: 'light' });
    await systemPage.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await systemPage.locator('[data-theme-toggle]').click();
    await systemPage.emulateMedia({ colorScheme: 'light' });
    assert.equal(await systemPage.locator('html').getAttribute('data-theme'), 'dark');
    await systemPage.close();
    await page.screenshot({ path: path.join(output, 'login.png') });
    assert.deepEqual(errors, [], 'Unexpected browser errors');
    console.log(JSON.stringify({ passed: true, routesChecked: routes.length, screenshots: output, pageErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
