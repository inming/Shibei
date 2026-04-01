const API_BASE = "http://127.0.0.1:21519";

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "save-page") {
    handleSavePage(message.data)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "save-region") {
    handleSaveRegion(message.data)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleSavePage(data) {
  // Base64 encode the HTML content
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data.content);
  const base64 = arrayBufferToBase64(bytes.buffer);

  const payload = {
    title: data.title,
    url: data.url,
    domain: data.domain,
    author: data.author || null,
    description: data.description || null,
    content: base64,
    content_type: "html",
    folder_id: data.folderId,
    tags: data.tags || [],
    captured_at: new Date().toISOString(),
  };

  const response = await fetch(`${API_BASE}/api/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function handleSaveRegion(data) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data.content);
  const base64 = arrayBufferToBase64(bytes.buffer);

  const payload = {
    title: data.title,
    url: data.url,
    domain: data.domain,
    author: data.author || null,
    description: data.description || null,
    content: base64,
    content_type: "html",
    folder_id: data.folderId,
    tags: data.tags || [],
    captured_at: new Date().toISOString(),
    selection_meta: data.selection_meta,
  };

  const response = await fetch(`${API_BASE}/api/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return response.json();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
