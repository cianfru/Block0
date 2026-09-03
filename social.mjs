// SOCIAL STATE — the persistent side of the /post workspace: a QUEUE of things planned to post and a LOG of
// what's already gone out. Pure reducer over {queue, log} so it's testable and the server just loads from KV,
// applies one action, and saves. Nothing here posts anything — it's a planner + a record, owner-driven.
//
// Items are card snapshots (so a queued card survives after the live card rotates out) or free-text customs.
// The server stamps each new item with a uid + createdAt before it reaches the reducer, so the reducer only
// ever moves items between the two lists — it never mints ids (keeps it deterministic + pure).

export function emptyState() { return { queue: [], log: [] }; }

export function applySocial(state, action) {
  const s = { queue: [...((state && state.queue) || [])], log: [...((state && state.log) || [])] };
  const a = action || {};
  switch (a.type) {
    case "queue":
      if (a.item && a.item.uid) s.queue.push(a.item);
      break;
    case "unqueue":
      s.queue = s.queue.filter((x) => x.uid !== a.uid);
      break;
    case "move": {                                   // reorder within the queue (dir < 0 = up, else down)
      const i = s.queue.findIndex((x) => x.uid === a.uid);
      if (i >= 0) { const j = i + (a.dir < 0 ? -1 : 1); if (j >= 0 && j < s.queue.length) { const [it] = s.queue.splice(i, 1); s.queue.splice(j, 0, it); } }
      break;
    }
    case "posted": {                                 // mark posted: pull from queue if it was queued, else an ad-hoc item
      let item = a.item;
      if (a.uid) { const i = s.queue.findIndex((x) => x.uid === a.uid); if (i >= 0) { item = s.queue[i]; s.queue.splice(i, 1); } }
      if (item && item.uid) { s.log.unshift({ ...item, postedAt: a.now || 0, url: a.url || null }); s.log = s.log.slice(0, 200); }
      break;
    }
    case "logRemove":
      s.log = s.log.filter((x) => x.uid !== a.uid);
      break;
    case "unpost": {                                 // undo a mark-posted: move a log entry back to the queue
      const i = s.log.findIndex((x) => x.uid === a.uid);
      if (i >= 0) { const [it] = s.log.splice(i, 1); const { postedAt, url, ...rest } = it; s.queue.push(rest); }
      break;
    }
    case "clearQueue":
      s.queue = [];
      break;
    default:
      break;
  }
  return s;
}

// A light cadence read for the header: when the last post went out and how many in the trailing week.
export function cadence(state, now = Date.now()) {
  const log = (state && state.log) || [];
  const last = log.length ? log[0].postedAt || null : null;
  const weekAgo = now - 7 * 864e5;
  const week = log.filter((x) => (x.postedAt || 0) >= weekAgo).length;
  const today = log.filter((x) => (x.postedAt || 0) >= now - 864e5).length;
  return { queued: ((state && state.queue) || []).length, posted: log.length, last, week, today,
    lastAgoH: last ? Math.round((now - last) / 36e5) : null };
}
