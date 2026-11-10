// Playwright screenshot runner for the code-review client preview.
//
//   node tests/code-review/preview/shoot.mjs
//
// Boots a tiny static server (Node http, port 7788), loads the preview harness
// which renders the *real* plugins/dsh-code-review/client.js against the mock
// host, captures docs/screenshots/code-review-<view>.png (1440x1000, 1x) and
// runs smoke assertions (no console error, no "undefined" text, heatmap cells,
// job row → detail navigation).

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const PORT = 7788;
const BASE = `http://127.0.0.1:${PORT}/tests/code-review/preview/index.html`;

const VIEWS = ['overview', 'reviews', 'detail', 'launch', 'projects', 'architecture', 'flow'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

function startServer() {
  const server = createServer((request, response) => {
    const rawPath = decodeURIComponent((request.url || '/').split('?')[0]);
    const filePath = normalize(join(ROOT, rawPath));
    if (!filePath.startsWith(ROOT) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

function loadPlaywright() {
  const require = createRequire('/tmp/pwtest/');
  return require('playwright-core');
}

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const results = [];
  let failed = false;

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const openView = async (view, extra) => {
    consoleErrors.length = 0;
    const query = new URLSearchParams({ view, lang: 'zh', theme: 'dark', ...(extra || {}) });
    await page.goto(`${BASE}?${query.toString()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.previewReady === '1', { timeout: 20000 });
    await page.waitForSelector('.cr-app[data-ready="1"]', { timeout: 20000 });
    await page.waitForTimeout(1100);
  };

  const pageText = async () => page.evaluate(() => document.body.innerText);

  const checkBasic = async (view) => {
    const text = await pageText();
    const issues = [];
    if (text.includes('undefined')) issues.push('页面文本包含 "undefined"');
    if (/\bNaN\b/.test(text)) issues.push('页面文本包含 "NaN"');
    if (text.includes('boot failed')) issues.push('harness boot 失败');
    const errors = consoleErrors.slice();
    if (errors.length) issues.push(`console error: ${errors.join(' | ').slice(0, 400)}`);
    const hasApp = await page.$('.cr-app[data-ready="1"]');
    if (!hasApp) issues.push('未渲染 .cr-app[data-ready="1"]');
    results.push({ view, ok: issues.length === 0, issues });
    if (issues.length) failed = true;
  };

  const shoot = async (view) => {
    const file = join(SHOTS, `code-review-${view}.png`);
    await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
    return file;
  };

  // -- overview ------------------------------------------------------------
  await openView('overview');
  const heatCells = await page.$$eval('[data-hm-cell]', (nodes) => nodes.length);
  const statCards = await page.$$eval('[data-stat]', (nodes) => nodes.length);
  const queueCards = await page.$$eval('.cr-queue-card', (nodes) => nodes.length);
  await checkBasic('overview');
  if (heatCells < 360) {
    results[results.length - 1].issues.push(`热力图格子不足：${heatCells}（要求 >= 360）`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  if (statCards !== 6) {
    results[results.length - 1].issues.push(`统计卡数量异常：${statCards}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  if (queueCards < 1) {
    results[results.length - 1].issues.push('实时队列没有卡片');
    results[results.length - 1].ok = false;
    failed = true;
  }
  results[results.length - 1].heatCells = heatCells;
  results[results.length - 1].statCards = statCards;
  await shoot('overview');

  // heatmap metric switch + tooltip (does not break the layout)
  await page.click('[data-stat="findings"]');
  await page.hover('[data-hm-cell]:nth-child(120)');
  await page.waitForTimeout(280);
  const tooltipVisible = await page.$('.cr-tooltip');
  if (!tooltipVisible) {
    results.push({ view: 'overview-tooltip', ok: false, issues: ['热力图 hover tooltip 未出现'] });
    failed = true;
  } else {
    results.push({ view: 'overview-tooltip', ok: true, issues: [] });
  }

  // -- reviews -------------------------------------------------------------
  await openView('reviews');
  await checkBasic('reviews');
  const reviewRows = await page.$$eval('[data-job-row]', (nodes) => nodes.length);
  if (reviewRows < 5) {
    results[results.length - 1].issues.push(`评审行数量异常：${reviewRows}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  // open the first *completed* row (running/queued rows have no findings yet)
  const completedRow = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('[data-job-row]')];
    return rows.find((row) => row.textContent.includes('已完成')) || rows[0];
  });
  await completedRow.asElement().click();
  await page.waitForSelector('.cr-app[data-view="detail"]', { timeout: 15000 });
  await page.waitForSelector('.cr-finding', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
  const detailFindings = await page.$$eval('.cr-finding', (nodes) => nodes.length);
  const detailText = await pageText();
  results.push({ view: 'reviews->detail-navigation', ok: detailFindings > 0 && detailText.includes('评审摘要'), issues: detailFindings > 0 ? [] : ['点击评审行未进入有效详情'] });
  if (detailFindings === 0) failed = true;
  await shoot('reviews');
  // go back to overview for a clean reviews screenshot
  await openView('reviews');
  await shoot('reviews');

  // -- delegate engine (three-state engine / LLM delegate) -----------------
  await openView('reviews', { engine: 'delegate' });
  await checkBasic('delegate-engine');
  const delegateBadges = await page.$$eval('.cr-badge', (nodes) => nodes.filter((node) => (node.textContent || '').trim() === 'delegate').length);
  const delegateText = await pageText();
  if (delegateBadges < 3) {
    results[results.length - 1].issues.push(`delegate 引擎徽章数量不足：${delegateBadges}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  if (!delegateText.includes('DSH 模型')) {
    results[results.length - 1].issues.push('HUD 未显示 LLM DSH 模型');
    results[results.length - 1].ok = false;
    failed = true;
  }
  results[results.length - 1].delegateBadges = delegateBadges;
  const completedHandle = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('[data-job-row]')];
    return rows.find((row) => row.textContent.includes('已完成')) || rows[0];
  });
  await completedHandle.asElement().click();
  await page.waitForSelector('.cr-app[data-view="detail"]', { timeout: 15000 });
  await page.waitForSelector('.cr-finding', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const delegateDetailText = await pageText();
  const delegateDetailIssues = [];
  if (!delegateDetailText.includes('OCR 选文件 + DSH 模型评审')) delegateDetailIssues.push('详情副标题未显示 delegate 说明');
  if (!delegateDetailText.includes('delegate')) delegateDetailIssues.push('详情页未显示 delegate 引擎');
  results.push({ view: 'delegate-detail', ok: delegateDetailIssues.length === 0, issues: delegateDetailIssues });
  if (delegateDetailIssues.length) failed = true;

  // -- detail --------------------------------------------------------------
  await openView('detail');
  await checkBasic('detail');
  const headTitle = await page.$eval('.cr-detail-title', (node) => node.textContent || '').catch(() => '');
  const jobId = await page.evaluate(() => document.querySelector('.cr-app')?.getAttribute('data-view'));
  const findings = await page.$$eval('.cr-finding', (nodes) => nodes.length);
  const stages = await page.$$eval('.cr-stage', (nodes) => nodes.length);
  const critical = await page.$$eval('.cr-finding', (nodes) => nodes.filter((node) => node.textContent.includes('严重')).length);
  const detailIssues = [];
  if (jobId !== 'detail') detailIssues.push('未进入 detail 视图');
  if (!headTitle) detailIssues.push('详情标题为空');
  if (findings < 4) detailIssues.push(`finding 数量不足：${findings}`);
  if (stages < 5) detailIssues.push(`阶段数量不足：${stages}`);
  if (critical < 1) detailIssues.push('未渲染 critical finding');
  const sidePanel = await page.$('.cr-detail > .cr-detail-side');
  if (!sidePanel) detailIssues.push('详情页右侧 sticky 概览卡缺失');
  const sideCards = await page.$$eval('.cr-detail-side .cr-card', (nodes) => nodes.length);
  if (sideCards < 3) detailIssues.push(`右侧概览卡不足：${sideCards}`);
  const hasFixButton = await page.$$eval('.cr-btn', (nodes) => nodes.some((node) => node.textContent.includes('修复 Session')));
  if (!hasFixButton) detailIssues.push('详情页缺少“新建修复 Session”按钮');
  results.push({ view: 'detail', ok: detailIssues.length === 0, issues: detailIssues, findings, stages, title: headTitle });
  if (detailIssues.length) failed = true;
  await shoot('detail');

  // -- fixed finding marker -------------------------------------------------
  const markClicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '标记已修复');
    if (button) button.click();
    return Boolean(button);
  });
  await page.waitForTimeout(500);
  const marked = await page.evaluate(() => ({
    fixed: document.querySelectorAll('.cr-finding[data-fixed="1"]').length,
    badge: [...document.querySelectorAll('.cr-finding .cr-badge')].some((node) => node.textContent.includes('已修复')),
  }));
  const markOk = markClicked && marked.fixed >= 1 && marked.badge;
  results.push({ view: 'fixed-mark', ok: markOk, issues: markOk ? [] : [`已修复标记未生效：clicked=${markClicked} fixed=${marked.fixed} badge=${marked.badge}`] });
  if (!markOk) failed = true;
  await page.screenshot({ path: join(SHOTS, 'code-review-fixed.png'), fullPage: false, animations: 'disabled' });

  // -- fix session draft ----------------------------------------------------
  const fixClicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('新建修复 Session'));
    if (button) button.click();
    return Boolean(button);
  });
  await page.waitForTimeout(800);
  const draft = await page.evaluate(() => window.__START_SESSION__ || null);
  const fixToast = await page.$$eval('.cr-toasts', (nodes) => nodes.map((node) => node.textContent).join(' '));
  const draftOk = Boolean(fixClicked
    && draft
    && draft.workspaceId === 'ws-demo'
    && String(draft.options?.prompt || '').includes('代码修复助手')
    && /已新建会话并填入修复提示词/.test(fixToast));
  results.push({
    view: 'fix-draft',
    ok: draftOk,
    issues: draftOk ? [] : [`修复会话 draft 未生效：clicked=${fixClicked} workspace=${draft?.workspaceId || ''} prompt=${Boolean(draft?.options?.prompt)} toast=${fixToast}`],
  });
  if (!draftOk) failed = true;

  // -- launch --------------------------------------------------------------
  await openView('launch');
  await checkBasic('launch');
  const typeCardColor = await page.$eval('.cr-type-card', (element) => getComputedStyle(element).color);
  const typeCardLuma = (typeCardColor.match(/\d+/g) || []).slice(0, 3)
    .map(Number).reduce((sum, value) => sum + value, 0) / 3;
  if (!(typeCardLuma > 150)) {
    results[results.length - 1].issues.push(`评审类型卡标题颜色过暗：${typeCardColor}（luma ${typeCardLuma.toFixed(0)}，要求 > 150）`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  const modal = await page.$('.cr-modal');
  const typeCards = await page.$$eval('.cr-type-card', (nodes) => nodes.length);
  const launchAddOptions = await page.$$eval('.cr-modal select option', (nodes) => nodes.filter((node) => node.value === '__add__').length);
  if (launchAddOptions < 1) {
    results[results.length - 1].issues.push('新建评审的项目下拉缺少“添加项目路径”选项');
    results[results.length - 1].ok = false;
    failed = true;
  }
  if (!modal || typeCards !== 6) {
    results[results.length - 1].issues.push(`新建评审弹层异常：modal=${Boolean(modal)} typeCards=${typeCards}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  await page.click('.cr-type-card:nth-child(2)');
  await page.waitForTimeout(200);
  await shoot('launch');

  // -- projects ------------------------------------------------------------
  await openView('projects');
  await checkBasic('projects');
  const projectCards = await page.$$eval('[data-project-card]', (nodes) => nodes.length);
  const miniCells = await page.$$eval('[data-mini-heat] .cr-mini-cell', (nodes) => nodes.length);
  if (projectCards < 8) {
    results[results.length - 1].issues.push(`项目卡数量异常：${projectCards}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  if (miniCells < 80) {
    results[results.length - 1].issues.push(`mini 热力图格子不足：${miniCells}（要求 >= 80）`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  results[results.length - 1].miniCells = miniCells;
  await shoot('projects');

  // -- add project dialog (folder browser + manual input) --------------------
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent.includes('添加项目') && node.closest('.cr-card'));
    if (button) button.click();
  });
  await page.waitForSelector('.cr-modal input.cr-input', { timeout: 8000 });
  const hasBrowserButton = await page.evaluate(() => [...document.querySelectorAll('.cr-modal button')]
    .some((node) => node.textContent.includes('浏览文件夹')));
  if (!hasBrowserButton) {
    results.push({ view: 'add-project', ok: false, issues: ['添加项目弹层缺少“浏览文件夹”按钮'] });
    failed = true;
  } else {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.cr-modal button')]
        .find((node) => node.textContent.includes('浏览文件夹'));
      if (button) button.click();
    });
    try {
      await page.waitForSelector('[data-dir-entry]', { timeout: 8000 });
      await page.screenshot({ path: join(SHOTS, 'code-review-add-project.png'), fullPage: false, animations: 'disabled' });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('.cr-modal button')]
          .find((node) => node.textContent.includes('选择此文件夹'));
        if (button) button.click();
      });
      await page.waitForFunction(() => {
        const inputs = [...document.querySelectorAll('.cr-modal input.cr-input')];
        return inputs.some((input) => input.value && input.value.includes('/Users/jkin/workspace'));
      }, { timeout: 8000 });
      results.push({ view: 'add-project', ok: true, issues: [] });
    } catch (error) {
      results.push({ view: 'add-project', ok: false, issues: [`文件夹浏览器未回填路径：${error.message}`] });
      failed = true;
    }
  }

  // -- architecture --------------------------------------------------------
  await openView('architecture');
  await page.waitForFunction(() => document.querySelectorAll('.cr-graph-node').length > 0, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await checkBasic('architecture');
  const archNodes = await page.$$eval('.cr-graph-node', (nodes) => nodes.length);
  if (archNodes < 5) {
    results[results.length - 1].issues.push(`架构图节点不足：${archNodes}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  await page.click('.cr-graph-node');
  await page.waitForTimeout(300);
  await page.mouse.move(700, 960);
  await page.waitForTimeout(300);
  await shoot('architecture');

  // -- flow ----------------------------------------------------------------
  await openView('flow');
  await page.waitForFunction(() => document.querySelectorAll('.cr-graph-node').length > 0, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await checkBasic('flow');
  const flowNodes = await page.$$eval('.cr-graph-node', (nodes) => nodes.length);
  if (flowNodes < 5) {
    results[results.length - 1].issues.push(`信息流节点不足：${flowNodes}`);
    results[results.length - 1].ok = false;
    failed = true;
  }
  await page.click('.cr-graph-node');
  await page.waitForTimeout(300);
  await page.mouse.move(700, 960);
  await page.waitForTimeout(300);
  await shoot('flow');

  // -- settings (bonus capture, not part of the 7 required shots) -----------
  await openView('settings');
  await checkBasic('settings');
  const drawer = await page.$('.cr-drawer');
  results.push({ view: 'settings', ok: Boolean(drawer), issues: drawer ? [] : ['设置抽屉未渲染'] });
  if (!drawer) failed = true;
  await shoot('settings');

  await browser.close();
  await new Promise((done) => server.close(done));

  console.log('\n=== code-review preview shoot ===');
  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    const extra = [
      result.heatCells != null ? `heatCells=${result.heatCells}` : '',
      result.statCards != null ? `stats=${result.statCards}` : '',
      result.findings != null ? `findings=${result.findings}` : '',
      result.stages != null ? `stages=${result.stages}` : '',
      result.title ? `title=${result.title.slice(0, 24)}` : '',
    ].filter(Boolean).join(' · ');
    console.log(`[${status}] ${result.view}${extra ? ` (${extra})` : ''}${result.issues.length ? `\n         ↳ ${result.issues.join('\n         ↳ ')}` : ''}`);
  }
  console.log(`\nshots → docs/screenshots/code-review-*.png`);
  if (failed) {
    console.error('\nRESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('\nRESULT: PASS');
  }
}

main().catch((error) => {
  console.error('[shoot] fatal:', error);
  process.exitCode = 1;
});
