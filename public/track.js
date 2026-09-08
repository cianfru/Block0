/* First-party analytics beacon. Fire-and-forget; no cookies, no third party, no identity. window.B0T(type, extra)
   lets pages log events on top of the automatic pageview. Skips localhost so dev traffic isn't counted.

   PILOT COHORT: an invited tester arrives on a link carrying ?p=<code>. The code is remembered in localStorage
   and attached to every later beacon, so their usage separates from passing traffic without an account, a login,
   or anything that identifies a person. Clearing site data ends participation, which is the correct default. */
(function () {
  var dev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var KEY = "b0.pilot", pilot = null;
  try {
    var q = new URLSearchParams(location.search).get("p") || "";
    if (/^[a-z0-9_-]{2,24}$/i.test(q)) localStorage.setItem(KEY, q.toLowerCase());
    pilot = localStorage.getItem(KEY) || null;
  } catch (e) { /* private mode: the pilot simply isn't tagged */ }

  function track(type, extra) {
    if (dev) return;
    try {
      var body = { type: type, path: location.pathname, ref: document.referrer || "" };
      if (pilot) body.pilot = pilot;
      if (extra) for (var k in extra) body[k] = extra[k];
      var s = JSON.stringify(body);
      if (navigator.sendBeacon) navigator.sendBeacon("/api/track", new Blob([s], { type: "application/json" }));
      else fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: s, keepalive: true }).catch(function () {});
    } catch (e) { /* never break the page for analytics */ }
  }
  window.B0T = track;
  window.B0_PILOT = pilot;
  track("pageview");
})();
