import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getWhatsAppTemplate, buildCustomTemplatePayload, WHATSAPP_TEMPLATES } from '../src/whatsapp/templates.js';

const rootDir = fs.existsSync(path.join(process.cwd(), 'public'))
  ? process.cwd()
  : path.join(process.cwd(), 'v2');

test('Message Templates & Registry Engine Tests', async (t) => {
  await t.test('1. Dynamic Multi-Component Template Payload Generation for Custom Templates', () => {
    const customTpl = {
      id: "tpl_test_custom",
      name: "tax_reminder_2026",
      category: "UTILITY",
      language: "hi",
      header_type: "TEXT",
      header_text: "ITR Verification",
      body_text: "Namaste {{1}}, please send docs for {{3}} via {{2}}",
      footer_text: "Collectrr Tax Dept",
      button_type: "url",
      button_text: "Upload Documents",
      param_mappings: {
        header: ["contact_person"],
        body: ["contact_person", "upload_link", "loan_product"],
        button: ["raw_token"]
      }
    };

    const payloads = buildCustomTemplatePayload(customTpl, {
      phone: "919876543210",
      contactPerson: "Aryan",
      rawToken: "token_abc_123",
      uploadLink: "https://collectrr-v2.collectr.workers.dev/upload.html?t=token_abc_123",
      loanProduct: "ITR Filing"
    });

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].to, "919876543210");
    assert.equal(payloads[0].template.name, "tax_reminder_2026");
    assert.equal(payloads[0].template.language.code, "hi");

    // Header component
    assert.equal(payloads[0].template.components[0].type, "header");
    assert.equal(payloads[0].template.components[0].parameters[0].text, "Aryan");

    // Body component
    assert.equal(payloads[0].template.components[1].type, "body");
    assert.equal(payloads[0].template.components[1].parameters[0].text, "Aryan");
    assert.equal(payloads[0].template.components[1].parameters[1].text, "https://collectrr-v2.collectr.workers.dev/upload.html?t=token_abc_123");
    assert.equal(payloads[0].template.components[1].parameters[2].text, "ITR Filing");

    // Button component
    assert.equal(payloads[0].template.components[2].type, "button");
    assert.equal(payloads[0].template.components[2].parameters[0].text, "token_abc_123");
  });

  await t.test('2. Dynamic Registry Lookup via getWhatsAppTemplate', () => {
    const customList = [
      {
        id: "tpl_doc_req",
        name: "custom_doc_request",
        language: "hi",
        category: "UTILITY",
        body_text: "Namaste {{1}}, kripya documents upload karein {{2}}",
        button_type: "url"
      }
    ];

    const resolved = getWhatsAppTemplate("custom_doc_request", {}, customList);
    assert.equal(resolved.name, "custom_doc_request");
    assert.equal(resolved.defaultLang, "hi");
    assert.equal(typeof resolved.getPayloads, "function");

    // Test system fallback for built-in templates
    const fallback = getWhatsAppTemplate("new_convo_1", {});
    assert.equal(fallback.name, "new_convo_1");
  });

  await t.test('3. Template Uniqueness and Protection from duplicate names', async () => {
    const { handleCreateTemplate } = await import('../src/api/templates.js');

    const createMockContext = ({ body = {}, query = {}, dbRows = [], user = { id: "admin" } } = {}) => {
      const executed = [];
      const mockDb = {
        prepare: (sql) => {
          let boundArgs = [];
          return {
            bind: (...args) => {
              boundArgs = args;
              return {
                all: async () => {
                  executed.push({ sql, args: boundArgs });
                  return { results: dbRows };
                },
                run: async () => {
                  executed.push({ sql, args: boundArgs });
                  return { success: true };
                }
              };
            },
            all: async () => {
              executed.push({ sql, args: boundArgs });
              return { results: dbRows };
            },
            run: async () => {
              executed.push({ sql, args: boundArgs });
              return { success: true };
            }
          };
        }
      };

      return {
        c: {
          env: { DB: mockDb },
          get: (k) => (k === "user" ? user : null),
          req: {
            query: (k) => query[k] || "",
            json: async () => body,
          },
          json: (data, status = 200) => ({ status, data })
        },
        executed
      };
    };

    // A. Verify handleCreateTemplate rejects colliding with built-in system template (e.g. new_convo_1)
    const { c: cSystemDup } = createMockContext({
      body: {
        name: "new_convo_1",
        body_text: "Duplicate new_convo_1 template body",
        language: "en"
      }
    });
    const resSystemDup = await handleCreateTemplate(cSystemDup);
    assert.equal(resSystemDup.status, 409);
    assert.ok(resSystemDup.data.error.includes("already exists as a protected system template"));

    // B. Verify handleCreateTemplate rejects colliding with an existing custom template
    const { c: cCustomDup } = createMockContext({
      body: {
        name: "my_custom_reminder",
        body_text: "Reminder text",
        language: "en"
      },
      dbRows: [{ id: "tpl_existing_123", name: "my_custom_reminder" }]
    });
    const resCustomDup = await handleCreateTemplate(cCustomDup);
    assert.equal(resCustomDup.status, 409);
    assert.ok(resCustomDup.data.error.includes("Template names must be unique"));
  });
});
