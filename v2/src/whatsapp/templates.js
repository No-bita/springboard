/**
 * Central WhatsApp Template Registry & Payload Generator
 * Collectr Personal CRM - WhatsApp Messaging Module
 */

export const WHATSAPP_TEMPLATES = {
  /**
   * hello_world
   * Meta Default Verification Template
   */
  HELLO_WORLD: {
    id: "hello_world",
    name: "hello_world",
    displayName: "Meta Default (hello_world)",
    defaultLang: "en_US",
    category: "UTILITY",
    description: "Meta official default template for testing and connectivity",
    body_text: "Hello World",
    parameters: [],
    getPayloads: ({ phone, langCode = "en_US" }) => [
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: "hello_world",
          language: {
            code: langCode || "en_US",
          },
        },
      },
    ],
  },

  /**
   * new_convo_1
   * Clean Generic Introductory Outreach Template
   */
  NEW_CONVO_1: {
    id: "new_convo_1",
    name: "new_convo_1",
    displayName: "Introductory Outreach (new_convo_1)",
    defaultLang: "en",
    category: "UTILITY",
    description: "Generic introductory message with recipient and user names",
    body_text: "Hi {{1}},\n\nThank you for connecting with {{2}}.\n\nPlease let us know how we can assist you.\n\nReply here if you have any questions.",
    parameters: [
      { key: "contact_name", label: "Contact Name", defaultField: "name" },
      { key: "user_name", label: "Sender Name", defaultField: "userName" },
    ],
    getPayloads: ({
      phone,
      contactPerson,
      name,
      userName = "Collectr",
      langCode = "en",
      templateParams = [],
    }) => {
      const recipientName = templateParams?.[0] || name || contactPerson || "there";
      const senderName = templateParams?.[1] || userName || "Collectr";

      return [
        {
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: "new_convo_1",
            language: {
              code: langCode || "en",
            },
            components: [
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    text: String(recipientName),
                  },
                  {
                    type: "text",
                    text: String(senderName),
                  },
                ],
              },
            ],
          },
        },
      ];
    },
  },
};

/**
 * Builds payload for a custom user-created WhatsApp template.
 */
export function buildCustomTemplatePayload(
  tpl,
  options = {}
) {
  const {
    phone,
    name,
    contactPerson,
    rawToken,
    uploadLink,
    langCode,
    referenceId,
    templateParams,
  } = options;

  const lang = langCode || tpl.language || tpl.defaultLang || "en";
  const components = [];

  let paramMappings = tpl.param_mappings || tpl.paramMappings || {};
  if (typeof paramMappings === "string") {
    try {
      paramMappings = JSON.parse(paramMappings);
    } catch (_) {
      paramMappings = {};
    }
  }

  const recipientName = name || contactPerson || "there";

  const resolveParamValue = (mappingKey, fallbackVal = "", paramIndex = 0) => {
    if (
      Array.isArray(templateParams) &&
      templateParams.length > paramIndex &&
      templateParams[paramIndex] !== undefined &&
      templateParams[paramIndex] !== ""
    ) {
      return String(templateParams[paramIndex]);
    }

    if (mappingKey && options[mappingKey] !== undefined) {
      return String(options[mappingKey]);
    }
    if (mappingKey === "loan_product" && (options.loanProduct || options.loan_product)) {
      return String(options.loanProduct || options.loan_product);
    }
    if (mappingKey === "contact_person" && (options.contactPerson || options.name)) {
      return String(options.contactPerson || options.name);
    }
    if (mappingKey === "upload_link" && (options.uploadLink || options.link)) {
      return String(options.uploadLink || options.link);
    }
    if (mappingKey === "raw_token" && (options.rawToken || options.token)) {
      return String(options.rawToken || options.token);
    }

    switch (mappingKey) {
      case "contact_name":
      case "name":
      case "contact_person":
        return recipientName;

      case "upload_link":
      case "link":
        return uploadLink || "";

      case "raw_token":
      case "token":
        return rawToken || "";

      case "phone":
        return phone || "";

      case "reference_id":
        return referenceId || "";

      default:
        return fallbackVal || "";
    }
  };

  // Header parameters
  if ((tpl.header_type === "TEXT" || tpl.headerType === "TEXT") && tpl.header_text) {
    const headerParams = Array.isArray(paramMappings.header) ? paramMappings.header : [];
    if (headerParams.length > 0) {
      components.push({
        type: "header",
        parameters: headerParams.map((mappingKey) => ({
          type: "text",
          text: resolveParamValue(mappingKey, recipientName),
        })),
      });
    }
  }

  // Body parameters
  const bodyText = tpl.body_text || tpl.bodyText || "";
  let bodyParamKeys = Array.isArray(paramMappings.body) ? paramMappings.body : [];

  if (bodyParamKeys.length === 0) {
    const matches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
    bodyParamKeys = matches.map((_, idx) => (idx === 0 ? "name" : "link"));
  }

  if (bodyParamKeys.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParamKeys.map((mappingKey, idx) => ({
        type: "text",
        text: resolveParamValue(mappingKey, idx === 0 ? recipientName : uploadLink || "", idx),
      })),
    });
  }

  // Button parameters
  const buttonType = String(tpl.button_type || tpl.buttonType || "none").toLowerCase();
  if (
    buttonType === "dynamic_url" ||
    (buttonType === "url" && Array.isArray(paramMappings.button) && paramMappings.button.length > 0)
  ) {
    const buttonParams = Array.isArray(paramMappings.button) ? paramMappings.button : ["raw_token"];
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [
        {
          type: "text",
          text: resolveParamValue(buttonParams[0], rawToken || ""),
        },
      ],
    });
  } else if (
    buttonType === "quick_reply" &&
    Array.isArray(paramMappings.button) &&
    paramMappings.button.length > 0
  ) {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [
        {
          type: "payload",
          payload: tpl.button_payload || "ACTION_PROCEED",
        },
      ],
    });
  }

  const primaryPayload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: tpl.name,
      language: {
        code: lang,
      },
    },
  };

  if (components.length > 0) {
    primaryPayload.template.components = components;
  }

  return [primaryPayload];
}

