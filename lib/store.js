// Storage layout (chrome.storage.local):
//   accounts            { [userId]: { id, username, fullName, pic, lastScan, fc, gc, stats } }
//   activeAccount       userId shown in the dashboard and popup
//   settings            user preferences (see DEFAULT_SETTINGS)
//   scanState           progress of the current or most recent scan
//   users_<id>          { [pk]: { u, n, p, v, pic, ls, ff, fg, lf, lg, bio, link, cat, fc, gc, mc, bioAt } }
//                         u username, n full name, p private, v verified, pic avatar url,
//                         ls last seen, ff first seen as follower, fg first seen in following,
//                         lf last time they stopped following you, lg last time you stopped following them
//   snapshots_<id>      [ { ts, followers: [pk], following: [pk], fc, gc, dur } ]
//   events_<id>         [ { t, k, pk, src, why } ]  k: new_follower | lost_follower | new_following | lost_following
//                         why (lost_* only): active = they really unfollowed, gone = account deactivated, deleted or blocked you
//   whitelist_<id>      [pk]
//   tags_<id>           { [pk]: { t: [tag], n: note } }
//   bioState            progress of the background profile (bio) loader
//   probe               { followers|following: { size, forMax, at } }  largest page size Instagram accepted

export const KEYS = {
  accounts: 'accounts',
  active: 'activeAccount',
  settings: 'settings',
  scanState: 'scanState',
  users: (id) => `users_${id}`,
  snapshots: (id) => `snapshots_${id}`,
  events: (id) => `events_${id}`,
  whitelist: (id) => `whitelist_${id}`,
  tags: (id) => `tags_${id}`,
  bioState: 'bioState',
};

export const DEFAULT_SETTINGS = {
  pageSize: 200,       // largest page size to ask for; the scan steps down if Instagram refuses
  delayMin: 250,       // ms between requests to start with (adaptive pacing speeds up and backs off from here)
  delayMax: 5000,      // ms cap when Instagram pushes back
  parallelLists: true, // fetch followers and following at the same time
  quickCheck: false,   // reuse the last lists when both of Instagram's counters are unchanged
  deepScan: true,      // re-fetch a list in a different order when Instagram's count says it came back short
  verifyLost: true,    // check whether accounts that disappeared still exist
  verifyCap: 150,      // at most this many existence checks per scan
  bioDelay: 600,       // ms between profile (bio) requests
  bioConcurrency: 2,   // profile requests in flight at once
  autoBios: true,      // after a scan, load profiles for accounts that don't have one yet
  waitDays: 14,        // waiting room: days without a follow back before someone shows up
  actionDelay: 12,     // seconds between follow/unfollow actions
  maxActions: 25,      // cap per batch
  maxSnapshots: 40,    // history depth
  maxEvents: 10000,
  showBadge: true,     // relationship pill on Instagram profile pages
  autoScanHours: 0,    // 0 = off
  notify: true,
  theme: 'system',
};

