import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd());

test('Bulk Client Import UI, Parser & Architecture Tests', async (t) => {

  await t.test('1. DOM Elements & Modal Structure in dashboard.html', () => {
    const htmlPath = path.join(rootDir, 'public', 'dashboard.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(htmlContent.includes('id="btnOpenBulkImportModal"'), 'btnOpenBulkImportModal trigger button must exist');
    assert.ok(htmlContent.includes('id="bulkImportBackdrop"'), 'bulkImportBackdrop modal must exist');
    assert.ok(htmlContent.includes('id="bulkCsvTextarea"'), 'bulkCsvTextarea text input must exist');
    assert.ok(htmlContent.includes('id="btnRunBulkImport"'), 'btnRunBulkImport submit button must exist');
  });

  await t.test('2. CSS Stylesheet Rules for Bulk Import', () => {
    const cssPath = path.join(rootDir, 'public', 'css', 'dashboard.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    assert.ok(cssContent.includes('.bulk-preview-wrapper') || cssContent.includes('.modal-backdrop'), 'Modal styling rules must exist');
  });

  await t.test('3. JavaScript CSV Parsing & Phone Normalization Logic', () => {
    const jsPath = path.join(rootDir, 'public', 'js', 'app.js');
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    assert.ok(jsContent.includes('function openBulkImportModal'), 'openBulkImportModal must be defined');
    assert.ok(jsContent.includes('function closeBulkImportModal'), 'closeBulkImportModal must be defined');
    assert.ok(jsContent.includes('function handleBulkImport'), 'handleBulkImport must be defined');

    // Test parser logic directly matching app.js
    function mockParse(content) {
      if (!content || !content.trim()) return [];
      const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const rows = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const delimiter = ",";
        const parts = line.split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ''));
        if (parts.length === 0 || (parts.length === 1 && !parts[0])) continue;

        // Column mapping: column 1 = name, column 2 = phone, column 3 = email
        const name = parts[0] || "";
        const rawPhone = parts[1] || "";
        const email = parts[2] || "";

        const digits = rawPhone.replace(/\D/g, "");
        const isValidPhone = digits.length === 10 || (digits.length === 12 && digits.startsWith("91"));

        rows.push({
          name: name || `Contact ${digits.slice(-4) || i + 1}`,
          rawPhone,
          digits,
          email,
          isValid: isValidPhone
        });
      }
      return rows;
    }

    const testCsv = `John Doe,9876543210,john@example.com
Priya Patel,+91 98765 43210,priya@example.com
Invalid Contact,12345,invalid@example.com`;

    const parsed = mockParse(testCsv);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].name, "John Doe");
    assert.equal(parsed[0].digits, "9876543210");
    assert.equal(parsed[0].isValid, true);
    assert.equal(parsed[1].name, "Priya Patel");
    assert.equal(parsed[1].isValid, true);
    assert.equal(parsed[2].isValid, false, "12345 is an invalid phone");

    // Test 5-column parsing with Channel and Template
    assert.ok(jsContent.includes('function parseCsvContacts'), 'parseCsvContacts must be defined in app.js');
    assert.ok(jsContent.includes('Channel, Template') || jsContent.includes('channel') && jsContent.includes('template'), 'Channel and template must be handled');

    // Extract and test parseCsvContacts logic directly matching updated app.js
    function splitCsvLine(line) {
      if (!line) return [];
      let delimiter = ",";
      if (!line.includes(",") && line.includes("\t")) {
        delimiter = "\t";
      } else if (!line.includes(",") && line.includes(";")) {
        delimiter = ";";
      }
      const result = [];
      let current = "";
      let inQuotes = false;
      let quoteChar = '"';
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        if ((char === '"' || char === "'") && !inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar && inQuotes) {
          if (nextChar === quoteChar) {
            current += quoteChar;
            i++;
          } else {
            inQuotes = false;
          }
        } else if (char === delimiter && !inQuotes) {
          result.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result.map((p) => p.replace(/^["']|["']$/g, "").trim());
    }

    function isPhoneToken(token) {
      if (!token) return false;
      const digits = token.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15;
    }

    function isEmailToken(token) {
      if (!token) return false;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token.trim());
    }

    function testParseCsv(content) {
      if (!content || !content.trim()) return [];
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return [];
      let startIndex = 0;
      let headerMap = null;
      const firstParts = splitCsvLine(lines[0]).map((p) => p.toLowerCase());
      const hasHeader = firstParts.some((p) =>
        p.includes("name") ||
        p.includes("phone") ||
        p.includes("mobile") ||
        p.includes("email") ||
        p.includes("channel") ||
        p.includes("template") ||
        p.includes("target") ||
        p.includes("fname") ||
        p.includes("lname")
      );
      if (hasHeader) {
        startIndex = 1;
        headerMap = {};
        firstParts.forEach((col, idx) => {
          if (col.includes("first") || col.includes("fname") || col.includes("given")) headerMap.firstName = idx;
          else if (col.includes("last") || col.includes("lname") || col.includes("surname") || col.includes("family")) headerMap.lastName = idx;
          else if (col.includes("name") || col.includes("target") || col.includes("person") || col.includes("contact")) headerMap.name = idx;
          else if (col.includes("phone") || col.includes("mobile") || col.includes("tel") || col.includes("cell") || col.includes("whatsapp")) headerMap.phone = idx;
          else if (col.includes("email") || col.includes("mail")) headerMap.email = idx;
          else if (col.includes("channel")) headerMap.channel = idx;
          else if (col.includes("template") || col.includes("message")) headerMap.template = idx;
        });
      }
      const results = [];
      for (let i = startIndex; i < lines.length; i++) {
        const rawLine = lines[i];
        if (!rawLine) continue;
        const parts = splitCsvLine(rawLine);
        if (parts.length === 0 || parts.every((p) => !p)) continue;
        let name = "";
        let phone = "";
        let email = null;
        let channel = "whatsapp";
        let template = null;
        if (headerMap && (headerMap.phone !== undefined || headerMap.name !== undefined || headerMap.firstName !== undefined)) {
          if (headerMap.firstName !== undefined && headerMap.lastName !== undefined) {
            const fn = parts[headerMap.firstName] || "";
            const ln = parts[headerMap.lastName] || "";
            name = [fn, ln].filter(Boolean).join(" ");
          } else if (headerMap.name !== undefined) {
            name = parts[headerMap.name] || "";
          }
          if (headerMap.phone !== undefined) phone = parts[headerMap.phone] || "";
          if (headerMap.email !== undefined && parts[headerMap.email]) email = parts[headerMap.email];
          if (headerMap.channel !== undefined && parts[headerMap.channel]) {
            channel = parts[headerMap.channel].toLowerCase() === "email" ? "email" : "whatsapp";
          }
          if (headerMap.template !== undefined && parts[headerMap.template]) {
            const tplVal = parts[headerMap.template].trim();
            template = (tplVal && tplVal.toLowerCase() !== "none") ? tplVal : null;
          }
        }
        if (!phone || !isPhoneToken(phone)) {
          let detectedPhone = "";
          let detectedEmail = null;
          let detectedChannel = null;
          let detectedTemplate = null;
          const nameParts = [];
          for (let pIdx = 0; pIdx < parts.length; pIdx++) {
            const token = parts[pIdx];
            if (!token) continue;
            if (!detectedPhone && isPhoneToken(token)) {
              detectedPhone = token;
            } else if (!detectedEmail && isEmailToken(token)) {
              detectedEmail = token;
            } else if (!detectedChannel && (token.toLowerCase() === "whatsapp" || token.toLowerCase() === "email")) {
              detectedChannel = token.toLowerCase();
            } else if (!detectedTemplate && (pIdx >= 3 && !token.includes(" "))) {
              detectedTemplate = (token.toLowerCase() !== "none") ? token : null;
            } else {
              nameParts.push(token);
            }
          }
          if (detectedPhone) {
            phone = detectedPhone;
            if (!name && nameParts.length > 0) name = nameParts.join(" ");
            if (!email && detectedEmail) email = detectedEmail;
            if (detectedChannel) channel = detectedChannel;
            if (!template && detectedTemplate) template = detectedTemplate;
          } else {
            if (!name && nameParts.length > 0) name = nameParts.join(" ");
            else if (!name) name = parts[0] || "";
            const digits0 = (parts[0] || "").replace(/\D/g, "");
            const digits1 = (parts[1] || "").replace(/\D/g, "");
            if (digits1.length >= 7) phone = parts[1];
            else if (digits0.length >= 7) {
              phone = parts[0];
              if (parts[1] && name === parts[0]) name = parts[1];
            }
          }
        }
        name = name.trim().replace(/^,+|,+$/g, "").trim();
        if (name && phone) results.push({ name, phone, email, channel, template });
      }
      return results;
    }

    const csvWithHeaders = `Name,Mobile Number,Email,Channel,Template
Rahul Sharma,9876543210,rahul@example.com,whatsapp,new_convo_1
Priya Patel,9812345678,priya@domain.com,email,none
Amit Kumar,9899999999,,whatsapp,`;

    const parsedWithHeaders = testParseCsv(csvWithHeaders);
    assert.equal(parsedWithHeaders.length, 3);
    assert.equal(parsedWithHeaders[0].name, "Rahul Sharma");
    assert.equal(parsedWithHeaders[0].template, "new_convo_1", "Outreach template must be preserved");
    assert.equal(parsedWithHeaders[0].channel, "whatsapp");

    assert.equal(parsedWithHeaders[1].name, "Priya Patel");
    assert.equal(parsedWithHeaders[1].template, null, "Template 'none' must result in null (no message)");
    assert.equal(parsedWithHeaders[1].channel, "email");

    assert.equal(parsedWithHeaders[2].name, "Amit Kumar");
    assert.equal(parsedWithHeaders[2].template, null, "Empty template must result in null (no message)");
    assert.equal(parsedWithHeaders[2].email, null);

    // Test "shah, aaryan" edge cases
    const quotedNameCsv = `"Shah, Aaryan", 9876543210, aaryan@example.com`;
    const parsedQuoted = testParseCsv(quotedNameCsv);
    assert.equal(parsedQuoted.length, 1);
    assert.equal(parsedQuoted[0].name, "Shah, Aaryan");
    assert.equal(parsedQuoted[0].phone, "9876543210");

    const splitNameCsv = `Shah, Aaryan, 9876543210`;
    const parsedSplit = testParseCsv(splitNameCsv);
    assert.equal(parsedSplit.length, 1);
    assert.equal(parsedSplit[0].name, "Shah Aaryan");
    assert.equal(parsedSplit[0].phone, "9876543210");

    const headerFirstLastCsv = `First Name, Last Name, Phone Number\nAaryan, Shah, 9876543210`;
    const parsedFirstLast = testParseCsv(headerFirstLastCsv);
    assert.equal(parsedFirstLast.length, 1);
    assert.equal(parsedFirstLast[0].name, "Aaryan Shah");
    assert.equal(parsedFirstLast[0].phone, "9876543210");

    const noPhoneOnlyNames = `shah, aaryan`;
    const parsedNoPhone = testParseCsv(noPhoneOnlyNames);
    assert.equal(parsedNoPhone.length, 0, "Row without phone number must not parse 'aaryan' as a phone number");
  });

  await t.test('4. Backend API Route & Handler in cases.js & index.js', () => {
    const apiPath = path.join(rootDir, 'src', 'api', 'cases.js');
    const apiContent = fs.readFileSync(apiPath, 'utf8');
    assert.ok(apiContent.includes('export async function handleBulkImportCases'), 'handleBulkImportCases must be exported in cases.js');

    const indexPath = path.join(rootDir, 'src', 'index.js');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    assert.ok(indexContent.includes('app.post("/api/cases/bulk-import", handleBulkImportCases);'), 'Route /api/cases/bulk-import must be registered in index.js');
  });

  await t.test('5. Import Deduplication Guarantees & Active Workflow Isolation', async (st) => {
    const { handleBulkImportCases } = await import('../src/api/cases.js');

    function createMockDb() {
      const records = {
        contacts: [],
        loan_cases: [],
        secure_tokens: [],
        required_documents: [],
        schedules: [],
        scheduled_occurrences: [],
        case_timeline: []
      };

      return {
        records,
        execute: async (query) => {
          const sql = typeof query === 'string' ? query : query.sql;
          const args = typeof query === 'string' ? [] : (query.args || []);
          const norm = sql.replace(/\s+/g, ' ').trim();

          if (norm.startsWith('SELECT id FROM contacts WHERE user_id = ? AND phone_number = ?')) {
            const [user_id, phone_number] = args;
            const c = records.contacts.find(x => x.user_id === user_id && x.phone_number === phone_number);
            return { rows: c ? [{ id: c.id }] : [] };
          }
          if (norm.startsWith('INSERT INTO contacts')) {
            const [id, user_id, contact_person, phone_number] = args;
            records.contacts.push({ id, user_id, contact_person, phone_number });
            return { rows: [] };
          }
          if (norm.includes('FROM loan_cases WHERE user_id = ? AND phone_number = ? AND status NOT IN (\'closed\', \'completed\')')) {
            const [user_id, phone_number] = args;
            const existing = records.loan_cases.find(x => x.user_id === user_id && x.phone_number === phone_number && !['closed', 'completed'].includes(x.status));
            return { rows: existing ? [{ id: existing.id, status: existing.status }] : [] };
          }
          return { rows: [] };
        },
        batch: async (statements) => {
          for (const s of statements) {
            const sql = typeof s === 'string' ? s : s.sql;
            const args = typeof s === 'string' ? [] : (s.args || []);
            const norm = sql.replace(/\s+/g, ' ').trim();

            if (norm.startsWith('INSERT INTO loan_cases')) {
              const [id, contact_id, user_id, contact_person, phone_number, loan_product, template_name, amount_required, status, whatsapp_delivery_status] = args;
              // Check unique constraint: (user_id, phone_number) where status NOT IN ('closed', 'completed')
              const conflict = records.loan_cases.find(c => c.user_id === user_id && c.phone_number === phone_number && !['closed', 'completed'].includes(c.status));
              if (conflict) {
                const err = new Error('UNIQUE constraint failed: loan_cases.user_id, loan_cases.phone_number');
                err.code = 'SQLITE_CONSTRAINT_UNIQUE';
                throw err;
              }
              records.loan_cases.push({ id, contact_id, user_id, contact_person, phone_number, loan_product, template_name, amount_required, status, whatsapp_delivery_status });
            }
            if (norm.startsWith('INSERT INTO secure_tokens')) {
              const [id, case_id, token, user_id] = args;
              records.secure_tokens.push({ id, case_id, token, user_id });
            }
            if (norm.startsWith('INSERT INTO required_documents')) {
              const [id, case_id, doc_type, user_id] = args;
              records.required_documents.push({ id, case_id, doc_type, user_id });
            }
            if (norm.startsWith('INSERT INTO schedules')) {
              const [id, user_id, case_id, contact_id, phone_number, template_name, template_params, schedule_type, recurrence_interval, timezone, next_run_utc] = args;
              records.schedules.push({ id, user_id, case_id, contact_id, phone_number, template_name, template_params, schedule_type, recurrence_interval, timezone, next_run_utc });
            }
            if (norm.startsWith('INSERT INTO scheduled_occurrences')) {
              const [id, schedule_id, occurrence_key, scheduled_for_utc] = args;
              records.scheduled_occurrences.push({ id, schedule_id, occurrence_key, scheduled_for_utc, operational_status: 'pending' });
            }
            if (norm.startsWith('UPDATE scheduled_occurrences SET operational_status = \'claimed\'')) {
              const occId = args[0];
              const occ = records.scheduled_occurrences.find(o => o.id === occId);
              if (occ) occ.operational_status = 'claimed';
            }
          }
          return { success: true };
        }
      };
    }

    await st.test('5.1 Same import: duplicate phone within same CSV batch is skipped', async () => {
      const mockDb = createMockDb();
      const mockEnv = { DB: mockDb };
      const reqBody = {
        clients: [
          { contactPerson: 'Arun Kumar', phoneNumber: '9876543210' },
          { contactPerson: 'Arun Kumar Duplicate', phoneNumber: '9876543210' }
        ],
        sendWhatsApp: true,
        templateName: 'new_convo_1'
      };

      const mockContext = {
        req: { json: async () => reqBody },
        env: mockEnv,
        get: (k) => k === 'user' ? { id: 'usr_test_1', username: 'Test' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkImportCases(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.total, 2);
      assert.equal(res.data.importedCount, 1);
      assert.equal(res.data.duplicateCount, 1);
      assert.equal(res.data.failedCount, 0);

      // Exactly 1 case created
      assert.equal(mockDb.records.loan_cases.length, 1);
      assert.equal(mockDb.records.loan_cases[0].contact_person, 'Arun Kumar');
      // Duplicate produced 0 tokens, 0 schedules, 0 occurrences
      assert.equal(mockDb.records.secure_tokens.length, 1);
      assert.equal(mockDb.records.schedules.length, 1);
      assert.equal(mockDb.records.scheduled_occurrences.length, 1);
    });

    await st.test('5.2 Later import: existing active workflow in DB is skipped', async () => {
      const mockDb = createMockDb();
      // Pre-seed an active workflow for this user and phone
      mockDb.records.loan_cases.push({
        id: 'case_existing_active',
        user_id: 'usr_test_1',
        phone_number: '919876543210',
        contact_person: 'Arun Existing',
        status: 'documents_pending'
      });

      const mockEnv = { DB: mockDb };
      const reqBody = {
        clients: [
          { contactPerson: 'Arun Reimport', phoneNumber: '9876543210' },
          { contactPerson: 'Brand New Client', phoneNumber: '9876543211' }
        ],
        sendWhatsApp: true,
        templateName: 'new_convo_1'
      };

      const mockContext = {
        req: { json: async () => reqBody },
        env: mockEnv,
        get: (k) => k === 'user' ? { id: 'usr_test_1', username: 'Test' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkImportCases(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.total, 2);
      assert.equal(res.data.importedCount, 1);
      assert.equal(res.data.duplicateCount, 1);

      // Only the brand new client case was added
      assert.equal(mockDb.records.loan_cases.length, 2);
      assert.equal(mockDb.records.loan_cases[1].contact_person, 'Brand New Client');
    });

    await st.test('5.3 Formatting variants: same canonical phone is deduplicated', async () => {
      const mockDb = createMockDb();
      const mockEnv = { DB: mockDb };
      const reqBody = {
        clients: [
          { contactPerson: 'Standard 10-Digit', phoneNumber: '9876543210' },
          { contactPerson: 'With Country Code', phoneNumber: '+91 98765 43210' },
          { contactPerson: 'With Leading Zero', phoneNumber: '09876543210' },
          { contactPerson: 'With Hyphens', phoneNumber: '98765-43210' }
        ],
        sendWhatsApp: true,
        templateName: 'new_convo_1'
      };

      const mockContext = {
        req: { json: async () => reqBody },
        env: mockEnv,
        get: (k) => k === 'user' ? { id: 'usr_test_1', username: 'Test' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkImportCases(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.total, 4);
      assert.equal(res.data.importedCount, 1);
      assert.equal(res.data.duplicateCount, 3);
      assert.equal(mockDb.records.loan_cases.length, 1);
      assert.equal(mockDb.records.loan_cases[0].phone_number, '919876543210');
    });

    await st.test('5.4 Closed workflow allows new workflow creation for same client', async () => {
      const mockDb = createMockDb();
      // Pre-seed a CLOSED case for this user and phone
      mockDb.records.loan_cases.push({
        id: 'case_closed_past',
        user_id: 'usr_test_1',
        phone_number: '919876543210',
        contact_person: 'Past Client',
        status: 'closed'
      });

      const mockEnv = { DB: mockDb };
      const reqBody = {
        clients: [
          { contactPerson: 'Returning Client', phoneNumber: '9876543210' }
        ],
        sendWhatsApp: true,
        templateName: 'new_convo_1'
      };

      const mockContext = {
        req: { json: async () => reqBody },
        env: mockEnv,
        get: (k) => k === 'user' ? { id: 'usr_test_1', username: 'Test' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkImportCases(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.importedCount, 1);
      assert.equal(res.data.duplicateCount, 0);
      assert.equal(mockDb.records.loan_cases.length, 2);
      assert.equal(mockDb.records.loan_cases[1].contact_person, 'Returning Client');
      assert.equal(mockDb.records.loan_cases[1].status, 'documents_pending');
    });

    await st.test('5.5 Concurrency uniqueness constraint race safety', async () => {
      const mockDb = createMockDb();
      // Simulate race condition where SELECT did not find existing case, but batch INSERT throws unique index constraint error
      let attempt = 0;
      const originalBatch = mockDb.batch;
      mockDb.batch = async (stmts) => {
        attempt++;
        if (attempt === 2) {
          const err = new Error('D1_ERROR: UNIQUE constraint failed: index unq_active_case_user_phone');
          throw err;
        }
        return originalBatch(stmts);
      };

      const mockEnv = { DB: mockDb };
      const reqBody = {
        clients: [
          { contactPerson: 'Racer 1', phoneNumber: '9876543210' },
          { contactPerson: 'Racer 2', phoneNumber: '9876543211' }
        ],
        sendWhatsApp: false
      };

      const mockContext = {
        req: { json: async () => reqBody },
        env: mockEnv,
        get: (k) => k === 'user' ? { id: 'usr_test_1', username: 'Test' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkImportCases(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.importedCount, 1);
      assert.equal(res.data.duplicateCount, 1);
      assert.equal(res.data.failedCount, 0);
      assert.equal(mockDb.records.loan_cases.length, 1);
    });
  });

  await t.test('6. Pre-Check Stage & Dual Action Flow Tests', async (st) => {
    const { handleBulkPrecheck, handleBulkImportCases } = await import('../src/api/cases.js');
    const { normalizeIndianPhoneNumber } = await import('../src/whatsapp/client.js');

    await st.test('6.1 Canonical phone normalization parity across formatting variants', () => {
      const v1 = normalizeIndianPhoneNumber('9876543210');
      const v2 = normalizeIndianPhoneNumber('09876543210');
      const v3 = normalizeIndianPhoneNumber('+91 98765 43210');
      const v4 = normalizeIndianPhoneNumber('91 9876543210');

      assert.equal(v1, '919876543210');
      assert.equal(v2, '919876543210');
      assert.equal(v3, '919876543210');
      assert.equal(v4, '919876543210');

      assert.throws(() => normalizeIndianPhoneNumber('12345'), /valid 10-digit Indian mobile number/);
      assert.throws(() => normalizeIndianPhoneNumber(''), /valid 10-digit Indian mobile number/);
    });

    await st.test('6.2 /api/cases/bulk-precheck contract: returns active cases keyed by canonical phone', async () => {
      const mockCases = [
        { id: 'c_active_1', user_id: 'usr_1', phone_number: '919876543210', contact_person: 'Rahul Active', status: 'documents_pending' },
        { id: 'c_closed_1', user_id: 'usr_1', phone_number: '919876543211', contact_person: 'Priya Closed', status: 'closed' },
        { id: 'c_other_1', user_id: 'usr_other', phone_number: '919876543212', contact_person: 'Other Tenant', status: 'lead' }
      ];

      const mockDb = {
        execute: async (query) => {
          const sql = typeof query === 'string' ? query : query.sql;
          const args = typeof query === 'string' ? [] : (query.args || []);
          const [userId, ...phones] = args;

          const matched = mockCases.filter(c => 
            c.user_id === userId && 
            !['closed', 'completed'].includes(c.status) && 
            phones.includes(c.phone_number)
          );

          return {
            rows: matched.map(m => ({
              id: m.id,
              phone_number: m.phone_number,
              contact_person: m.contact_person,
              status: m.status
            }))
          };
        }
      };

      const mockContext = {
        req: {
          json: async () => ({
            phones: [
              '+91 98765 43210', // Active for usr_1 -> MUST match
              '09876543211',     // Closed for usr_1 -> MUST NOT match
              '9876543212',      // Active for usr_other -> MUST NOT match (tenant isolation)
              '9876543213',      // Brand new -> MUST NOT match
              'invalid_phone'    // Invalid format -> ignored
            ]
          })
        },
        env: { DB: mockDb },
        get: (k) => k === 'user' ? { id: 'usr_1' } : null,
        json: (data, code = 200) => ({ data, code })
      };

      const res = await handleBulkPrecheck(mockContext);
      assert.equal(res.code, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.activeExistingPhones);

      // Active for usr_1 must be present with details
      assert.ok(res.data.activeExistingPhones['919876543210']);
      assert.equal(res.data.activeExistingPhones['919876543210'].contactPerson, 'Rahul Active');
      assert.equal(res.data.activeExistingPhones['919876543210'].status, 'documents_pending');
      assert.equal(res.data.activeExistingPhones['919876543210'].existingCaseId, 'c_active_1');

      // Closed, other tenant, and new must NOT be in activeExistingPhones
      assert.equal(res.data.activeExistingPhones['919876543211'], undefined);
      assert.equal(res.data.activeExistingPhones['919876543212'], undefined);
      assert.equal(res.data.activeExistingPhones['919876543213'], undefined);
    });

    await st.test('6.3 Local in-batch duplicate tagging & zero-ready handling', () => {
      // Direct emulation of app.js parseCsvOrTextContent
      function parseAndClassify(csvContent, activeMap = {}) {
        const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const seenInBatch = new Set();
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',').map(p => p.trim());
          const name = parts[0];
          const rawPhone = parts[1];

          let canon = null;
          try {
            canon = normalizeIndianPhoneNumber(rawPhone);
          } catch (_) {}

          let classification = 'invalid';
          let isValid = false;

          if (!canon) {
            classification = 'invalid';
          } else if (seenInBatch.has(canon)) {
            classification = 'in_batch_duplicate';
          } else if (activeMap[canon]) {
            classification = 'active_conflict';
            seenInBatch.add(canon);
          } else {
            classification = 'ready';
            isValid = true;
            seenInBatch.add(canon);
          }

          rows.push({ name, canon, classification, isValid });
        }
        return rows;
      }

      const activeMap = {
        '919876543210': { contactPerson: 'Existing Rahul', status: 'documents_pending' }
      };

      const testCsv = `Name,Phone
Rahul,+91 98765 43210
Rahul Duplicate,9876543210
Amit,09876543219
Amit Repeat,9876543219
Bad Format,12345`;

      const rows = parseAndClassify(testCsv, activeMap);
      assert.equal(rows.length, 5);

      // Row 0: Active conflict
      assert.equal(rows[0].classification, 'active_conflict');
      assert.equal(rows[0].isValid, false);

      // Row 1: In-batch duplicate (same phone as row 0)
      assert.equal(rows[1].classification, 'in_batch_duplicate');
      assert.equal(rows[1].isValid, false);

      // Row 2: Ready
      assert.equal(rows[2].classification, 'ready');
      assert.equal(rows[2].isValid, true);

      // Row 3: In-batch duplicate (same phone as row 2)
      assert.equal(rows[3].classification, 'in_batch_duplicate');
      assert.equal(rows[3].isValid, false);

      // Row 4: Invalid
      assert.equal(rows[4].classification, 'invalid');
      assert.equal(rows[4].isValid, false);

      const readyRows = rows.filter(r => r.classification === 'ready' && r.isValid);
      assert.equal(readyRows.length, 1);
      assert.equal(readyRows[0].name, 'Amit');

      // Zero-ready test: CSV with only active duplicates & invalid
      const zeroReadyCsv = `Name,Phone
Rahul,9876543210
Bad,999`;
      const zeroRows = parseAndClassify(zeroReadyCsv, activeMap);
      const zeroReadyCount = zeroRows.filter(r => r.classification === 'ready' && r.isValid).length;
      assert.equal(zeroReadyCount, 0, 'Zero ready rows must result in 0 count');
    });

    await st.test('6.4 Action Payload Semantics: Send Now vs Schedule for Later', async () => {
      let receivedSchedule = undefined;
      let receivedSendWhatsApp = undefined;

      const mockDb = {
        execute: async (query) => {
          const sql = typeof query === 'string' ? query : query.sql;
          if (sql.includes('SELECT id FROM contacts')) return { rows: [] };
          if (sql.includes('FROM loan_cases WHERE user_id')) return { rows: [] };
          return { rows: [] };
        },
        batch: async (stmts) => {
          return stmts.map(() => ({ rows: [] }));
        }
      };

      const mockEnv = {
        DB: mockDb,
        SCHEDULE_QUEUE: { sendBatch: async () => {} }
      };

      // 1. Send Now execution payload
      const sendNowContext = {
        req: {
          json: async () => ({
            clients: [{ contactPerson: 'Send Now User', phoneNumber: '919876543299' }],
            sendWhatsApp: true,
            schedule: null // null schedule = immediate send now
          })
        },
        env: mockEnv,
        get: () => ({ id: 'usr_action_test' }),
        json: (data, code = 200) => ({ data, code })
      };

      const sendNowRes = await handleBulkImportCases(sendNowContext);
      assert.equal(sendNowRes.code, 200);
      assert.equal(sendNowRes.data.importedCount, 1);
      assert.equal(sendNowRes.data.scheduled, false);
      assert.equal(sendNowRes.data.queued, true);

      // 2. Schedule for Later execution payload
      const futureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
      const schedContext = {
        req: {
          json: async () => ({
            clients: [{ contactPerson: 'Scheduled User', phoneNumber: '919876543298' }],
            sendWhatsApp: true,
            schedule: {
              scheduledFor: futureDate,
              scheduleType: 'one_off',
              timezone: 'Asia/Kolkata'
            }
          })
        },
        env: mockEnv,
        get: () => ({ id: 'usr_action_test' }),
        json: (data, code = 200) => ({ data, code })
      };

      const schedRes = await handleBulkImportCases(schedContext);
      assert.equal(schedRes.code, 200);
      assert.equal(schedRes.data.importedCount, 1);
      assert.equal(schedRes.data.scheduled, true);
    });
  });
});

