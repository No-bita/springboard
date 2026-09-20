import { el, escapeHtml } from "../core/dom.js";
import { authFetch } from "../core/api.js";

/**
 * Admin Module: Document Matrix Configurator & Observability Failure Logs.
 */
let loanProductMappings = {};

export async function fetchDocumentMappings() {
  try {
    const res = await authFetch("/api/admin/loan-product-mappings");
    if (res.ok) {
      const data = await res.json();
      loanProductMappings = data.mappings || {};
    }
  } catch (err) {
    console.warn("Could not fetch mappings from admin API, falling back to defaults", err);
  }
}

export function renderMappingConfiguratorMatrix(documentCatalog = [], loanProductsList = []) {
  const tbody = el("matrixTableBody");
  const thead = el("matrixTableHead");
  if (!tbody || !thead) return;

  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headerRow = document.createElement("tr");
  const thProd = document.createElement("th");
  thProd.textContent = "Product / Service Type";
  thProd.style.minWidth = "180px";
  headerRow.appendChild(thProd);

  documentCatalog.forEach((doc) => {
    const th = document.createElement("th");
    th.textContent = doc.label;
    th.style.textAlign = "center";
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  const products = loanProductsList && loanProductsList.length > 0
    ? loanProductsList.map((p) => p.label)
    : ["Standard Intake Pack", "Business Intake", "Follow-up Pack"];

  products.forEach((pLabel) => {
    const tr = document.createElement("tr");
    const tdProd = document.createElement("td");
    tdProd.innerHTML = `<strong>${escapeHtml(pLabel)}</strong>`;
    tr.appendChild(tdProd);

    const activeDocIds = new Set(loanProductMappings[pLabel] || []);

    documentCatalog.forEach((doc) => {
      const tdCheck = document.createElement("td");
      tdCheck.className = "matrix-cell-check";
      const checked = activeDocIds.has(doc.id);
      tdCheck.innerHTML = `<input type="checkbox" data-matrix-product="${escapeHtml(
        pLabel
      )}" data-matrix-doc="${doc.id}" ${checked ? "checked" : ""} />`;
      tr.appendChild(tdCheck);
    });

    tbody.appendChild(tr);
  });
}

export async function saveDocumentMappings() {
  const submitBtn = el("btnSaveDocMappings");
  const errBox = el("mappingConfigError");
  if (errBox) errBox.hidden = true;

  const newMappings = {};
  document.querySelectorAll("input[data-matrix-product]").forEach((cb) => {
    const pLabel = cb.getAttribute("data-matrix-product");
    const docId = cb.getAttribute("data-matrix-doc");
    if (!newMappings[pLabel]) newMappings[pLabel] = [];
    if (cb.checked) {
      newMappings[pLabel].push(docId);
    }
  });

  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await authFetch("/api/admin/loan-product-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings: newMappings }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to save mapping rules.");

    loanProductMappings = newMappings;
    if (typeof UI !== "undefined" && UI.toast) {
      UI.toast("Document collection rules updated!", "success");
    }
    if (el("docMappingModalBackdrop")) el("docMappingModalBackdrop").hidden = true;
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