export const EVENT_LABELS = {
  new_follower: 'Started following you',
  lost_follower: 'Stopped following you',
  new_following: 'You started following',
  lost_following: 'You stopped following',
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export function snapshotSets(snap) {
  const followers = new Set(snap?.followers || []);
  const following = new Set(snap?.following || []);
  const mutual = [], nfb = [], fans = [];
  for (const pk of following) (followers.has(pk) ? mutual : nfb).push(pk);
  for (const pk of followers) if (!following.has(pk)) fans.push(pk);
  return { followers, following, mutual, nfb, fans };
}

export function snapshotStats(snap) {
  const s = snapshotSets(snap);
  return { f: s.followers.size, g: s.following.size, mutual: s.mutual.length, nfb: s.nfb.length, fans: s.fans.length };
}

export function diffSnapshots(prev, cur) {
  const pf = new Set(prev?.followers || []), pg = new Set(prev?.following || []);
  const cf = new Set(cur?.followers || []), cg = new Set(cur?.following || []);
  const out = { newFollowers: [], lostFollowers: [], newFollowing: [], lostFollowing: [] };
  for (const pk of cf) if (!pf.has(pk)) out.newFollowers.push(pk);
  for (const pk of pf) if (!cf.has(pk)) out.lostFollowers.push(pk);
  for (const pk of cg) if (!pg.has(pk)) out.newFollowing.push(pk);
  for (const pk of pg) if (!cg.has(pk)) out.lostFollowing.push(pk);
  return out;
}

export async function loadAccount(uid) {
  const k = [KEYS.users(uid), KEYS.snapshots(uid), KEYS.events(uid), KEYS.whitelist(uid), KEYS.tags(uid)];
  const g = await chrome.storage.local.get(k);
  return {
    users: g[KEYS.users(uid)] || {},
    snaps: g[KEYS.snapshots(uid)] || [],
    events: g[KEYS.events(uid)] || [],
    whitelist: g[KEYS.whitelist(uid)] || [],
    tags: g[KEYS.tags(uid)] || {},
  };
}

// Merge a finished scan into storage. Returns a summary used for the badge and notification.
export async function saveScan(data) {
  const uid = String(data.userId);
  const settings = await getSettings();
  const g = await chrome.storage.local.get([KEYS.users(uid), KEYS.snapshots(uid), KEYS.events(uid), KEYS.accounts]);
  const users = g[KEYS.users(uid)] || {};
  const snaps = g[KEYS.snapshots(uid)] || [];
  const events = g[KEYS.events(uid)] || [];
  const accounts = g[KEYS.accounts] || {};
  const now = data.finishedAt || Date.now();
  const prev = snaps[snaps.length - 1] || null;
  const prevF = new Set(prev?.followers || []);
  const prevG = new Set(prev?.following || []);
  if (data.reuse && prev) {
    const fromUsers = (pk) => ({ pk, u: users[pk]?.u || '', n: users[pk]?.n || '', p: !!users[pk]?.p, v: !!users[pk]?.v, pic: '' });
    data.followers = prev.followers.map(fromUsers);
    data.following = prev.following.map(fromUsers);
  }

  const touch = (u) => {
    const r = users[u.pk] || {};
    r.u = u.u || r.u || '';
    r.n = u.n ?? r.n ?? '';
    r.p = !!u.p;
    r.v = !!u.v;
    if (u.pic) r.pic = u.pic;
    r.ls = now;
    users[u.pk] = r;
    return r;
  };
  for (const u of data.followers) {
    const r = touch(u);
    if (!prev || !prevF.has(u.pk) || !r.ff) r.ff = now;
  }
  for (const u of data.following) {
    const r = touch(u);
    if (!prev || !prevG.has(u.pk) || !r.fg) r.fg = now;
  }

  const snap = {
    ts: now,
    followers: data.followers.map((u) => u.pk),
    following: data.following.map((u) => u.pk),
    fc: data.followerCount || data.followers.length,
    gc: data.followingCount || data.following.length,
    dur: data.startedAt ? now - data.startedAt : 0,
    req: data.requests || 0,
    waited: data.waitedMs || 0,
    quick: !!data.reuse,
    pageSize: data.pageSize || 0,
  };

  const summary = { hasPrev: !!prev, newFollowers: 0, lostFollowers: 0, newFollowing: 0, lostFollowing: 0, lostGone: 0, quick: !!data.reuse };
  if (prev) {
    const d = diffSnapshots(prev, snap);
    const why = (pk) => (data.gone && data.gone[pk]) || null;
    for (const pk of d.newFollowers) events.push({ t: now, k: 'new_follower', pk, src: 'scan' });
    for (const pk of d.lostFollowers) {
      const w = why(pk);
      events.push({ t: now, k: 'lost_follower', pk, src: 'scan', why: w });
      if (users[pk]) { users[pk].lf = now; if (w === 'gone') users[pk].gone = now; }
      if (w === 'gone') summary.lostGone++;
    }
    for (const pk of d.newFollowing) events.push({ t: now, k: 'new_following', pk, src: 'scan' });
    for (const pk of d.lostFollowing) {
      const w = why(pk);
      events.push({ t: now, k: 'lost_following', pk, src: 'scan', why: w });
      if (users[pk]) { users[pk].lg = now; if (w === 'gone') users[pk].gone = now; }
    }
    summary.newFollowers = d.newFollowers.length;
    summary.lostFollowers = d.lostFollowers.length;
    summary.newFollowing = d.newFollowing.length;
    summary.lostFollowing = d.lostFollowing.length;
  }

  snaps.push(snap);
  while (snaps.length > Math.max(2, settings.maxSnapshots)) snaps.shift();
  while (events.length > settings.maxEvents) events.shift();

  const stats = snapshotStats(snap);
  const old = accounts[uid] || {};
  accounts[uid] = {
    id: uid,
    username: data.username || old.username || '',
    fullName: data.fullName || old.fullName || '',
    pic: data.pic || old.pic || '',
    lastScan: now,
    fc: snap.fc,
    gc: snap.gc,
    deep: data.deep || old.deep || null,
    stats: { ...stats, ...summary },
  };

  await chrome.storage.local.set({
    [KEYS.users(uid)]: users,
    [KEYS.snapshots(uid)]: snaps,
    [KEYS.events(uid)]: events,
    [KEYS.accounts]: accounts,
    [KEYS.active]: uid,
  });
  Object.assign(summary, stats);
  summary.username = accounts[uid].username;
  return summary;
}

// After a follow/unfollow done from the dashboard, keep the latest snapshot in step.
export async function applyLocalAction(uid, action, pk) {
  const g = await chrome.storage.local.get([KEYS.snapshots(uid), KEYS.events(uid), KEYS.users(uid)]);
  const snaps = g[KEYS.snapshots(uid)] || [];
  const events = g[KEYS.events(uid)] || [];
  const users = g[KEYS.users(uid)] || {};
  const snap = snaps[snaps.length - 1];
  if (!snap) return null;
  const now = Date.now();
  if (action === 'approve') {
    const fset = new Set(snap.followers);
    if (fset.has(pk)) return null;
    fset.add(pk);
    snap.followers = [...fset];
    snap.fc = Math.max(snap.fc || 0, snap.followers.length);
    events.push({ t: now, k: 'new_follower', pk, src: 'you' });
    if (users[pk]) { users[pk].ff = now; users[pk].ffExact = true; }
    await chrome.storage.local.set({ [KEYS.snapshots(uid)]: snaps, [KEYS.events(uid)]: events, [KEYS.users(uid)]: users });
    return { snaps, events, users };
  }
  const set = new Set(snap.following);
  if (action === 'unfollow') {
    if (!set.has(pk)) return null;
    set.delete(pk);
    events.push({ t: now, k: 'lost_following', pk, src: 'you' });
    if (users[pk]) users[pk].lg = now;
  } else {
    if (set.has(pk)) return null;
    set.add(pk);
    events.push({ t: now, k: 'new_following', pk, src: 'you' });
    if (users[pk]) users[pk].fg = now;
  }
  snap.following = [...set];
  snap.gc = snap.following.length;
  await chrome.storage.local.set({ [KEYS.snapshots(uid)]: snaps, [KEYS.events(uid)]: events, [KEYS.users(uid)]: users });
  return { snaps, events, users };
}

export async function saveTags(uid, tags) {
  await chrome.storage.local.set({ [KEYS.tags(uid)]: tags });
}

// Instagram's "Download your information" export (JSON format). Each entry looks like
// { title, media_list_data, string_list_data: [{ href, value, timestamp }] }; the username is
// in value (newer exports) or title (older ones) and timestamp is in seconds.
export function parseExportEntries(json) {
  let arr = null;
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === 'object') {
    arr = json.relationships_followers || json.relationships_following || json.relationships_follow_requests_sent
      || Object.values(json).find((v) => Array.isArray(v)) || null;
  }
  if (!arr) return [];
  const out = [];
  for (const item of arr) {
    const d = item?.string_list_data?.[0];
    if (!d) continue;
    const u = String(d.value || item.title || '').trim().replace(/^@/, '');
    if (!u) continue;
    const ts = d.timestamp ? Number(d.timestamp) * 1000 : null;
    out.push({ u, ts });
  }
  return out;
}

