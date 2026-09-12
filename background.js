import { KEYS, getSettings, saveScan, mergeUserFields, prioritizeForProfiles } from './lib/store.js';

const IG_HOME = 'https://www.instagram.com/';
const STALE_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await scheduleAutoScan();
  await resetStaleScan();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAutoScan();
  resetStaleScan();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoScan') startScan({ auto: true });
});

async function handle(msg) {
  switch (msg?.type) {
    case 'startScan':
      return startScan({ auto: false });
    case 'cancelScan':
      return cancelScan();
    case 'scanResult': {
      const summary = await saveScan(msg.data);
      await finishScan(summary);
      autoLoadProfiles(msg.data, sender).catch(() => {});
      return { ok: true, summary };
    }
    case 'profilesBatch': {
      if (msg.userId && msg.patches) await mergeUserFields(String(msg.userId), msg.patches);
      return { ok: true };
    }
    case 'loadProfiles': {
      const settings = await getSettings();
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'loadProfiles', pks: msg.pks || [], settings });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'cancelProfiles': {
      const tab = await findIgTab();
      if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: 'cancelProfiles' }); } catch {} }
      const { bioState } = await chrome.storage.local.get(KEYS.bioState);
      if (bioState?.status === 'running' && Date.now() - (bioState.updatedAt || 0) > 60000) {
        await chrome.storage.local.set({ [KEYS.bioState]: { ...bioState, status: 'cancelled', message: 'Stopped.', updatedAt: Date.now() } });
      }
      return { ok: true };
    }
    case 'diagnose': {
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'pendingRequests': {
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'pendingRequests' });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'listFor': {
      const settings = await getSettings();
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'listFor', pk: msg.pk, kind: msg.kind, max: msg.max, settings });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'action': {
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'action', action: msg.action, pk: msg.pk });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'profile': {
      const { tab } = await ensureIgTab({ create: true });
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'profile', pk: msg.pk });
      return r || { ok: false, error: 'No answer from the Instagram tab' };
    }
    case 'igStatus': {
      const tab = await findIgTab();
      if (!tab) return { ok: true, tab: false };
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
        return { ok: true, tab: true, loggedIn: !!r?.loggedIn, userId: r?.userId || null };
      } catch {
        return { ok: true, tab: true, loggedIn: null };
      }
    }
    case 'openDashboard':
      await openDashboard(msg.hash);
      return { ok: true };
    case 'clearBadge':
      await chrome.action.setBadgeText({ text: '' });
      return { ok: true };
    case 'rescheduleAutoScan':
      await scheduleAutoScan();
      return { ok: true };
    case 'resetScan':
      await setScanState({ status: 'idle', message: '' });
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown message' };
  }
}

async function setScanState(patch) {
  const { scanState } = await chrome.storage.local.get(KEYS.scanState);
  await chrome.storage.local.set({ [KEYS.scanState]: { ...(scanState || {}), ...patch, updatedAt: Date.now() } });
}

async function resetStaleScan() {
  const { scanState } = await chrome.storage.local.get(KEYS.scanState);
  if (scanState?.status === 'running' && Date.now() - (scanState.updatedAt || 0) > STALE_MS) {
    await setScanState({ status: 'error', message: 'The last scan was interrupted. Run it again.' });
  }
}

async function findIgTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded);
  const pool = live.length ? live : tabs;
  return pool.find((t) => t.active) || pool[0];
}

async function waitForTab(tabId, timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && !t.discarded) return t;
    await sleep(300);
  }
  throw new Error('Instagram took too long to load. Check the tab and try again.');
}

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return r?.ok ? r : null;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  let r = await ping(tabId);
  if (r) return r;
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }); } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  for (let i = 0; i < 6; i++) {
    await sleep(250);
    r = await ping(tabId);
    if (r) return r;
  }
  throw new Error('Could not reach the Instagram tab. Reload it and try again.');
}

async function ensureIgTab({ create = true } = {}) {
  let tab = await findIgTab();
  let created = false;
  if (!tab) {
    if (!create) throw new Error('No Instagram tab is open.');
    tab = await chrome.tabs.create({ url: IG_HOME, active: false });
    created = true;
    tab = await waitForTab(tab.id);
  } else if (tab.discarded) {
    await chrome.tabs.reload(tab.id);
    tab = await waitForTab(tab.id);
  } else if (tab.status !== 'complete') {
    tab = await waitForTab(tab.id);
  }
  await ensureContentScript(tab.id);
  return { tab, created };
}

