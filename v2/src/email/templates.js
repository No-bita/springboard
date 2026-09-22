/**
 * Email Template Renderer
 * Collectrr v2 - Email Outreach Module
 * Renders channel-specific HTML and plain-text email presentation while reusing
 * underlying business content and template parameter semantics.
 */

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderEmailContent({
  templateName,
  templateParams = [],
  contactPerson = "Client",
  userName = "Springboard",
  userPhone = "",
  rawToken = "verify",
  uploadLink = "",
  customTemplates = []
} = {}) {
  const name = String(templateName || "").trim().toLowerCase();
  const firmName = userName || "Collectrr";
  const clientName = templateParams?.[0] || contactPerson || "Client";

  let subject = `Action Required: Upload Documents - ${firmName}`;
  let rawBodyText = "";

  if (name === "loan_agent_first_outreach" || name.includes("loan_agent")) {
    const borrowerName = templateParams?.[0] || contactPerson || "Borrower";
    const agentName = templateParams?.[1] || userName || "Loan Team";
    const contactDetail = templateParams?.[2] || userPhone || agentName;
    subject = `Loan Application Documents Required - ${agentName}`;
    rawBodyText = `Dear ${borrowerName},\n\nYour application has been initiated by ${agentName}.\n\nPlease upload the requested documents using the secure link below or reach out at ${contactDetail}.\n\nIf you have any questions, please contact us directly.`;
  } else if (name === "do_ca") {
    subject = `Quick Introduction - ${firmName}`;
    rawBodyText = `Hi ${clientName},\n\nI came across your firm and wanted to share how you can easily manage client document collection and verification online.\n\nPlease take a look at the sample portal below.\n\nBest regards,\n${firmName}`;
  } else if (Array.isArray(customTemplates) && customTemplates.length > 0) {
    const custom = customTemplates.find(
      (t) => (t.name || "").toLowerCase() === name || (t.id || "").toLowerCase() === name
    );
    if (custom) {
      if (custom.subject) {
        subject = custom.subject
          .replace(/\{\{1\}\}/g, clientName)
          .replace(/\{\{name\}\}/gi, clientName)
          .replace(/\{\{client_name\}\}/gi, clientName)
          .replace(/\{\{caname\}\}/gi, firmName);
      }
      if (custom.body_text) {
        let rendered = custom.body_text;
        if (Array.isArray(templateParams) && templateParams.length > 0) {
          templateParams.forEach((val, idx) => {
            rendered = rendered.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), String(val));
          });
        }
        rawBodyText = rendered
          .replace(/\{\{1\}\}/g, clientName)
          .replace(/\{\{name\}\}/gi, clientName)
          .replace(/\{\{client_name\}\}/gi, clientName)
          .replace(/\{\{caname\}\}/gi, firmName);
      }
    }
  }

  if (!rawBodyText) {
    // Default: ITR / Document Onboarding
    rawBodyText = `Hi ${clientName},\n\nThank you for working with ${firmName}.\n\nTo proceed with your verification and filing, please upload your required documents securely using the link below.\n\nIf you need any assistance, feel free to reply to this email.`;
  }

  const effectiveUploadLink = uploadLink || `https://collectrr-v2.collectr.workers.dev/upload.html?t=${rawToken}`;

  // Plain-text representation
  const plainText = `${rawBodyText}\n\nUpload your documents securely here:\n${effectiveUploadLink}\n\nBest regards,\n${firmName}`;

  // HTML presentation layer
  const htmlParagraphs = rawBodyText
    .split("\n\n")
    .map((p) => `<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #1e293b;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <!-- Header -->
          <tr>
            <td style="padding: 24px 32px 16px; border-bottom: 1px solid #f1f5f9; background-color: #ffffff;">
              <h2 style="margin: 0; font-size: 18px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">${escapeHtml(firmName)}</h2>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 32px 24px;">
              ${htmlParagraphs}
              <!-- Primary CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0 24px;">
                <tr>
                  <td align="center" style="border-radius: 8px; background-color: #0f172a;">
                    <a href="${escapeHtml(effectiveUploadLink)}" target="_blank" style="display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #0f172a;">
                      Upload Documents &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Direct Link Fallback -->
              <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.5; border-top: 1px solid #f1f5f9; padding-top: 16px;">
                If the button above does not work, open this secure link in your browser:<br/>
                <a href="${escapeHtml(effectiveUploadLink)}" target="_blank" style="color: #2563eb; text-decoration: underline; word-break: break-all;">${escapeHtml(effectiveUploadLink)}</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
              This is a secure document request sent by ${escapeHtml(firmName)} via Springboard.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject,
    html,
    text: plainText,
    renderedBody: plainText
  };
}