// Backfill accurate "since" dates from an export. Only accounts already known from a scan can be matched.
export async function importDataExport(uid, { followers = [], following = [] }) {
  const g = await chrome.storage.local.get([KEYS.users(uid), KEYS.accounts]);
  const users = g[KEYS.users(uid)] || {};
  const accounts = g[KEYS.accounts] || {};
  const byName = new Map();
  for (const [pk, r] of Object.entries(users)) if (r.u) byName.set(r.u.toLowerCase(), pk);
  let matchedF = 0, matchedG = 0, updated = 0;
  for (const { u, ts } of followers) {
    const pk = byName.get(u.toLowerCase());
    if (!pk) continue;
    matchedF++;
    if (ts && (!users[pk].ffExact || ts < users[pk].ff)) { users[pk].ff = ts; users[pk].ffExact = true; updated++; }
  }
  for (const { u, ts } of following) {
    const pk = byName.get(u.toLowerCase());
    if (!pk) continue;
    matchedG++;
    if (ts && (!users[pk].fgExact || ts < users[pk].fg)) { users[pk].fg = ts; users[pk].fgExact = true; updated++; }
  }
  if (accounts[uid]) accounts[uid].exportImport = { at: Date.now(), matchedF, matchedG, totalF: followers.length, totalG: following.length };
  await chrome.storage.local.set({ [KEYS.users(uid)]: users, [KEYS.accounts]: accounts });
  return { matchedF, matchedG, updated, totalF: followers.length, totalG: following.length };
}

