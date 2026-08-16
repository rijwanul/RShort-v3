export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== "/api/me") {
    // Session expired or was invalidated mid-use (e.g. token_version
    // bumped elsewhere). Send the user to login instead of showing a
    // confusing inline "not authenticated" error in the SPA.
    window.location.href = "/login";
    return new Promise(() => {}); // never resolves; navigation is already underway
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function get(path) {
  return api(path, { method: "GET" });
}
export function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body || {}) });
}
export function put(path, body) {
  return api(path, { method: "PUT", body: JSON.stringify(body || {}) });
}
export function del(path, body) {
  return api(path, { method: "DELETE", body: body !== undefined ? JSON.stringify(body) : undefined });
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso.replace(" ", "T") + "Z").toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
