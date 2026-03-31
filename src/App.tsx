import { useState } from "react";

function App() {
  const [resourceId, setResourceId] = useState("");
  const [loadedUrl, setLoadedUrl] = useState("");

  function loadResource() {
    if (resourceId.trim()) {
      // macOS/Linux format: shibei://localhost/resource/{id}
      setLoadedUrl(`shibei://localhost/resource/${resourceId.trim()}`);
    }
  }

  return (
    <main style={{ padding: "16px", height: "100vh", display: "flex", flexDirection: "column" }}>
      <h1>拾贝 — MHTML Spike</h1>
      <div style={{ marginBottom: "12px" }}>
        <input
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
          placeholder="Enter resource ID..."
          style={{ marginRight: "8px", padding: "4px 8px" }}
        />
        <button onClick={loadResource}>Load</button>
        {loadedUrl && <span style={{ marginLeft: "12px", fontSize: "12px", color: "#666" }}>{loadedUrl}</span>}
      </div>
      {loadedUrl && (
        <iframe
          src={loadedUrl}
          style={{ flex: 1, border: "1px solid #ccc", borderRadius: "4px" }}
          title="MHTML Viewer"
        />
      )}
    </main>
  );
}

export default App;
