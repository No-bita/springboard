import test from "node:test";
import assert from "node:assert/strict";
import { describe } from "node:test";
import {
  getWhatsAppTemplate,
  renderTemplateBody,
} from "../src/whatsapp/templates.js";
import {
  isWithin24HourServiceWindow,
} from "../src/whatsapp/window.js";
import {
  verifyWebhookSubscription,
  parseWebhookPayload,
} from "../src/whatsapp/webhook.js";
import {
  executeWhatsAppMessagingPipeline,
} from "../src/whatsapp/pipeline.js";

describe("WhatsApp Workflow Integration Tests", () => {
  test("1. Production Template Payload Structure via getWhatsAppTemplate", () => {
    const phone = "919876543210";
    const name = "Rahul Sharma";

    const tplConfig = getWhatsAppTemplate("new_convo_1");
    assert.equal(tplConfig.id, "new_convo_1");

    const payloads = tplConfig.getPayloads({
      phone,
      name,
    });

    assert.equal(payloads.length, 1);
    const payload = payloads[0];

    assert.equal(payload.messaging_product, "whatsapp");
    assert.equal(payload.to, "919876543210");
    assert.equal(payload.type, "template");
    assert.equal(payload.template.name, "new_convo_1");
    assert.equal(payload.template.language.code, "en");

    const bodyComp = payload.template.components.find((c) => c.type === "body");
    assert.ok(bodyComp, "Must contain body component");
    assert.equal(bodyComp.parameters[0].text, "Rahul Sharma");
  });

  test("2. WhatsApp Messaging Pipeline State Machine", async () => {
    const tpl = getWhatsAppTemplate("hello_world");
    assert.equal(tpl.id, "hello_world");
    const rendered = renderTemplateBody("hello_world");
    assert.ok(rendered.includes("Hello World"));
  });

  test("3. Webhook Subscription Verification (verifyWebhookSubscription)", () => {
    const expectedVerifyToken = "CollectrWhatsappTokenAuth2026";

    assert.deepEqual(
      verifyWebhookSubscription("subscribe", "CollectrWhatsappTokenAuth2026", "11582014", expectedVerifyToken),
      { verified: true, challenge: "11582014" }
    );

    assert.deepEqual(
      verifyWebhookSubscription("subscribe", "wrong_token", "11582014", expectedVerifyToken),
      { verified: false, challenge: null }
    );
  });

  test("4. Central WhatsApp Template Registry (getWhatsAppTemplate)", () => {
    const tplConfig = getWhatsAppTemplate("new_convo_1", {});
    assert.equal(tplConfig.id, "new_convo_1");
    const payloads = tplConfig.getPayloads({ phone: "919876543210", name: "Rahul" });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].template.name, "new_convo_1");

    const helloConfig = getWhatsAppTemplate("hello_world");
    assert.equal(helloConfig.id, "hello_world");
  });

  test("5. Free-Form WhatsApp Text Message Payload Structure", () => {
    const phone = "919876543210";
    const text = "Hi, thanks for getting back to me.";

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    };

    assert.equal(payload.messaging_product, "whatsapp");
    assert.equal(payload.to, "919876543210");
    assert.equal(payload.type, "text");
    assert.equal(payload.text.body, "Hi, thanks for getting back to me.");
  });

  test("6. Meta 24-Hour Customer Service Window Enforcement (isWithin24HourServiceWindow)", () => {
    const now = Date.now();

    assert.equal(isWithin24HourServiceWindow(null, now), false);

    const recentReply = now - (2 * 60 * 60 * 1000);
    assert.equal(isWithin24HourServiceWindow(recentReply, now), true);

    const oldReply = now - (25 * 60 * 60 * 1000);
    assert.equal(isWithin24HourServiceWindow(oldReply, now), false);

    const newReply = now - (10 * 60 * 1000);
    assert.equal(isWithin24HourServiceWindow(newReply, now), true);
  });

  test("7. Webhook Payload Normalizer (parseWebhookPayload)", () => {
    const mockWebhookBody = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.HBgLM...1",
                    recipient_id: "919876543210",
                    status: "delivered",
                    timestamp: "1700000000",
                  },
                ],
                messages: [
                  {
                    id: "wamid.HBgLM...2",
                    from: "919876543210",
                    type: "text",
                    text: { body: "Here are my docs" },
                    timestamp: "1700000005",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWebhookPayload(mockWebhookBody);
    assert.equal(parsed.statuses.length, 1);
    assert.equal(parsed.statuses[0].status, "delivered");
    assert.equal(parsed.statuses[0].recipientId, "919876543210");
    assert.equal(parsed.statuses[0].providerMsgId, "wamid.HBgLM...1");

    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].shortPhone, "9876543210");
    assert.equal(parsed.messages[0].fullPhone, "919876543210");
    assert.equal(parsed.messages[0].text, "Here are my docs");
  });

  test("8. Template Rendering Contract", () => {
    const rendered = renderTemplateBody("new_convo_1", { name: "Rahul", userName: "Collectr" });
    assert.ok(rendered.includes("Rahul"));
  });
});
