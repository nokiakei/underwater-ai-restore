/* coi-serviceworker: 為靜態託管（GitHub Pages）補上 COOP/COEP header，
   令頁面達到 crossOriginIsolated，可以用 SharedArrayBuffer（libraw-wasm 需要）。
   參考做法：https://github.com/gzuidhof/coi-serviceworker */
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (e) {
  // 只處理 GET；其他（POST 等）直接放行
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(function (resp) {
        var h = new Headers(resp.headers);
        h.set("Cross-Origin-Opener-Policy", "same-origin");
        h.set("Cross-Origin-Embedder-Policy", "require-corp");
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: h
        });
      })
      .catch(function () {
        return fetch(e.request);
      })
  );
});
