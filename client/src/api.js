import { hexclaveClientApp } from "./hexclave/client.js";

const USER_KEY = "finance-user-id";

let currentUserId = Number(localStorage.getItem(USER_KEY)) || null;

export function getStoredUserId() {
  return currentUserId;
}

export function setStoredUserId(id) {
  currentUserId = id ? Number(id) : null;
  if (currentUserId) localStorage.setItem(USER_KEY, String(currentUserId));
  else localStorage.removeItem(USER_KEY);
}

async function request(url, options = {}) {
  const authorizationHeader = await hexclaveClientApp.getAuthorizationHeader();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    let message = "The ledger could not be updated.";
    try {
      const body = await response.json();
      if (body.error) message = body.error;
    } catch {
      message = "The ledger could not be reached.";
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

export function getSession() {
  return request("/api/session");
}

export function listUsers() {
  return request("/api/users");
}

export function getCategoryDefaults() {
  return request("/api/category-defaults");
}

export function createUser(name, net, categories) {
  return request("/api/users", {
    method: "POST",
    body: JSON.stringify({ name, net, categories }),
  });
}

export function deleteCurrentUser() {
  return request("/api/users/me", { method: "DELETE" });
}

export function getBootstrap(month) {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  return request(`/api/bootstrap${query}`);
}

export function suggest(description) {
  return request(`/api/suggest?description=${encodeURIComponent(description)}`);
}

export function saveIncome(month, amount) {
  return request("/api/income", {
    method: "PUT",
    body: JSON.stringify({ month, amount }),
  });
}

export function saveSiteMoney(month, site) {
  return request("/api/income", {
    method: "PUT",
    body: JSON.stringify({ month, site }),
  });
}

export function createTransaction(payload) {
  return request("/api/transactions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function searchTransactions({
  q = "",
  category = "",
  month = "",
  day = "",
} = {}) {
  const query = String(q || "").trim();
  const slug = String(category || "").trim();
  const monthKey = String(month || "").trim();
  const dayFilter = String(day || "").trim();
  if (!query && !slug && !monthKey && !dayFilter) {
    return Promise.resolve({ transactions: [] });
  }
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (slug) params.set("category", slug);
  if (monthKey) params.set("month", monthKey);
  if (dayFilter) params.set("day", dayFilter);
  return request(`/api/transactions/search?${params.toString()}`);
}

export function updateTransaction(id, payload) {
  return request(`/api/transactions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteTransaction(id) {
  return request(`/api/transactions/${id}`, { method: "DELETE" });
}

export function createCategory(name, month) {
  return request("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name, month }),
  });
}

export function renameCategory(slug, name, month) {
  return request(`/api/categories/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, month }),
  });
}

export function deleteCategory(slug, month) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  const query = params.toString();
  return request(
    `/api/categories/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`,
    { method: "DELETE" },
  );
}

export function openNextMonth(force = false) {
  return request("/api/months", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export function listFixedTemplates() {
  return request("/api/fixed-templates");
}

export function createFixedTemplate(payload) {
  return request("/api/fixed-templates", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateFixedTemplate(id, payload) {
  return request(`/api/fixed-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteFixedTemplate(id) {
  return request(`/api/fixed-templates/${id}`, { method: "DELETE" });
}

export function scanInvoice(url) {
  return request("/api/invoice-scan", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}
