/* First-party analytics beacon. Fire-and-forget; no cookies, no third party. window.B0T(type, extra) lets pages log
   wallet connects and token views on top of the automatic pageview. Skips localhost so dev traffic isn't counted. */
(function () {
  var dev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  function track(type, extra) {
    if (dev) return;
    try {
      var body = { type: type, path: location.pathname, ref: document.referrer || "" };
      if (extra) for (var k in extra) body[k] = extra[k];
      var s = JSON.stringify(body);
      if (navigator.sendBeacon) navigator.sendBeacon("/api/track", new Blob([s], { type: "application/json" }));
      else fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: s, keepalive: true }).catch(function () {});
    } catch (e) { /* never break the page for analytics */ }
  }
  window.B0T = track;
  track("pageview");
})();