// Merge extra fields (bio, counts) into user records without touching anything else.
export async function mergeUserFields(uid, patches) {
  const g = await chrome.storage.local.get(KEYS.users(uid));
  const users = g[KEYS.users(uid)] || {};
  for (const [pk, fields] of Object.entries(patches)) users[pk] = { ...(users[pk] || {}), ...fields };
  await chrome.storage.local.set({ [KEYS.users(uid)]: users });
  return users;
}

export async function deleteSnapshot(uid, ts) {
  const g = await chrome.storage.local.get(KEYS.snapshots(uid));
  const snaps = (g[KEYS.snapshots(uid)] || []).filter((s) => s.ts !== ts);
  await chrome.storage.local.set({ [KEYS.snapshots(uid)]: snaps });
  return snaps;
}

export async function deleteAccountData(uid) {
  const { accounts, activeAccount } = await chrome.storage.local.get([KEYS.accounts, KEYS.active]);
  const next = { ...(accounts || {}) };
  delete next[uid];
  await chrome.storage.local.remove([KEYS.users(uid), KEYS.snapshots(uid), KEYS.events(uid), KEYS.whitelist(uid), KEYS.tags(uid)]);
  const patch = { [KEYS.accounts]: next };
  if (activeAccount === uid) patch[KEYS.active] = Object.keys(next)[0] || null;
  await chrome.storage.local.set(patch);
}

export async function exportBackup(uid) {
  const { accounts, settings } = await chrome.storage.local.get([KEYS.accounts, KEYS.settings]);
  const ids = uid ? [uid] : Object.keys(accounts || {});
  const data = {};
  for (const id of ids) {
    const g = await chrome.storage.local.get([KEYS.users(id), KEYS.snapshots(id), KEYS.events(id), KEYS.whitelist(id), KEYS.tags(id)]);
    data[id] = {
      account: accounts?.[id] || null,
      users: g[KEYS.users(id)] || {},
      snapshots: g[KEYS.snapshots(id)] || [],
      events: g[KEYS.events(id)] || [],
      whitelist: g[KEYS.whitelist(id)] || [],
      tags: g[KEYS.tags(id)] || {},
    };
  }
  return { app: 'follow-insights', version: 1, exportedAt: Date.now(), settings: settings || {}, accounts: data };
}

export async function importBackup(obj) {
  if (!obj || obj.app !== 'follow-insights' || !obj.accounts) throw new Error('That file is not a Follow Insights backup.');
  const { accounts } = await chrome.storage.local.get(KEYS.accounts);
  const merged = { ...(accounts || {}) };
  const patch = {};
  let count = 0;
  for (const [id, d] of Object.entries(obj.accounts)) {
    if (!d || typeof d !== 'object') continue;
    if (d.account) merged[id] = d.account;
    patch[KEYS.users(id)] = d.users || {};
    patch[KEYS.snapshots(id)] = d.snapshots || [];
    patch[KEYS.events(id)] = d.events || [];
    patch[KEYS.whitelist(id)] = d.whitelist || [];
    patch[KEYS.tags(id)] = d.tags || {};
    count++;
  }
  patch[KEYS.accounts] = merged;
  if (obj.settings && typeof obj.settings === 'object') patch[KEYS.settings] = { ...DEFAULT_SETTINGS, ...obj.settings };
  const ids = Object.keys(obj.accounts);
  if (ids.length) patch[KEYS.active] = ids[0];
  await chrome.storage.local.set(patch);
  return count;
}
