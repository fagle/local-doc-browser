export function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json;charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function sendHtml(response, status, html) {
  response.writeHead(status, { "content-type": "text/html;charset=utf-8" });
  response.end(html);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
