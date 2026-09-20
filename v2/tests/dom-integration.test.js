import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('Full DOM Page Load & Integration Test', async (t) => {
  const rootDir = fs.existsSync(path.join(process.cwd(), 'public'))
    ? process.cwd()
    : path.join(process.cwd(), 'v2');

  const dashboardHtmlPath = path.join(rootDir, 'public', 'dashboard.html');
  const htmlContent = fs.readFileSync(dashboardHtmlPath, 'utf8');

  await t.test('1. Verify all critical UI element IDs exist in dashboard.html', () => {
    const requiredIds = [
      'tbody',
      'search',
      'statusFilter',
      'dashboardError',
      'modalBackdrop',
      'wizardModal',
      'contactStage1',
      'contactStage2',
      'contactName',
      'contactPhone',
      'contactEmail',
      'btnSaveTargetOnly',
      'btnStage1Next',
      'contactChannel',
      'contactTemplate',
      'templatePreviewContainer',
      'templatePreviewText',
      'btnSubmitContact',
      'triageCardAttention',
      'triageCardFollowUp',
      'triageCardWaiting',
      'triageCardReplied',
      'userAvatar',
      'userName',
      'userRole',
      'btnOpenBulkImportModal',
      'bulkImportBackdrop',
      'bulkCsvDropzone',
      'btnRunBulkImport'
    ];

    requiredIds.forEach(id => {
      assert.ok(
        htmlContent.includes(`id="${id}"`),
        `Missing critical DOM element id="${id}" in dashboard.html`
      );
    });
  });

  await t.test('2. Verify table headers (Name, Last Message, commented-out Last Activity)', () => {
    assert.ok(htmlContent.includes('id="thCustomer">Name</th>'), 'thCustomer must be labeled "Name"');
    assert.ok(htmlContent.includes('id="thLatestMessage">Last Message</th>'), 'thLatestMessage must be labeled "Last Message"');
    assert.ok(htmlContent.includes('<!-- <th') && htmlContent.includes('id="thLastActivity"'), 'thLastActivity must be commented out');
  });

  await t.test('3. Verify static script tags are loaded cleanly', () => {
    const appJsIdx = htmlContent.indexOf('/js/app.js');
    assert.ok(appJsIdx !== -1, 'app.js script tag missing');
  });

  await t.test('4. Verify table-card element is top-level and not enclosed inside hidden error banner', () => {
    const errDivIdx = htmlContent.indexOf('id="dashboardError"');
    const tableCardIdx = htmlContent.indexOf('class="table-card"');
    assert.ok(errDivIdx !== -1 && tableCardIdx !== -1, 'Elements missing');
    const snippetBetween = htmlContent.slice(errDivIdx, tableCardIdx);
    assert.ok(snippetBetween.includes('</div>'), 'dashboardError div was not closed before table-card element!');
  });
});
