import type { EntrypointMode } from "@keel/protocol";
import type { WrapperInput } from "./types.js";

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function presentation(mode: EntrypointMode, resourceId: string, mediaType: string, name: string): string {
  const source = `oca://${escapeAttribute(resourceId)}`;
  switch (mode) {
    case "image":
    case "svg":
      return `<img src="${source}" alt="${escapeAttribute(name)}">`;
    case "video":
      return `<video src="${source}" controls playsinline></video>`;
    case "audio":
      return `<section class="audio"><div class="disc" aria-hidden="true"></div><audio src="${source}" controls></audio></section>`;
    case "model":
      return `<section class="unsupported"><h2>3D model artifact</h2><p>This artifact includes a verified <code>${escapeHtml(mediaType)}</code> resource. Add an HTML entrypoint with your preferred WebGL renderer to make it interactive.</p><a href="${source}" download>Download verified model</a></section>`;
    case "module":
      return `<section class="unsupported"><h2>Module artifact</h2><p>A module needs an HTML mount point. Add an <code>index.html</code> file or use this generated wrapper as a starting point.</p></section><script type="module" src="${source}"></script>`;
    case "html":
      return `<iframe src="${source}" title="${escapeAttribute(name)}"></iframe>`;
  }
}

export function createGeneratedWrapper(input: {
  readonly name: string;
  readonly description?: string;
  readonly resourceId: string;
  readonly mediaType: string;
  readonly mode: EntrypointMode;
  readonly downloads: boolean;
}): string {
  const main = presentation(input.mode, input.resourceId, input.mediaType, input.name);
  const download = input.downloads
    ? `<a class="download" href="oca://${escapeAttribute(input.resourceId)}" download>Download verified original</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(input.name)}</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#08090c;color:#f7f7f8}
    *{box-sizing:border-box}html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden}
    main{display:grid;place-items:center;position:relative;background:radial-gradient(circle at 50% 25%,#ffb6c11f,transparent 45%),#08090c}
    img,video,iframe{display:block;width:100%;height:100%;object-fit:contain;border:0}.audio{display:grid;gap:28px;place-items:center}.disc{width:min(58vw,340px);aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#1b1d24 0 4px,#111218 5px 9px);box-shadow:0 30px 100px #000}.unsupported{max-width:620px;padding:32px;border:1px solid #ffffff1f;border-radius:20px;background:#11131acc;line-height:1.55}.unsupported a,.download{color:#ffb6c1}.download{position:absolute;right:16px;bottom:16px;padding:10px 14px;border:1px solid #ffffff24;border-radius:999px;background:#11131add;text-decoration:none;backdrop-filter:blur(14px)}
  </style>
</head>
<body>
  <main aria-label="${escapeAttribute(input.name)}" data-description="${escapeAttribute(input.description ?? "")}">
    ${main}
    ${download}
  </main>
</body>
</html>`;
}

function safeCssColor(value: string | undefined): string {
  if (value === undefined) return "#090b12";
  return /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9.,% ]+\)|hsla?\([0-9.,% deg]+\))$/u.test(value)
    ? value
    : "#090b12";
}

export function createArtifactWrapper(input: WrapperInput): string {
  const title = escapeHtml(input.title);
  const resourcePath = escapeAttribute(input.resourcePath);
  const originalPath = input.originalPath === undefined ? undefined : escapeAttribute(input.originalPath);
  const background = safeCssColor(input.backgroundColor);
  const objectFit = input.objectFit ?? "contain";
  const mediaType = input.mediaType.toLowerCase().split(";", 1)[0] ?? input.mediaType.toLowerCase();
  let content: string;
  if (mediaType.startsWith("image/")) content = `<img class="asset" src="${resourcePath}" alt="${title}">`;
  else if (mediaType.startsWith("video/")) content = `<video class="asset" src="${resourcePath}" controls playsinline preload="metadata"></video>`;
  else if (mediaType.startsWith("audio/")) content = `<div class="audio-shell"><audio src="${resourcePath}" controls preload="metadata"></audio></div>`;
  else if (mediaType === "text/html" || mediaType === "image/svg+xml") content = `<iframe class="document" src="${resourcePath}" title="${title}"></iframe>`;
  else content = `<div class="unsupported"><strong>${title}</strong><p>${escapeHtml(input.mediaType)}</p><a href="${resourcePath}" download>Download verified resource</a></div>`;
  const download = originalPath === undefined ? "" : `<a class="download" href="${originalPath}" download>Download original</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark;background:${background}}*{box-sizing:border-box}html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden;background:${background};color:#fff;font-family:ui-sans-serif,system-ui}main{position:relative;display:grid;place-items:center}.asset{width:100%;height:100%;object-fit:${objectFit}}.document{width:100%;height:100%;border:0}.download{position:fixed;right:1rem;bottom:1rem;padding:.65rem .9rem;border:1px solid #ffffff40;border-radius:999px;background:#090b12cc;color:#fff;text-decoration:none}.audio-shell,.unsupported{padding:2rem;text-align:center}audio{width:min(90vw,40rem)}</style></head><body><main>${content}${download}</main></body></html>`;
}
