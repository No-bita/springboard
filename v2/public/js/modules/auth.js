import { el } from "../core/dom.js";
import { authFetch } from "../core/api.js";
import { state, setCurrentUser } from "../core/state.js";

/**
 * Authentication & User Session Module.
 */
export async function initAuth() {
  const isDev =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");

  let token = localStorage.getItem("collectrr_auth");
  if (!token && isDev) {
    token = "Bearer dev_token";
    localStorage.setItem("collectrr_auth", token);
  }

  if (!token) {
    if (typeof window !== "undefined") {
      window.location.href = `/login.html?redirect=${encodeURIComponent(
        window.location.pathname + window.location.search
      )}`;
    }
    return null;
  }

  try {
    const res = await authFetch("/api/user/profile");
    if (res.ok) {
      const data = await res.json();
      const user = data.user || data;
      setCurrentUser(user);
      renderUserProfile(user);
      return user;
    }
  } catch (err) {
    console.warn("Could not fetch user profile:", err);
  }

  // Fallback profile if offline/dev
  const fallbackUser = { id: "admin", username: "DevAgent", role: "admin" };
  setCurrentUser(fallbackUser);
  renderUserProfile(fallbackUser);
  return fallbackUser;
}

export function renderUserProfile(user) {
  const userData = user?.user || user || {};
  const userNameEl = el("userNameDisplay") || el("userName");
  const userRoleBadge = el("userRoleBadge") || el("userRole");
  const userAvatarEl = el("userAvatar");
  const topUserContainer = el("topUserContainer");
  const btnTemplate = el("btnOpenTemplateModal");
  const btnDocMapping = el("btnOpenDocMappingModal");

  const username = userData.username || userData.name || "User";
  const role = userData.role || "admin";

  if (userNameEl) {
    userNameEl.textContent = username;
  }

  if (userAvatarEl) {
    const initials = username
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    userAvatarEl.textContent = initials || username.slice(0, 2).toUpperCase();
  }

  const isAdmin = role === "admin" || userData.id === "admin";
  if (userRoleBadge) {
    userRoleBadge.textContent = isAdmin ? (userRoleBadge.id === "userRole" ? "Admin" : "Administrator") : (role.charAt(0).toUpperCase() + role.slice(1));
    if (userRoleBadge.classList && userRoleBadge.classList.contains("badge")) {
      userRoleBadge.className = isAdmin ? "badge-admin" : "badge-agent";
    }
  }

  if (btnTemplate) {
    btnTemplate.style.display = isAdmin ? "" : "none";
  }
  if (btnDocMapping) {
    btnDocMapping.style.display = isAdmin ? "" : "none";
  }
}

export function logout() {
  localStorage.removeItem("collectrr_auth");
  if (typeof window !== "undefined") {
    window.location.href = "/login.html";
  }
}
