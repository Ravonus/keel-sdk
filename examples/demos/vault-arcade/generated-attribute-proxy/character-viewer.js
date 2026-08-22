const target = new URL("./vault-keel-viewer-bundled.html", location.href);
target.search = location.search;
target.hash = location.hash;
document.querySelector("#canonical-viewer").href = target.href;
location.replace(target.href);