async function startScan({ auto }) {
  const { scanState } = await chrome.storage.local.get(KEYS.scanState);
  if (scanState?.status === 'running' && Date.now() - (scanState.updatedAt || 0) < STALE_MS) {
    return { ok: false, error: 'A scan is already running.' };
  }
  const settings = await getSettings();
  let tab, created = false;
  await chrome.storage.local.set({
    [KEYS.scanState]: { status: 'running', phase: 'starting', message: 'Opening Instagram', startedAt: Date.now(), updatedAt: Date.now(), auto },
  });
  try {
    ({ tab, created } = await ensureIgTab({ create: true }));
  } catch (e) {
    await setScanState({ status: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
  await setScanState({ tabId: tab.id, createdTab: created, message: 'Starting scan' });
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'runScan', settings });
    if (!r?.ok) throw new Error(r?.error || 'The Instagram tab did not start the scan.');
  } catch (e) {
    await setScanState({ status: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

async function cancelScan() {
  const tab = await findIgTab();
  let reached = false;
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'cancelScan' }); reached = true; } catch {}
  }
  if (!reached) await setScanState({ status: 'cancelled', message: 'Scan cancelled.' });
  return { ok: true };
}

async function finishScan(summary) {
  const { scanState } = await chrome.storage.local.get(KEYS.scanState);
  const settings = await getSettings();
  await chrome.storage.local.set({
    [KEYS.scanState]: {
      ...(scanState || {}), status: 'done', phase: 'done', message: 'Scan complete', finishedAt: Date.now(), updatedAt: Date.now(), summary,
    },
  });

  if (summary.hasPrev && summary.lostFollowers > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d63a3a' });
    await chrome.action.setBadgeText({ text: String(summary.lostFollowers) });
  } else if (summary.hasPrev && summary.newFollowers > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1a8f4d' });
    await chrome.action.setBadgeText({ text: '+' + summary.newFollowers });
  }

  if (settings.notify) {
    const parts = [];
    if (summary.hasPrev) {
      parts.push(`${summary.newFollowers} new follower${summary.newFollowers === 1 ? '' : 's'}`);
      parts.push(`${summary.lostFollowers} unfollowed you${summary.lostGone ? ` (${summary.lostGone} deactivated)` : ''}`);
    } else {
      parts.push(`${summary.f} followers, ${summary.g} following`);
    }
    parts.push(`${summary.nfb} not following back`);
    try {
      chrome.notifications.create('scan-' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `Scan finished${summary.username ? ' for @' + summary.username : ''}`,
        message: parts.join(', '),
      });
    } catch {}
  }

  if (scanState?.auto && scanState?.createdTab && scanState?.tabId) {
    try { await chrome.tabs.remove(scanState.tabId); } catch {}
  }
}

// After a manual scan, fetch bios and counts for accounts that don't have them yet.
async function autoLoadProfiles(data, sender) {
  const settings = await getSettings();
  if (!settings.autoBios || !data?.userId) return;
  const { scanState } = await chrome.storage.local.get(KEYS.scanState);
  if (scanState?.auto) return;
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  const uid = String(data.userId);
  const g = await chrome.storage.local.get(KEYS.users(uid));
  const users = g[KEYS.users(uid)] || {};
  const fl = (data.followers || []).map((u) => u.pk), gl = (data.following || []).map((u) => u.pk);
  const wlKey = KEYS.whitelist(uid);
  const wl = new Set((await chrome.storage.local.get(wlKey))[wlKey] || []);
  const pks = prioritizeForProfiles([...new Set([...fl, ...gl])].filter((pk) => !users[pk]?.bioAt), fl, gl, wl);
  if (!pks.length) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'loadProfiles', pks, settings }); } catch {}
}

chrome.notifications.onClicked.addListener((id) => {
  if (String(id).startsWith('scan-')) openDashboard('#/changes');
});

async function openDashboard(hash) {
  const base = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url: base + '*' });
  if (tabs.length) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true, ...(hash ? { url: base + hash } : {}) });
    try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
  } else {
    await chrome.tabs.create({ url: base + (hash || '') });
  }
}

async function scheduleAutoScan() {
  const s = await getSettings();
  await chrome.alarms.clear('autoScan');
  const hours = Number(s.autoScanHours) || 0;
  if (hours > 0) {
    chrome.alarms.create('autoScan', { periodInMinutes: hours * 60, delayInMinutes: hours * 60 });
  }
}