/**
 * Resolve WhatsApp Template Config by Name or ID
 */
export function getWhatsAppTemplate(templateIdentifier, env, customTemplates = []) {
  const id = String(templateIdentifier || "new_convo_1").trim();

  if (id === "hello_world") {
    return WHATSAPP_TEMPLATES.HELLO_WORLD;
  }

  if (id === "new_convo_1") {
    return WHATSAPP_TEMPLATES.NEW_CONVO_1;
  }

  // Check custom templates
  if (Array.isArray(customTemplates) && customTemplates.length > 0) {
    const custom = customTemplates.find(
      (t) => t.name === id || t.id === id
    );

    if (custom) {
      return {
        id: custom.id,
        name: custom.name,
        defaultLang: custom.language || "en",
        category: custom.category || "UTILITY",
        description: custom.body_text || custom.name,
        getPayloads: (params) => buildCustomTemplatePayload(custom, params),
      };
    }
  }

  return WHATSAPP_TEMPLATES.NEW_CONVO_1;
}

/**
 * Render the exact WhatsApp message body for a given template and parameters.
 */
export function renderTemplateBody(
  templateIdentifier,
  {
    name = "there",
    contactPerson,
    userName = "Collectr",
    templateParams = [],
    customTemplates = [],
  } = {}
) {
  const id = String(templateIdentifier || "").trim().toLowerCase();
  const recipient = name || contactPerson || "there";

  if (id === "hello_world") {
    return "Hello World";
  }

  if (Array.isArray(customTemplates) && customTemplates.length > 0) {
    const custom = customTemplates.find(
      (t) => (t.name || "").toLowerCase() === id || (t.id || "").toLowerCase() === id
    );
    if (custom && custom.body_text) {
      let rendered = custom.body_text;
      if (Array.isArray(templateParams) && templateParams.length > 0) {
        templateParams.forEach((val, idx) => {
          rendered = rendered.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), String(val));
        });
      }
      rendered = rendered
        .replace(/\{\{1\}\}/g, recipient)
        .replace(/\{\{name\}\}/gi, recipient)
        .replace(/\{\{contact_name\}\}/gi, recipient)
        .replace(/\{\{2\}\}/g, userName)
        .replace(/\{\{user_name\}\}/gi, userName);
      return rendered;
    }
  }

  // Default new_convo_1
  const param1 = templateParams?.[0] || recipient;
  const param2 = templateParams?.[1] || userName;
  return `Hi ${param1},\n\nThank you for connecting with ${param2}.\n\nPlease let us know how we can assist you.\n\nReply here if you have any questions.`;
}
