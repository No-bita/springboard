import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

// Setup minimal browser globals before importing browser script
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    getVariantKey: () => 'ca',
    applyVariantToDOM: () => {},
    location: { hostname: 'localhost' }
  };
} else if (!globalThis.window.location) {
  globalThis.window.location = { hostname: 'localhost' };
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
} else {
  if (!globalThis.document.querySelector) globalThis.document.querySelector = () => null;
  if (!globalThis.document.querySelectorAll) globalThis.document.querySelectorAll = () => [];
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
}

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const appJsPath = path.join(rootDir, 'public', 'js', 'app.js');
await import(`file://${appJsPath}`);
const {
  getDisplayStatus,
  formatWhatsAppDeliveryStatus,
  formatStatus,
  WHATSAPP_STATUS_ORDER
} = globalThis.window;

test('Mode-Dependent Status Presentation & Filtering Tests', async (t) => {

  await t.test('1. Direct Outreach dropdown shows delivery statuses, not Lead', () => {
    const directOutreachCases = [
      { id: '1', status: 'lead', whatsappDeliveryStatus: 'delivered', loanProduct: 'Direct Outreach' },
      { id: '2', status: 'lead', whatsappDeliveryStatus: 'sent', loanProduct: 'Direct Outreach' },
      { id: '3', status: 'lead', whatsappDeliveryStatus: 'failed', loanProduct: 'Direct Outreach' }
    ];

    const statuses = new Set();
    directOutreachCases.forEach(c => {
      const st = getDisplayStatus(c, 'direct_outreach');
      if (st) statuses.add(st);
    });

    assert.ok(!statuses.has('lead'), 'Direct Outreach status set must NOT contain "lead"');
    assert.ok(statuses.has('delivered'), 'Direct Outreach status set must contain "delivered"');
    assert.ok(statuses.has('sent'), 'Direct Outreach status set must contain "sent"');
    assert.ok(statuses.has('failed'), 'Direct Outreach status set must contain "failed"');
  });

  await t.test('2. Selecting Delivered shows only delivered targets', () => {
    const targets = [
      { id: 'c1', status: 'lead', whatsappDeliveryStatus: 'delivered', loanProduct: 'Direct Outreach' },
      { id: 'c2', status: 'lead', whatsappDeliveryStatus: 'sent', loanProduct: 'Direct Outreach' },
      { id: 'c3', status: 'lead', whatsappDeliveryStatus: 'failed', loanProduct: 'Direct Outreach' },
      { id: 'c4', status: 'lead', whatsappDeliveryStatus: 'delivered', loanProduct: 'Direct Outreach' }
    ];

    const selectedFilter = 'delivered';
    const filtered = targets.filter(c => {
      const displayStatus = getDisplayStatus(c, 'direct_outreach');
      if (selectedFilter !== 'all' && displayStatus !== selectedFilter) return false;
      return true;
    });

    assert.strictEqual(filtered.length, 2);
    assert.deepStrictEqual(filtered.map(c => c.id), ['c1', 'c4']);
  });

  await t.test('3. sent/delivered/read/failed map correctly', () => {
    assert.strictEqual(formatWhatsAppDeliveryStatus('sent'), 'Sent');
    assert.strictEqual(formatWhatsAppDeliveryStatus('delivered'), 'Delivered');
    assert.strictEqual(formatWhatsAppDeliveryStatus('read'), 'Read');
    assert.strictEqual(formatWhatsAppDeliveryStatus('replied'), 'Replied');
    assert.strictEqual(formatWhatsAppDeliveryStatus('failed'), 'Failed');
    assert.strictEqual(formatWhatsAppDeliveryStatus('dispatch_requested'), 'Dispatch Requested');
    assert.strictEqual(formatWhatsAppDeliveryStatus('pending'), 'Pending');
  });

  await t.test('4. Legacy whatsapp_delivery_status fallback works', () => {
    const legacyCase = {
      id: 'legacy_1',
      status: 'lead',
      whatsapp_delivery_status: 'delivered' // snake_case fallback
    };

    const displayStatus = getDisplayStatus(legacyCase, 'direct_outreach');
    assert.strictEqual(displayStatus, 'delivered');
  });

  await t.test('5. Non-Direct-Outreach mode continues filtering on c.status', () => {
    const caCases = [
      { id: 'ca1', status: 'lead', loanProduct: 'ITR Filing', whatsappDeliveryStatus: 'sent' },
      { id: 'ca2', status: 'documents_pending', loanProduct: 'GST Filing', whatsappDeliveryStatus: 'delivered' },
      { id: 'ca3', status: 'ready_for_review', loanProduct: 'Tax Audit', whatsappDeliveryStatus: 'failed' }
    ];

    const status1 = getDisplayStatus(caCases[0], 'ca');
    const status2 = getDisplayStatus(caCases[1], 'ca');
    const status3 = getDisplayStatus(caCases[2], 'loan_agent');

    assert.strictEqual(status1, 'lead');
    assert.strictEqual(status2, 'documents_pending');
    assert.strictEqual(status3, 'ready_for_review');

    // Filter verification
    const selectedFilter = 'documents_pending';
    const filtered = caCases.filter(c => {
      const displayStatus = getDisplayStatus(c, 'ca');
      if (selectedFilter !== 'all' && displayStatus !== selectedFilter) return false;
      return true;
    });

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, 'ca2');
  });

  await t.test('6. A case with no WhatsApp status does not accidentally become undefined or disappear unexpectedly', () => {
    const caseWithoutWa = {
      id: 'no_wa_1',
      status: 'lead',
      loanProduct: 'Direct Outreach'
    };

    const displayStatus = getDisplayStatus(caseWithoutWa, 'direct_outreach');
    assert.strictEqual(displayStatus, 'pending');
    assert.notStrictEqual(displayStatus, 'undefined');
    assert.notStrictEqual(displayStatus, null);
    assert.strictEqual(formatWhatsAppDeliveryStatus(displayStatus), 'Pending');
  });

  await t.test('7. Table badge and filter use the same resolved status', () => {
    const testCase = {
      id: 'target_99',
      status: 'lead',
      whatsappDeliveryStatus: 'read',
      loanProduct: 'Direct Outreach'
    };

    // Derived once via single source of truth
    const resolvedStatus = getDisplayStatus(testCase, 'direct_outreach');
    
    // 1. Used in filter
    const matchesFilter = (resolvedStatus === 'read');
    assert.ok(matchesFilter, 'Filter must match resolved status');

    // 2. Used in badge formatting
    const formattedLabel = formatWhatsAppDeliveryStatus(resolvedStatus);
    assert.strictEqual(formattedLabel, 'Read', 'Badge must use the exact resolved status label');

    // 3. Invariant: Table and Filter are guaranteed identical
    assert.strictEqual(resolvedStatus, 'read');
  });

  await t.test('8. WHATSAPP_STATUS_ORDER provides canonical deterministic sorting', () => {
    assert.deepStrictEqual(WHATSAPP_STATUS_ORDER, [
      'queued',
      'dispatch_requested',
      'pending',
      'sent',
      'delivered',
      'read',
      'replied',
      'failed'
    ]);

    const unsorted = ['failed', 'sent', 'delivered'];
    unsorted.sort((a, b) => {
      const idxA = WHATSAPP_STATUS_ORDER.indexOf(a);
      const idxB = WHATSAPP_STATUS_ORDER.indexOf(b);
      return idxA - idxB;
    });
    assert.deepStrictEqual(unsorted, ['sent', 'delivered', 'failed']);
  });

  await t.test('9. Cumulative delivery funnel correctly counts cumulative stages', () => {
    // 38 cases matching user scenario:
    // 2 failed/pending, 3 sent, 7 delivered, 25 read, 1 replied (total 38)
    const mockCases = [
      ...Array(2).fill(null).map((_, i) => ({ id: `p${i}`, whatsappDeliveryStatus: 'pending' })),
      ...Array(3).fill(null).map((_, i) => ({ id: `s${i}`, whatsappDeliveryStatus: 'sent' })),
      ...Array(7).fill(null).map((_, i) => ({ id: `d${i}`, whatsappDeliveryStatus: 'delivered' })),
      ...Array(25).fill(null).map((_, i) => ({ id: `r${i}`, whatsappDeliveryStatus: 'read' })),
      ...Array(1).fill(null).map((_, i) => ({ id: `rep${i}`, whatsappDeliveryStatus: 'replied' }))
    ];

    const sentStatuses = new Set(['sent', 'delivered', 'read', 'replied']);
    const delivStatuses = new Set(['delivered', 'read', 'replied']);
    const readStatuses = new Set(['read', 'replied']);
    const repStatuses = new Set(['replied']);

    const sentCount = mockCases.filter(c => sentStatuses.has(getDisplayStatus(c, 'direct_outreach'))).length;
    const delivCount = mockCases.filter(c => delivStatuses.has(getDisplayStatus(c, 'direct_outreach'))).length;
    const readCount = mockCases.filter(c => readStatuses.has(getDisplayStatus(c, 'direct_outreach'))).length;
    const repCount = mockCases.filter(c => repStatuses.has(getDisplayStatus(c, 'direct_outreach'))).length;

    assert.strictEqual(sentCount, 36); // 3 + 7 + 25 + 1 = 36 dispatched successfully
    assert.strictEqual(delivCount, 33); // 7 + 25 + 1 = 33 delivered to handset
    assert.strictEqual(readCount, 26); // 25 + 1 = 26 read by recipient
    assert.strictEqual(repCount, 1); // 1 replied
  });
});
