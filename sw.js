/* 水下 AI 還原 — 離線快取 Service Worker（v11.0）
   設計：第一次在線開站時，install 階段將全部關鍵資產（頁面、AI 模型分塊、
   人物分割分塊、RAW 引擎、ONNX Runtime）逐件存入 Cache Storage；
   之後所有同源請求 cache-first，斷網都開到站、用得晒全部功能。
   改版時必須同步升 CACHE 名稱（同 index.html 頁腳版號一致），舊 cache 會喺 activate 清走。
   字型（Google Fonts）用獨立 runtime cache：純外觀資產，第一次成功載入後離線沿用，
   載入唔到就用系統字型，唔影響任何功能。 */
"use strict";

var CACHE = "uw-v11.0";
var FONT_CACHE = "uw-fonts-v1";

function parts(prefix, n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(prefix + (i < 10 ? "0" + i : "" + i));
  return out;
}

var PRECACHE = [
  "./",
  "./index.html",
  "./ort/ort.min.js",
  "./ort/ort-wasm-simd.wasm",
  "./raw16/index.js",
  "./raw16/worker.js"
]
  .concat(parts("./raw16/wpart", 20))
  .concat(parts("./model.part", 13))
  .concat(parts("./seg.part", 83));

function broadcast(msg) {
  return self.clients
    .matchAll({ includeUncontrolled: true })
    .then(function (list) {
      list.forEach(function (c) {
        try { c.postMessage(msg); } catch (e) { /* 頁面走咗就由佢 */ }
      });
    })
    .catch(function () {});
}

/* 將未入 cache 嘅 precache 資產逐件補入；回傳 {done,total,failed[]}（以 cache 實際內容計） */
function fillMissing() {
  return caches.open(CACHE).then(function (cache) {
    var done = 0;
    var chain = Promise.resolve();
    PRECACHE.forEach(function (url) {
      chain = chain.then(function () {
        return cache.match(url).then(function (hit) {
          if (hit) { done++; return null; }
          return fetch(url)
            .then(function (resp) {
              if (!resp || !resp.ok) throw new Error("HTTP " + (resp && resp.status));
              return cache.put(url, resp);
            })
            .then(function () { done++; })
            .catch(function () { /* 失敗嗰件留俾 computeStatus 如實報告 */ })
            .then(function () {
              return broadcast({ type: "PRECACHE_PROGRESS", done: done, total: PRECACHE.length });
            });
        });
      });
    });
    return chain.then(function () { return computeStatus(); });
  });
}

function computeStatus() {
  return caches.open(CACHE).then(function (cache) {
    var missing = [];
    var chain = Promise.resolve();
    PRECACHE.forEach(function (url) {
      chain = chain.then(function () {
        return cache.match(url).then(function (hit) { if (!hit) missing.push(url); });
      });
    });
    return chain.then(function () {
      return {
        type: "STATUS",
        done: PRECACHE.length - missing.length,
        total: PRECACHE.length,
        failed: missing,
        complete: missing.length === 0
      };
    });
  });
}

/* 盡力而為：第一次安裝時順手將 Google Fonts CSS + 字型檔放入 FONT_CACHE，
   等第二次回訪（包括離線）都有正字型。唔計入離線完整度，失敗唔出聲。 */
function warmFonts() {
  var cssUrl = "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900&display=swap";
  return caches.open(FONT_CACHE).then(function (cache) {
    return fetch(cssUrl).then(function (resp) {
      if (!resp || !resp.ok) return null;
      return resp.clone().text().then(function (text) {
        var jobs = [cache.put(cssUrl, resp)];
        var re = /url\((https:[^)]+)\)/g, m;
        while ((m = re.exec(text)) !== null) {
          (function (u) {
            jobs.push(fetch(u).then(function (r) {
              if (r && (r.ok || r.type === "opaque")) return cache.put(u, r);
              return null;
            }).catch(function () {}));
          })(m[1]);
        }
        return Promise.all(jobs);
      });
    });
  }).catch(function () {});
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    fillMissing().then(function (st) {
      return broadcast({ type: "PRECACHE_DONE", done: st.done, total: st.total, failed: st.failed })
        .then(function () { return warmFonts(); })
        .then(function () { return self.skipWaiting(); });
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE && k !== FONT_CACHE; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* 字型：獨立 cache，cache-first＋在線補入 */
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(FONT_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (resp) {
            if (resp && (resp.ok || resp.type === "opaque")) {
              try { cache.put(req, resp.clone()); } catch (e) {}
            }
            return resp;
          });
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return; /* 其他跨域唔經手 */

  /* v11.0 F-A: 導航請求走 network-first。純 cache-first 會令已裝離線版的用戶在
     **首次導航**時仍用舊頁（該次導航仍由舊 SW 控制，而舊頁面沒有 controllerchange
     處理器）；之後由 network-first + controllerchange 保證一次導航見新版。
     （註：並無「新 SW install 被舊 SW 餵入舊頁」這回事——SW 自身發起的 fetch 不被
     自己攔截，已由實測反證。）斷網時回退 cache，離線功能不受影響。 */
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (resp) {
        if (resp && resp.ok && !resp.redirected) {
          var copy = resp.clone();
          // v11.0 r6/r9: waitUntil 保住寫回；put 回傳 Promise 必須接 .catch；
          // 外層再包 try/catch（某些引擎在 event 非 active 時會同步拋錯 → 導航 reject）
          try {
            event.waitUntil(
              caches.open(CACHE).then(function (c) { return c.put("./index.html", copy); }).catch(function () {})
            );
          } catch (e) {}
        }
        return resp;
      }).catch(function () {
        return caches.open(CACHE).then(function (c) {
          return c.match("./index.html", { ignoreSearch: true });
        }).then(function (hit) {
          if (hit) return hit;
          throw new Error("offline and no cached shell");
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req)
          .then(function (resp) {
            if (resp && resp.ok) {
              try { cache.put(req, resp.clone()); } catch (e) {}
            }
            return resp;
          });
      });
    })
  );
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "STATUS") {
    computeStatus().then(function (st) {
      if (event.ports && event.ports[0]) event.ports[0].postMessage(st);
      else if (event.source) event.source.postMessage(st);
    });
  } else if (data.type === "REPAIR") {
    fillMissing().then(function (st) {
      return broadcast({ type: "PRECACHE_DONE", done: st.done, total: st.total, failed: st.failed });
    });
  }
});
