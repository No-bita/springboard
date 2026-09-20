import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

// Setup minimal browser globals before importing browser script
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { search: '?id=test_123' }
  };
} else if (!globalThis.window.location) {
  globalThis.window.location = { search: '?id=test_123' };
}

const mockElements = {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: (id) => {
      if (!mockElements[id]) {
        mockElements[id] = { textContent: '', style: {}, display: '' };
      }
      return mockElements[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
}

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const caseDetailJsPath = path.join(rootDir, 'public', 'js', 'case-detail.js');
await import(`file://${caseDetailJsPath}`);

const {
  resolveDeliveryStatus,
  resolveActionStatus,
  renderBanner,
  buildContactContextLine,
  formatRelativeTime,
  renderNextAction,
  formatShortDate,
  getFirstName
} = globalThis.window;

test('Contact Sub-Page Delivery & Action Status Pill Tests', async (t) => {

  await t.test('1. Uncontacted new target defaults to "Not Contacted" delivery and "Idle" action status (never "New")', () => {
    const contact = {
      id: 'cnt_1',
      name: 'Priya Sharma',
      status: 'lead'
    };

    const delivery = resolveDeliveryStatus(contact, [], null);
    const action = resolveActionStatus(contact, [], []);

    assert.strictEqual(delivery.label, 'Not Contacted');
    assert.strictEqual(delivery.color, '#6E6A62');
    assert.notStrictEqual(delivery.label, 'New');

    assert.strictEqual(action.label, 'Idle');
    assert.strictEqual(action.color, '#6E6A62');
    assert.notStrictEqual(action.label, 'New');
  });

  await t.test('2. Delivered outbound message yields "Delivered" delivery and "Waiting on Them" action status', () => {
    const contact = {
      id: 'cnt_2',
      name: 'Rohan Gupta'
    };
    const messages = [
      { id: 'm1', direction: 'outbound', delivery_status: 'delivered', created_at: new Date().toISOString() }
    ];

    const delivery = resolveDeliveryStatus(contact, messages, null);
    const action = resolveActionStatus(contact, messages, []);

    assert.strictEqual(delivery.label, 'Delivered');
    assert.strictEqual(delivery.color, '#1D4ED8');
    assert.strictEqual(action.label, 'Waiting on Them');
    assert.strictEqual(action.color, '#2563EB');
  });

  await t.test('3. Failed outbound message yields "Failed" delivery and "Needs Attention" action status', () => {
    const contact = {
      id: 'cnt_3',
      name: 'Aditi Roy'
    };
    const messages = [
      { id: 'm2', direction: 'outbound', delivery_status: 'failed', created_at: new Date().toISOString() }
    ];

    const delivery = resolveDeliveryStatus(contact, messages, null);
    const action = resolveActionStatus(contact, messages, []);

    assert.strictEqual(delivery.label, 'Failed');
    assert.strictEqual(delivery.color, '#991B1B');
    assert.strictEqual(action.label, 'Needs Attention');
    assert.strictEqual(action.color, '#DC2626');
  });

  await t.test('4. Inbound customer reply yields "Replied" delivery and "Recently Replied" action status', () => {
    const contact = {
      id: 'cnt_4',
      name: 'Vikram Singh',
      lastInboundAt: new Date().toISOString()
    };
    const messages = [
      { id: 'm1', direction: 'outbound', delivery_status: 'read' },
      { id: 'm2', direction: 'inbound', text: 'Yes, interested!' }
    ];

    const delivery = resolveDeliveryStatus(contact, messages, { hasReplied: true });
    const action = resolveActionStatus(contact, messages, []);

    assert.strictEqual(delivery.label, 'Replied');
    assert.strictEqual(delivery.color, '#15803D');
    assert.strictEqual(action.label, 'Recently Replied');
    assert.strictEqual(action.color, '#059669');
  });

  await t.test('5. renderBanner populates clientDeliveryBadge on header without action status pill', () => {
    const contact = {
      id: 'cnt_5',
      name: 'Meera Nair',
      status: 'lead'
    };

    renderBanner(contact, [], null, []);

    const deliveryBadge = mockElements['clientDeliveryBadge'];

    assert.ok(deliveryBadge, 'clientDeliveryBadge element should be populated');
    assert.strictEqual(deliveryBadge.textContent, 'Not Contacted');
  });

  await t.test('6. renderBanner populates Contact Details modal fields and supports modal open/close', () => {
    const contact = {
      id: 'cnt_6',
      name: 'Karan Patel',
      phoneNumber: '+919123456907',
      email: 'karan22@gmail.com',
      company: 'Patel Logistics',
      notes: 'VIP Client'
    };

    renderBanner(contact, [], null, []);

    assert.strictEqual(mockElements['modalContactName'].textContent, 'Karan Patel');
    assert.strictEqual(mockElements['modalContactPhone'].textContent, '+9191****907');
    assert.strictEqual(mockElements['modalContactEmail'].textContent, 'kar***22@gmail.com');
    assert.strictEqual(mockElements['modalContactCompany'].textContent, 'Patel Logistics');
    assert.strictEqual(mockElements['modalContactNotes'].textContent, 'VIP Client');

    const backdrop = globalThis.document.getElementById('contactDetailsModalBackdrop');
    backdrop.hidden = true;

    globalThis.window.openContactDetailsModal();
    assert.strictEqual(backdrop.hidden, false, 'Modal should be visible after openContactDetailsModal()');

    globalThis.window.closeContactDetailsModal();
    assert.strictEqual(backdrop.hidden, true, 'Modal should be hidden after closeContactDetailsModal()');
  });

  await t.test('7. buildContactContextLine generates concise contextual lines and populates contactContextLine', () => {
    const contactA = {
      name: 'Rohan Verma',
      company: 'Acme Corp'
    };
    const ctxA = buildContactContextLine(contactA, [], []);
    assert.strictEqual(ctxA, 'Acme Corp');

    const contactEmpty = {
      name: 'Priya Sharma'
    };
    const ctxEmpty = buildContactContextLine(contactEmpty, [], []);
    assert.strictEqual(ctxEmpty, '');

    const contactB = {
      name: 'Suresh Kumar',
      company: 'TechFlow',
      lastOutboundAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
    };
    const messagesB = [
      { id: 'm1', direction: 'outbound', channel: 'whatsapp', delivery_status: 'delivered', created_at: contactB.lastOutboundAt }
    ];
    const ctxB = buildContactContextLine(contactB, messagesB, []);
    assert.strictEqual(ctxB, 'TechFlow · Delivered 30m ago via WhatsApp');

    const contactC = {
      name: 'Ananya Roy',
      lastInboundAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    };
    const messagesC = [
      { id: 'm1', direction: 'outbound', channel: 'whatsapp', delivery_status: 'read', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      { id: 'm2', direction: 'inbound', channel: 'whatsapp', text: 'Sounds great', created_at: contactC.lastInboundAt }
    ];
    const requestsC = [
      { id: 'r1', title: 'Sign NDA', status: 'open' }
    ];
    const ctxC = buildContactContextLine(contactC, messagesC, requestsC);
    assert.strictEqual(ctxC, 'Replied 10m ago via WhatsApp · Request: Sign NDA');

    // Test renderBanner sets contactContextLine element
    renderBanner(contactC, messagesC, null, requestsC);
    const contextEl = mockElements['contactContextLine'];
    assert.ok(contextEl);
  });

  await t.test('8. Next Action State 1: No outreach yet displays prompt to send first message', () => {
    const contact = { id: 'c1', name: 'Aaryan Shah' };
    renderNextAction(contact, [], [], []);

    const contentEl = mockElements['nextActionContent'];
    assert.ok(contentEl);
    assert.ok(contentEl.innerHTML.includes('No outreach yet.'));
    assert.ok(contentEl.innerHTML.includes('Send the first message to start the conversation.'));
    assert.ok(contentEl.innerHTML.includes('Send message'));
  });

  await t.test('9. Next Action State 2: Outbound message shows follow-up timing, message quote, and reschedule option', () => {
    const contact = { id: 'c2', name: 'Aaryan Shah' };
    const messages = [
      {
        id: 'm1',
        direction: 'outbound',
        content: "Hey Aaryan, loved what you're building...",
        delivery_status: 'delivered',
        created_at: new Date().toISOString()
      }
    ];

    renderNextAction(contact, messages, [], []);

    const contentEl = mockElements['nextActionContent'];
    assert.ok(contentEl);
    assert.ok(contentEl.innerHTML.includes('Follow up in 2 days.'));
    assert.ok(contentEl.innerHTML.includes('Last message'));
    assert.ok(contentEl.innerHTML.includes("Hey Aaryan, loved what you&#039;re building..."));
    assert.ok(contentEl.innerHTML.includes('Follow up now'));
    assert.ok(contentEl.innerHTML.includes('Reschedule'));
  });

  await t.test('10. Next Action State 3: Target reply shows "Reply to [Name]" and response time', () => {
    const contact = { id: 'c3', name: 'Aaryan Shah' };
    const messages = [
      {
        id: 'm1',
        direction: 'outbound',
        content: 'Hi Aaryan',
        created_at: new Date(Date.now() - 3600 * 1000).toISOString()
      },
      {
        id: 'm2',
        direction: 'inbound',
        content: 'Thanks, lets talk tomorrow!',
        created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString()
      }
    ];

    renderNextAction(contact, messages, [], []);

    const contentEl = mockElements['nextActionContent'];
    assert.ok(contentEl);
    assert.ok(contentEl.innerHTML.includes('Reply to Aaryan.'));
    assert.ok(contentEl.innerHTML.includes('Received · 12m ago'));
    assert.ok(contentEl.innerHTML.includes('Reply'));
  });
});

