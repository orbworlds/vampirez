#!/usr/bin/env node
// VampireZ (index.html) in a headless browser, through its ?debug hooks (window.__vz): Ravencross,
// the lobby, boots with its keepers, each keeper opens what they keep (by E and by a click), every panel draws, and
// progression pays out (the daily reward, quests, achievements, the Blood Pass and Blood Pass+, coffins, credit looks,
// the Lantern Run). A night is played from the Night Gate to dawn and back; kill effects show; two players see each
// other in Ravencross (emotes, quick chat) and then share a night (orb.room faked with a relay between two browser
// windows, orb.store shared through this process). Then phones and tablets: a phone walks Ravencross and plays by touch,
// and in every size (and Safari's engine, WebKit, where it's installed) everything fits and takes a tap.
//
//   node test/play.mjs [--quick: no two-player night] [--phones: only the phones and tablets]
import { webkit, devices } from 'playwright';
import { launch, routeCdn } from '@orbworlds/kit/browser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(root, 'index.html');
const URL = 'file://' + GAME + '?debug';
const quick = process.argv.includes('--quick'), phonesOnly = process.argv.includes('--phones');
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failures++; };

// A stand-in for Orb's runtime: rooms relayed between the pages by this process, a store shared by them all (VampireZ
// finds nights through it), and a shop in memory.
function fakeOrb({ id, name }) {
  const store = (op, k, v, x) => window.__store(op, k, v, x);
  window.orb = {
    me: { id, name, color: '#5ed1ff', wears: [] },
    world: { id: 'test', name: 'VampireZ' },
    room: {
      invited: null,
      invite: async (r) => `https://example.test/?room=${r}`,
      join(cb, opts = {}) {
        const topic = 'room:' + (opts.name || ''), self = { id: `${id}:${Math.random().toString(36).slice(2, 8)}`, name, color: '#5ed1ff' };
        const ch = { onmessage: null, postMessage: (data) => window.__relay?.(topic, data), close() { ch.closed = true; } };
        (window.__chans ||= []).push([topic, ch]);
        let state = null, left = false;
        const known = new Map();
        const peer = (p) => ({ id: p.id, name: p.name, color: p.color, wears: [], state: p.state, friend: false });
        ch.onmessage = (ev) => {
          const m = ev.data; if (left || !m || m.from?.id === self.id) return;
          if (m.t === 'hello' || m.t === 'state') {
            const had = known.has(m.from.id); known.set(m.from.id, { ...m.from, state: m.state });
            cb({ type: had ? 'state' : 'join', peer: peer(known.get(m.from.id)) });
            if (m.t === 'hello' && !m.reply) ch.postMessage({ t: 'hello', reply: true, from: self, state });
          } else if (m.t === 'msg') cb({ type: 'message', peer: peer(known.get(m.from.id) || m.from), data: m.data });
          else if (m.t === 'bye' && known.has(m.from.id)) { const p = known.get(m.from.id); known.delete(m.from.id); cb({ type: 'leave', peer: peer(p) }); }
        };
        setTimeout(() => { cb({ type: 'joined', self: peer(self), peers: [...known.values()].map(peer), live: true }); ch.postMessage({ t: 'hello', from: self, state }); }, 30);
        return {
          send: (data) => !left && ch.postMessage({ t: 'msg', from: self, data }),
          setState: (s) => { state = s; if (!left) ch.postMessage({ t: 'state', from: self, state: s }); },
          leave: () => { if (left) return; ch.postMessage({ t: 'bye', from: self }); left = true; ch.close(); },
        };
      },
    },
    store: { get: (k) => store('get', k), set: (k, v) => store('set', k, v), incr: (k, by = 1) => store('incr', k, by), push: (k, v, max = 50) => store('push', k, v, max), merge: (k, p) => store('merge', k, p) },
    shop: { owned: async () => window.__owned || [], items: async () => [], buy: async (item) => { (window.__owned ||= []).push(item); return { ok: true, item }; } },
    capture() {}, toast() {},
  };
}
const STORE = new Map();
function storeOp(op, k, v, x) {
  const cur = STORE.has(k) ? structuredClone(STORE.get(k)) : null;
  if (op === 'get') return cur;
  if (op === 'set') { STORE.set(k, v); return v; }
  if (op === 'incr') { const n = (typeof cur === 'number' ? cur : 0) + (v ?? 1); STORE.set(k, n); return n; }
  if (op === 'push') { const l = Array.isArray(cur) ? cur : []; l.push(v); while (l.length > (x || 50)) l.shift(); STORE.set(k, l); return l; }
  if (op === 'merge') { const o = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}; for (const [a, b] of Object.entries(v || {})) { if (b === null) delete o[a]; else o[a] = b; } STORE.set(k, o); return o; }
  return null;
}

const pages = new Set();
async function openPage(browser, who, device = { viewport: { width: 1100, height: 680 } }, { daily = false, seed = null } = {}) {
  const page = await (await browser.newContext(device)).newPage();
  pages.add(page); page.on('close', () => pages.delete(page));
  await page.exposeFunction('__relay', (topic, data) => {
    for (const p of pages) if (p !== page) p.evaluate(([t, d]) => { for (const [tp, ch] of window.__chans || []) if (tp === t && !ch.closed) ch.onmessage?.({ data: d }); }, [topic, data]).catch(() => {});
  });
  await page.exposeFunction('__store', storeOp);
  await routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
  await page.addInitScript(fakeOrb, { id: `${who}-id`, name: who });
  if (seed) await page.addInitScript(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), seed);   // what this device kept from before
  await page.goto(URL + (daily ? '' : '&nodaily'));
  await page.waitForFunction(() => window.__vz?.lobby?.me && window.__vz.game.state === 'title', null, { timeout: 40000 });
  await orbDock(page);
  return { page, errors };
}
const shown = (page, id) => page.evaluate((id) => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none'; }, id);
const openPanelId = (page) => page.evaluate(() => ['loadout', 'challenges', 'wardrobe', 'nightOpts', 'pass', 'coffins', 'boards', 'daily'].find((id) => !document.getElementById(id).classList.contains('hidden')) || '');
/** Stand next to a keeper (facing them) and let a frame see it. */
async function standBy(page, id) {
  await page.evaluate((id) => { const v = window.__vz, k = v.lobby.keepers.find((e) => e.keeper.id === id), p = v.lobby.me; Object.assign(p, { x: k.x, z: k.z + 1.4, y: k.y, vx: 0, vz: 0 }); }, id);
  await page.waitForFunction((id) => window.__vz.lobby.near?.keeper.id === id, id, { timeout: 15000 });
}
// Phones and tablets: real touches through Chromium's DevTools protocol (they arrive as touch and pointer events, and a
// tap clicks), in each size and both ways round.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const device = (width, height, userAgent = IPHONE) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent });
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  // a button scrolled out of sight is scrolled to first, as a thumb would
  const at = (p) => (typeof p === 'string' ? page.$eval(p, (el) => { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }) : p);
  return {
    async tap(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(60); await send('touchEnd', []); await page.waitForTimeout(300); },
    async down(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(120); },
    async up() { await send('touchEnd', []); await page.waitForTimeout(120); },
    async drag(p0, [x1, y1], ms = 300, holdMs = 0) {
      const [x0, y0] = await at(p0);
      await send('touchStart', [[x0, y0]]);
      for (let i = 1; i <= 8; i++) { await send('touchMove', [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]); await page.waitForTimeout(ms / 8); }
      if (holdMs) await page.waitForTimeout(holdMs);
      await send('touchEnd', []); await page.waitForTimeout(150);
    },
  };
}
/** What's wrong on screen: each control should be inside the screen, big enough for a thumb, on top where it is (a tap
 *  there reaches it) and clear of the other controls and of the HUD's panels (`[controls, panels]`); the panels should
 *  be inside the screen and clear of each other. */
const auditControls = (page, [controls, panels = []]) => page.evaluate(([controls, panels]) => {
  const bad = [], seen = [], shown = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && !el.closest('.hidden') && el.getBoundingClientRect().width > 0; };
  const over = (r, r2) => Math.min(r.right, r2.right) - Math.max(r.left, r2.left) > 3 && Math.min(r.bottom, r2.bottom) - Math.max(r.top, r2.top) > 3;
  const offScreen = (r) => r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
  // what of it shows: a list that scrolls clips what's scrolled away (a swipe brings it back)
  const inView = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!/auto|scroll|hidden/.test(getComputedStyle(a).overflow)) continue;
      const c = a.getBoundingClientRect(); left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
    }
    return right - left > 3 && bottom - top > 3 ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const boxes = panels.flatMap((sel) => [...document.querySelectorAll(sel)].filter(shown).map((el) => [el.id || sel, el, el.getBoundingClientRect()]));
  for (const [i, [name, el, r]] of boxes.entries()) {
    if (offScreen(r)) bad.push(`${name} off screen`);
    for (const [n2, el2, r2] of boxes.slice(0, i)) if (!el.contains(el2) && !el2.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
  }
  const done = new Set();
  for (const sel of controls) for (const el of document.querySelectorAll(sel)) {
    if (!shown(el) || done.has(el)) continue;
    done.add(el);
    const r = inView(el), full = el.getBoundingClientRect(), name = el.id || el.getAttribute('aria-label') || sel;
    if (!r) continue;
    if (offScreen(r)) bad.push(`${name} off screen`);
    if (Math.min(full.width, full.height) < 36) bad.push(`${name} ${Math.round(full.width)}×${Math.round(full.height)} px`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && !el.contains(hit)) bad.push(`${name} under ${hit.id || hit.className || hit.tagName}`);
    for (const [n2, r2] of seen) if (over(r, r2)) bad.push(`${name} on ${n2}`);
    for (const [n2, box, r2] of boxes) if (!box.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
    seen.push([name, r]);
  }
  return [...new Set(bad)];
}, [controls, panels]);
// Ravencross's controls round the edges (the profile card is a panel: nothing may sit on it), and the night's. Orb's
// own button floats over the world on the right edge, 72% of the way down (src/components/orb/Orb.tsx): a stand-in
// for it (#orbDock, which takes no taps) is a panel too, so no control hides under it.
const LOBBY_CONTROLS = [['#play', '#solo', '#openNight', '#openChallenges', '#openPass', '#openWardrobe', '#openLoadout', '#openCoffins', '#openBoards', '#lEmote', '#lMute', '#meSilver', '#tJump', '#tBat', '#tUse'], ['#lProf', '#orbDock']];
const NIGHT_CONTROLS = [['#tAttack', '#tAlt', '#tJump', '#tPing', '#tCrouch', '#tUse', '#tBat', '#shopBtn', '#pauseBtn', '#muteBtn', '#hotbar .slot'], ['#teams', '#clock', '#hearts', '#money', '#hotbar', '#orbDock']];
const orbDock = (page) => page.evaluate(() => {
  const d = document.getElementById('orbDock') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'orbDock' }));
  d.style.cssText = 'position:fixed;width:56px;height:56px;right:18px;top:calc(18px + (100% - 92px) * 0.72);pointer-events:none;z-index:-1';
});
const PANEL_IDS = ['challenges', 'pass', 'coffins', 'boards', 'nightOpts', 'daily', 'wardrobe', 'loadout'];
/** Each panel on its own: inside the screen, and its buttons take a tap (a list may scroll). */
async function auditPanels(page) {
  const problems = [];
  for (const id of PANEL_IDS) {
    await page.evaluate((id) => window.__vz.openPanel(id), id); await page.waitForTimeout(250);
    problems.push(...(await auditControls(page, [[`#${id} [data-close]`, `#${id} .tabs button`, `#${id} .btn:not([disabled])`], [`#${id}`]])).map((x) => `${id}: ${x}`));
  }
  await page.evaluate(() => window.__vz.closePanels());
  return problems;
}
/** Where a keeper's head is on screen, to tap or click them. */
const keeperOnScreen = (page, id) => page.evaluate((id) => {
  const v = window.__vz, k = v.lobby.keepers.find((e) => e.keeper.id === id), p = k.model.root.position.clone(); p.y += 1.3; p.project(v.camera);
  return [(p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight];
}, id);

const browser = await launch();
try {
  if (!phonesOnly) {
    // --- a career from before October 2026's economy (level 30 on the old curve, 1,000 silver, tier 3 of this month's
    // pass), opened before anyone else so it shares no room with them ------------------------------------------------
    const oldXp = (L) => { let t = 0; for (let l = 1; l < L; l++) t += 120 + 30 * (l - 1); return t; };
    const vet = await openPage(browser, 'veteran', undefined, { seed: ['vz:profile', { v: 3, xp: oldXp(30) + 10, silver: 1000, owned: [], ach: { level: 3 }, pass: { s: new Date().toISOString().slice(0, 7), xp: 1250, free: [1, 2, 3], plus: [] } }] });
    const mig = await vet.page.evaluate(() => { const v = window.__vz, o = v.profile.owned; return { level: v.level(), silver: v.profile.silver, tier: v.passTier(), crown: o.includes('hat:crown'), gilded: o.includes('cape:gilded'), halo: o.includes('hat:halo'), wear: v.LOOKS.hat.find((h) => h.id === 'crown').lvl, econ: v.profile.econ }; });
    ok(mig.level === 30 && mig.silver === 18000 && mig.tier === 3 && mig.crown && mig.gilded && !mig.halo && mig.wear > 30 && mig.econ === 1 && !vet.errors.length,
      `a career from before the new economy keeps its level (30), what its silver could buy (1,000 → 18,000), its pass tier, and the looks its level had unlocked that now unlock later (${JSON.stringify(mig)})`);
    await vet.page.context().close();
    // the month turned with Blood Pass+ tiers unclaimed, before Orb had said what the account owns: they're paid once it
    // says it has Blood Pass+, where it had it then (seen on this device, or claimed from that track); not for one bought since
    const last = new Date(); last.setUTCDate(1); last.setUTCMonth(last.getUTCMonth() - 1);
    const prevPlus = {}, pvErrors = [];
    for (const [label, extra, plus] of [['seen', { plusSeen: 1 }, []], ['claimed', {}, [1]], ['since', {}, []]]) {
      const pv = await openPage(browser, 'plus-' + label, undefined, { seed: ['vz:profile', { v: 3, econ: 1, xp: 0, silver: 1000, owned: [], ach: {}, ...extra, pass: { s: last.toISOString().slice(0, 7), xp: 700 * 3, free: [1, 2, 3], plus } }] });
      await pv.page.evaluate(() => { window.__vz.pass(); window.__owned = ['blood-pass']; window.__vz.loadShopOwned(); });
      await pv.page.waitForFunction(() => window.__vz.profile.plusSeen && !window.__vz.profile.passPrev, null, { timeout: 10000 }).catch(() => {});
      prevPlus[label] = await pv.page.evaluate((m) => { const v = window.__vz; return { cape: v.profile.owned.includes('cape:s' + m), silver: v.profile.silver, waiting: !!v.profile.passPrev }; }, last.getUTCMonth());
      pvErrors.push(...pv.errors); await pv.page.context().close();
    }
    const { seen: wasSeen, claimed: wasClaimed, since: boughtSince } = prevPlus;
    ok(wasSeen.cape && wasSeen.silver === 1200 && !wasSeen.waiting && !wasClaimed.cape && wasClaimed.silver === 1200 && !wasClaimed.waiting && !boughtSince.cape && boughtSince.silver === 1000 && !pvErrors.length,
      `the month turning doesn't drop last season's Blood Pass+ tiers: once Orb says the account has it, they're paid (its cape and +200 silver; what's left of a track you'd claimed from), but not for a pass bought since (${JSON.stringify(prevPlus)})`);

    // --- Ravencross ---------------------------------------------------------------------------------------------------
    const A = await openPage(browser, 'Ana', undefined, { daily: true });
    const P = A.page;
    const boot = await P.evaluate(() => { const v = window.__vz; return { map: v.MAP.id, keepers: v.lobby.keepers.map((k) => k.keeper.id), lobby: document.body.classList.contains('inlobby'), gate: !!v.lobby.portal }; });
    ok(boot.map === 'lobby' && boot.keepers.length === 8 && boot.lobby && boot.gate, `it opens in Ravencross, the eight keepers at their posts and the Night Gate aglow (${boot.keepers.join(', ')})`);
    const desk = [];
    for (const [w, h] of [[1100, 680], [1024, 600], [1440, 900]]) { await P.setViewportSize({ width: w, height: h }); await P.waitForTimeout(400); desk.push(...(await auditControls(P, LOBBY_CONTROLS)).filter((x) => !/ \d+×\d+ px$/.test(x)).map((x) => `${w}×${h}: ${x}`)); }   // a mouse needs no thumb-sized buttons
    await P.setViewportSize({ width: 1100, height: 680 });
    ok(!desk.length, `on a laptop, Ravencross's buttons fit round the edges, clear of each other and of Orb's button${desk.length ? ' — ' + desk.join(', ') : ''}`);
    await P.waitForFunction(() => !document.getElementById('daily').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
    ok(await shown(P, 'daily'), 'the daily reward is waiting on arrival');
    const s0 = await P.evaluate(() => window.__vz.profile.silver);
    await P.click('#dClaim');
    const claimed = await P.evaluate((s0) => { const v = window.__vz; return { s: v.profile.silver - s0, streak: v.profile.login.streak, ready: v.loginState().ready, chip: document.getElementById('lStreak').textContent, open: !document.getElementById('daily').classList.contains('hidden') }; }, s0);
    ok(claimed.s === 40 && claimed.streak === 1 && !claimed.ready && !claimed.open, `claiming day 1 pays 40 silver and closes the calendar (${JSON.stringify(claimed)})`);
    const tomorrow = await P.evaluate(() => {
      const v = window.__vz, d = new Date(); d.setDate(d.getDate() - 1);
      const y = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      Object.assign(v.profile.login, { streak: 6, last: y, claimed: y });
      const st = v.loginState(), c0 = v.profile.coffins, r = v.claimLogin();
      return { day: st.day, ready: st.ready, r, cof: v.profile.coffins - c0, faithful: v.profile.owned.includes('title:Faithful') };
    });
    ok(tomorrow.day === 7 && tomorrow.ready && tomorrow.r.s === 250 && tomorrow.cof === 1 && tomorrow.faithful, `come back the next day and the streak goes on: day 7 pays 250 silver and a coffin, and a week in a row earns the Faithful title (${JSON.stringify(tomorrow)})`);

    // the keepers, by E and by a click
    const want = { coffins: 'coffins', pass: 'pass', wardrobe: 'wardrobe', quests: 'challenges', daily: 'daily', loadout: 'loadout', boards: 'boards', night: 'nightOpts' };
    const talks = [];
    for (const id of Object.keys(want)) {
      await standBy(P, id);
      await P.keyboard.press('KeyE'); await P.waitForTimeout(250);
      talks.push(`${id}→${await openPanelId(P)}`);
      await P.keyboard.press('Escape'); await P.waitForTimeout(150);
    }
    ok(talks.every((t, i) => t === `${Object.keys(want)[i]}→${Object.values(want)[i]}`), `each keeper, by E, opens what they keep (${talks.join(', ')})`);
    await standBy(P, 'quests');
    await P.evaluate(() => { const v = window.__vz; v.lobby.me.z += 2.5; v.cam.yaw = 0; v.cam.pitch = -0.15; });
    await P.waitForTimeout(600);
    const [kx, ky] = await keeperOnScreen(P, 'quests');
    await P.mouse.click(kx, ky); await P.waitForTimeout(300);
    ok(await openPanelId(P) === 'challenges', 'a click on the Town Crier opens the quests');
    await P.keyboard.press('Escape');

    // every panel and every tab draws
    const drawn = await P.evaluate(() => {
      const v = window.__vz, out = [];
      for (const id of ['challenges', 'pass', 'coffins', 'boards', 'nightOpts', 'daily', 'loadout']) { v.openPanel(id); out.push([id, document.getElementById(id).innerText.length]); }
      for (const qt of ['day', 'week', 'ach', 'you']) { document.querySelector(`#qTabs [data-qt="${qt}"]`).click(); v.openPanel('challenges'); out.push(['quests ' + qt, document.getElementById('chList').innerText.length + document.getElementById('lifeStats').innerText.length]); }
      for (const t of ['outfit', 'vskin', 'hat', 'cape', 'kill', 'plate', 'title', 'you']) { v.openWardrobe(t); out.push(['wardrobe ' + t, document.getElementById('wdGrid').children.length]); }
      v.closePanels();
      return out;
    });
    ok(drawn.every(([, n]) => n > 0), `every panel and tab draws: ${drawn.map(([id, n]) => `${id} ${n}`).join(', ')}`);

    // quests: today's, this week's, the swap
    const quests = await P.evaluate(() => {
      const v = window.__vz, d = v.dailies(), q0 = d.list[0];
      const s0 = v.profile.silver, swapped = v.swapDaily(2), again = v.swapDaily(1);
      const goal = { zombies: 30, vampires: 4, turned: 3, dawn: 1, vwin: 1, bells: 1, crits: 15, nights: 3, apples: 3, diamond: 1, loot: 2, supply: 1, run: 1 }[q0.id];
      const done = v.countQuests({ [q0.id]: goal });
      const w = v.weeklies(), wq = w.list[0], wgoal = { dawns: 5, vwins: 3, zombies: 200, vampires: 25, turned: 15, nights: 15, loot: 15, daily: 8, bells: 5, maps: 2 }[wq.id];
      const wdone = v.countQuests({ [wq.id]: wgoal });
      return { first: q0.id, done: done.map((q) => `${q.kind}:${q.id}`), wdone: wdone.map((q) => `${q.kind}:${q.id}`), swapped, again, silverSame: v.profile.silver === s0, list: d.list.map((c) => `${c.id}${c.done ? '✓' : ''}`) };
    });
    ok(quests.done.includes(`daily:${quests.first}`) && quests.wdone.some((x) => x.startsWith('weekly:')) && quests.swapped && !quests.again, `quests finish when counted (today's and this week's), and one of today's can be swapped, once (${JSON.stringify(quests)})`);

    // achievements, the Blood Pass and Blood Pass+, coffins
    const ach = await P.evaluate(() => { const v = window.__vz, s0 = v.profile.silver; v.profile.stats.nights = 50; const got = v.checkAchievements(true); return { got: got.map((g) => `${g.a.id} ${g.tier}`), s: v.profile.silver - s0, tier: v.profile.ach.nights }; });
    ok(ach.tier === 2 && ach.s >= 170, `50 nights reach Night Owl II, and its tiers pay their silver (${JSON.stringify(ach)})`);
    const bp = await P.evaluate(() => {
      const v = window.__vz, c0 = v.profile.coffins; v.addPassXp(700 * 6);
      const tier = v.passTier(), waiting = v.passWaiting().length;
      v.openPanel('pass'); document.querySelector('#pass [data-act="claimall"]').click();
      return { tier, waiting, cof: v.profile.coffins - c0, left: v.passWaiting().length, plus: !!document.querySelector('#pass [data-act="plus"]') };
    });
    ok(bp.tier === 6 && bp.waiting === 6 && bp.cof === 1 && bp.left === 0 && bp.plus, `4,200 XP is tier 6 of the Blood Pass (700 a tier); Claim takes all six (tier 6 is a coffin) (${JSON.stringify(bp)})`);
    await P.click('#pass [data-act="plus"]'); await P.waitForTimeout(600);
    const plus = await P.evaluate(() => {
      const v = window.__vz, m = new Date().getUTCMonth(), waiting = v.passWaiting().filter(([, p]) => p).length;
      document.querySelector('#pass [data-act="claimall"]')?.click();
      return { has: v.hasPlus(), waiting, cape: v.profile.owned.includes('cape:s' + m), btn: !!document.querySelector('#pass [data-act="plus"]') };
    });
    ok(plus.has && plus.waiting === 6 && plus.cape && !plus.btn, `Blood Pass+ (for credits, through Orb's sheet) opens the plus track: its tiers are waiting, the season's cape is tier 1 (${JSON.stringify(plus)})`);
    const cof = await P.evaluate(() => {
      const v = window.__vz; v.profile.coffins = 10; v.profile.pity = 0; const o0 = v.profile.owned.length, got = [];
      for (let i = 0; i < 10; i++) got.push(v.openCoffin());
      return { rar: got.map((g) => g.rar[0]).join(''), best: got.some((g) => g.rar === 'epic' || g.rar === 'legendary'), fresh: v.profile.owned.length - o0, dupes: got.filter((g) => g.dupe).length, left: v.profile.coffins };
    });
    ok(cof.best && cof.fresh + cof.dupes === 10 && cof.left === 0, `ten coffins hold at least one epic or legendary, and each is a new look or silver (${JSON.stringify(cof)})`);
    await P.evaluate(() => { window.__vz.profile.coffins = 1; window.__vz.openPanel('coffins'); });
    await P.click('#coffins [data-act="open"]');
    await P.waitForFunction(() => document.getElementById('coffinCard').classList.contains('on'), null, { timeout: 10000 });
    const card = await P.evaluate(() => document.getElementById('coffinCard').innerText);
    await P.click('#coffinDone'); await P.waitForTimeout(300);
    ok(card.length > 5 && await P.evaluate(() => !document.getElementById('wardrobe').classList.contains('hidden') || document.getElementById('coffinDone').textContent === 'Done'), `opening a coffin at the Undertaker's shows what was in it (“${card.replace(/\n/g, ' · ')}”)`);
    await P.evaluate(() => window.__vz.closePanels());

    // a look for credits, and wearing it
    await P.evaluate(() => window.__vz.openWardrobe('cape', 'nebula')); await P.waitForTimeout(200);
    await P.click('#wdInfo [data-act="credits"]'); await P.waitForTimeout(600);
    ok(await P.evaluate(() => { const v = window.__vz; return v.shopOwned.has('cape-nebula') && v.myLooks().cape === 'nebula'; }), 'the Nebula cape, bought for credits in the Wardrobe, is worn at once');
    const dolls = await P.evaluate(() => [document.getElementById('dollSCap').textContent, document.getElementById('dollVCap').textContent]);
    await P.evaluate(() => window.__vz.closePanels());
    const capeOn = (who) => P.evaluate((who) => {
      const v = window.__vz, capeOf = (e) => (e.model?.cape ? Object.keys(v.CAPE_GEOS).find((k) => v.CAPE_GEOS[k] === e.model.cape.geometry) : '');
      return who === 'keepers' ? v.lobby.keepers.filter((k) => k.model.cape).map((k) => `${k.keeper.id}:${capeOf(k)}`).join() : `${v.lobby.me.team}:${capeOf(v.lobby.me)}`;
    }, who);
    const worn = [await capeOn('me')];
    await P.keyboard.press('KeyF'); await P.waitForTimeout(150); worn.push(await capeOn('me'));
    await P.keyboard.press('KeyF'); await P.waitForTimeout(150); worn.push(await capeOn('me'));
    ok(worn.join() === 'S:nebula,V:nebula,S:nebula' && dolls.join() === 'In Ravencross,Vampire, back', `and it's on your back in Ravencross, as a survivor and on your vampire side (F), as the Wardrobe's dolls show (${worn.join(', ')} · ${dolls.join(' / ')})`);
    ok(await capeOn('keepers') === 'pass:royal', `the keepers wear no capes but the Countess, a vampire (${await capeOn('keepers')})`);

    // the Blood Pass a year on: the same month's season, its cape and title yours already, pays silver for them instead
    const again = await P.evaluate(() => {
      const v = window.__vz, year = () => Object.assign(v.pass(), { xp: 700 * 15, free: [], plus: [] });
      year(); const title = v.claimPass(15, false)?.look?.[1];
      year(); v.openPanel('pass');
      const shown = [...document.querySelectorAll('#pass .prew')].filter((c) => c.textContent.includes('yours already')).length;
      const s0 = v.profile.silver, o0 = v.profile.owned.length, cape = v.claimPass(1, true), t15 = v.claimPass(15, false);
      v.closePanels();
      return { title, cape, t15, silver: v.profile.silver - s0, owned: v.profile.owned.length - o0, shown };
    });
    ok(again.title && again.cape?.s === 500 && again.t15?.s === 250 && again.silver === 750 && !again.owned && again.shown === 2, `a season comes back with its month: a year on, its cape and title (yours already) pay 500 and 250 silver instead, as an epic and a rare from a coffin would, and the pass shows it (${JSON.stringify(again)})`);
    // the Lantern Run: every jump can be made (the game's own physics, sprinting), then its finish, a best time, the board
    const climb = await P.evaluate(() => {
      const v = window.__vz, p = v.lobby.me, C = v.CONFIG, pts = [[v.LOBBY.start[0], v.LOBBY.start[1], 0], ...v.LOBBY.course], miss = [];
      const keep = { x: p.x, y: p.y, z: p.z };
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]], r = v.LOBBY.pads.has(i) ? 1.6 : 0.8, d = Math.hypot(b[0] - a[0], b[1] - a[1]), wx = (b[0] - a[0]) / d, wz = (b[1] - a[1]) / d;
        let landed = false;
        for (const jumpAt of [0, 0.1, 0.2, 0.3]) {
          Object.assign(p, { x: a[0] + 0.5, z: a[1] + 0.5, y: 10 + a[2], vx: 0, vy: 0, vz: 0, onGround: true }); p.ry = p.y;
          let jumped = false, air = false;
          for (let k = 0; k < 300; k++) {
            const prog = (p.x - a[0] - 0.5) * wx + (p.z - a[1] - 0.5) * wz, jump = !jumped && p.onGround && prog > jumpAt;
            if (jump) jumped = true;
            v.physics(p, 1 / 60, wx, wz, C.player.sprint, jump, C.player.jump);
            if (!p.onGround) air = true;
            if (jumped && air && p.onGround) break;
          }
          if (Math.abs(p.y - (10 + b[2])) < 0.3 && Math.abs(p.x - b[0] - 0.5) < r && Math.abs(p.z - b[1] - 0.5) < r) { landed = true; break; }
        }
        if (!landed) miss.push(i);
      }
      Object.assign(p, keep, { vx: 0, vy: 0, vz: 0 });
      return { jumps: pts.length - 1, miss };
    });
    ok(!climb.miss.length, `the Lantern Run can be climbed: each of its ${climb.jumps} jumps lands, sprinting${climb.miss.length ? ' — not jump ' + climb.miss.join(', ') : ''}`);
    await P.evaluate(() => {
      const v = window.__vz, p = v.lobby.me, end = v.LOBBY.course[v.LOBBY.course.length - 1];
      Object.assign(v.lobby.pk, { on: true, cp: v.LOBBY.cps.length, t0: (v.game.titleTime || 0) - 27.5, up: true });
      Object.assign(p, { x: end[0] + 0.5, z: end[1] + 0.5, y: 10 + end[2], vx: 0, vy: 0, vz: 0, onGround: true });
    });
    await P.waitForFunction(() => window.__vz.profile.run.best > 0, null, { timeout: 10000 });
    await P.waitForTimeout(800);
    const r = await P.evaluate(() => { const v = window.__vz; return { best: v.profile.run.best, board: v.boards.run?.map((x) => `${x.n} ${x.v}`), tier: v.profile.ach.run }; });
    ok(Math.abs(r.best - 27500) < 600 && r.board?.length === 1 && r.tier >= 3, `reaching the lookout from the last checkpoint finishes the Lantern Run: a best time, on the board, and the Lantern Runner tiers (${JSON.stringify(r)})`);

    // the week's special night: in the draw this week (and no other special), and each of them plays
    const draw = await P.evaluate(() => {
      const v = window.__vz, sp = v.specialNight(), seen = new Set();
      for (let i = 0; i < 400; i++) { v.game.lastNight = ''; seen.add(v.pickNight()); }
      return { sp: sp.id, seen: [...seen], others: v.NIGHTS.filter((n) => n.special && n !== sp).map((n) => n.id) };
    });
    ok(draw.seen.includes(draw.sp) && !draw.others.some((id) => draw.seen.includes(id)), `this week's special night (${draw.sp}) joins the draw, and the other specials wait their weeks (${draw.seen.join(', ')})`);
    const specials = [];
    for (const id of ['hunters', 'treasure', 'giants', 'elders']) {
      await P.evaluate((id) => { const v = window.__vz; v.night = id; v.start(true); }, id);
      await P.waitForFunction(() => window.__vz.game.state === 'play' && window.__vz.player, null, { timeout: 30000 });
      await P.evaluate(() => { const v = window.__vz; v.player.prot = 9999; v.speed = 3; v.norender = true; if (v.night === 'elders') { v.skip(v.game.nightLen * 0.26); v.dir.tickT = 0; } if (v.night === 'giants') for (let i = 0; i < 10; i++) v.spawnZombie(); });
      await P.waitForTimeout(2500);
      specials.push(await P.evaluate(() => {
        const v = window.__vz, id = v.game.night.id, Z = v.ents.filter((e) => e.team === 'Z');
        const okNow = id === 'hunters' ? v.player.bow && v.player.arrows >= 12 && v.ents.filter((e) => e.isBot && e.team === 'S').every((b) => b.bow)
          : id === 'treasure' ? v.loot().length > 5 : id === 'giants' ? Z.some((z) => z.armored) : v.dir.elder && v.ents.some((e) => e.elder);
        return `${id}:${okNow ? 'ok' : 'no'}`;
      }));
      await P.evaluate(() => { const v = window.__vz; v.night = null; v.speed = 1; v.norender = false; v.toTitle(); });
      await P.waitForFunction(() => window.__vz.lobby.me && window.__vz.MAP.id === 'lobby', null, { timeout: 30000 });
    }
    ok(specials.every((s) => s.endsWith(':ok')), `each special night plays as it says: a bow for every survivor, ten loot chests, the dead in iron, the Elder at midnight (${specials.join(', ')})`);

    // a night: the Night Gate, to dawn, the end screen, and back to Ravencross
    await P.evaluate(() => { const v = window.__vz, p = v.lobby.me; Object.assign(p, { x: 56.5, z: 34.4, y: 10, vx: 0, vz: 0 }); v.cam.yaw = 0; });
    await P.keyboard.down('KeyW');
    await P.waitForFunction(() => window.__vz.game.state === 'play', null, { timeout: 30000 }).catch(() => {});
    await P.keyboard.up('KeyW');
    const gate = await P.evaluate(() => ({ state: window.__vz.game.state, map: window.__vz.MAP.id, lobby: document.body.classList.contains('inlobby') }));
    ok(gate.state === 'play' && gate.map !== 'lobby' && !gate.lobby, `walking through the Night Gate starts a night (${JSON.stringify(gate)})`);
    await P.evaluate(() => { const v = window.__vz; v.player.prot = 9999; v.profile.xp = Math.max(v.profile.xp, 4000); v.profile.loadout.kill = 'sparks'; v.player.cos = v.myLooks(); });
    const fx = await P.evaluate(() => {
      const v = window.__vz, z = v.ents.find((e) => e.team === 'Z' && !e.dead) || v.spawn({ team: 'Z', x: v.player.x + 2, z: v.player.z });
      let n = 0; const real = v.KILL_FX.sparks; v.KILL_FX.sparks = (...a) => { n++; real(...a); };
      v.hurt(z, 999, v.player); v.KILL_FX.sparks = real;
      return { n, zombies: v.game.stats.zombies };
    });
    ok(fx.n === 1 && fx.zombies >= 1, `your kill effect (Sparks) goes off on what you strike down (${JSON.stringify(fx)})`);
    const before = await P.evaluate(() => { const v = window.__vz; return { nights: v.profile.stats.nights, pass: v.pass().xp, xp: v.profile.xp }; });
    await P.evaluate(() => { const v = window.__vz; v.player.prot = 9999; v.game.stats.zombies += 31; v.applyNight(v.specialNight().id); v.endGame('dawn'); });
    await P.waitForFunction(() => window.__vz.game.state === 'end', null, { timeout: 30000 });
    await P.waitForTimeout(1200);
    const end = await P.evaluate((b) => { const v = window.__vz, r = v.game.report; return { nights: v.profile.stats.nights - b.nights, pass: v.pass().xp - b.pass, xp: r.total, lines: r.lines.map((l) => l[0]), wk: v.profile.wk?.score > 0, xpbox: document.getElementById('endXp').innerText.includes('Blood Pass') }; }, before);
    ok(end.nights === 1 && end.pass === end.xp && end.wk && end.xpbox && end.lines.includes('Saw the dawn') && end.lines.some((l) => l.endsWith('this week’s special')), `dawn pays the night (the week's special a quarter more): its XP fills the Blood Pass too, and the week's score goes up (${JSON.stringify(end)})`);
    await P.click('#toMenu');
    await P.waitForFunction(() => window.__vz.lobby.me && window.__vz.MAP.id === 'lobby' && window.__vz.game.state === 'title', null, { timeout: 30000 });
    await P.waitForTimeout(1500);
    const back = await P.evaluate(() => { const v = window.__vz; return { statues: v.fame.statues.map((e) => e.name), week: v.boards.week?.map((r) => `${r.n} ${r.v}`), here: document.body.classList.contains('inlobby') }; });
    ok(back.here && back.statues.includes('Ana') && back.week?.length >= 1, `Menu takes you back to Ravencross, where this week's best stand in the Hall of Fame (${JSON.stringify(back)})`);
    ok(!A.errors.length, `no errors${A.errors.length ? ':\n' + A.errors.slice(0, 6).join('\n') : ''}`);

    // --- two players: together in Ravencross, then in one night -------------------------------------------------------
    const B = await openPage(browser, 'Bo');
    for (const pg of [P, B.page]) await pg.evaluate(() => { const v = window.__vz; v.LNET.joinT = 10; });
    await Promise.all([P, B.page].map((pg) => pg.waitForFunction(() => window.__vz.LNET.humans.size === 1, null, { timeout: 30000 }).catch(() => {})));
    const seen = await Promise.all([P, B.page].map((pg) => pg.evaluate(() => { const v = window.__vz; return { room: v.LNET.name, others: [...v.LNET.humans.values()].map((e) => e.name), chip: document.getElementById('lHere').textContent }; })));
    ok(seen[0].others.includes('Bo') && seen[1].others.includes('Ana') && seen[0].room === seen[1].room, `two players in Ravencross see each other there (${JSON.stringify(seen)})`);
    const anaCape = await B.page.evaluate(() => { const v = window.__vz, a = [...v.LNET.humans.values()].find((e) => e.name === 'Ana'); return a?.model?.cape ? `${a.team}:${Object.keys(v.CAPE_GEOS).find((k) => v.CAPE_GEOS[k] === a.model.cape.geometry)}` : 'none'; });
    ok(anaCape === 'S:nebula', `Bo sees Ana in her Nebula cape (${anaCape})`);
    await P.evaluate(() => { const v = window.__vz; v.lobby.me.x += 1.5; });
    await P.keyboard.press('Digit1');
    await P.evaluate(() => { document.getElementById('lEmote').click(); document.querySelector('#emoteMenu [data-ch="0"]').click(); });
    await B.page.waitForFunction(() => { const v = window.__vz, a = [...v.LNET.humans.values()][0]; return a?.emote && document.querySelector('#pops .bubble'); }, null, { timeout: 15000 }).catch(() => {});
    const em = await B.page.evaluate(() => { const v = window.__vz, a = [...v.LNET.humans.values()][0]; return { emote: a?.emote?.id, bubble: document.querySelector('#pops .bubble')?.textContent }; });
    ok(em.emote === 'wave' && em.bubble === 'Hi!', `an emote and a quick-chat line show on the other's screen (${JSON.stringify(em)})`);
    if (!quick) {
      await P.evaluate(() => window.__vz.start());
      await P.waitForFunction(() => window.__vz.game.state === 'play' && window.__vz.net.host, null, { timeout: 30000 });
      await P.waitForTimeout(2500);
      ok(await P.evaluate(() => !window.__vz.LNET.room), 'a night started leaves the lobby room');
      await B.page.evaluate(() => window.__vz.start());
      await B.page.waitForFunction(() => window.__vz.game.state === 'play', null, { timeout: 40000 }).catch(() => {});
      await B.page.waitForTimeout(2500);
      const together = await Promise.all([P, B.page].map((pg) => pg.evaluate(() => { const v = window.__vz; return { state: v.game.state, map: v.MAP.id, match: v.net.match?.id, host: v.net.host, humans: [...v.net.humans.values()].map((e) => e.name) }; })));
      ok(together[0].match && together[0].match === together[1].match && together[1].humans.includes('Ana') && together[0].humans.includes('Bo'), `then Bo's Play finds Ana's night, and they play it together (${JSON.stringify(together)})`);
      await B.page.evaluate(() => { window.__kfx = 0; const v = window.__vz, real = v.KILL_FX.sparks; v.KILL_FX.sparks = (...a) => { window.__kfx++; real(...a); }; });
      await P.evaluate(() => { const v = window.__vz, z = v.spawn({ team: 'Z', x: v.player.x + 2, z: v.player.z }); v.hurt(z, 999, v.player); });
      await B.page.waitForFunction(() => window.__kfx > 0, null, { timeout: 10000 }).catch(() => {});
      ok(await B.page.evaluate(() => window.__kfx > 0), 'Ana\'s kill effect goes off on Bo\'s screen too');
    }
    ok(!B.errors.length && !A.errors.length, `no errors with two players${[...A.errors, ...B.errors].length ? ':\n' + [...A.errors, ...B.errors].slice(0, 6).join('\n') : ''}`);
    await P.context().close(); await B.page.context().close();
  }

  // --- a phone, by touch: Ravencross and a night ------------------------------------------------------------------------
  const Ph = await openPage(browser, 'phone', device(390, 844));
  const P = Ph.page, f = await fingers(P);
  await f.tap([195, 420]);                                       // a first touch: the game knows it's a phone now
  let bad = await auditControls(P, LOBBY_CONTROLS);
  ok(!bad.length, `Ravencross fits a phone held upright, and each of its buttons takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  const z0 = await P.evaluate(() => window.__vz.lobby.me.z);
  await f.drag([90, 640], [90, 540], 300, 2500);
  ok(await P.evaluate((z0) => window.__vz.lobby.me.z < z0 - 0.5, z0), 'the left thumb walks');
  await standBy(P, 'wardrobe');
  ok(await P.evaluate(() => document.getElementById('tUse').classList.contains('on') && document.getElementById('tUse').textContent === 'TALK'), 'beside a keeper, TALK shows');
  await f.tap('#tUse');
  ok(await openPanelId(P) === 'wardrobe', 'TALK by the Tailor opens the Wardrobe');
  bad = await auditPanels(P);
  ok(!bad.length, `every panel fits the phone and its buttons take a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await P.evaluate(() => { const v = window.__vz; v.lobby.me.z += 2.5; v.cam.yaw = 0; v.cam.pitch = -0.15; });
  await P.waitForTimeout(700);
  await f.tap(await keeperOnScreen(P, 'wardrobe'));
  ok(await openPanelId(P) === 'wardrobe', 'a tap on a keeper talks to them');
  await P.evaluate(() => window.__vz.closePanels());
  await f.tap('#tBat');
  ok(await P.evaluate(() => window.__vz.lobby.vamp && window.__vz.lobby.me.team === 'V'), 'FANGS shows your vampire side');
  await f.tap('#lEmote'); await f.tap('#emoteMenu [data-em="wave"]');
  ok(await P.evaluate(() => window.__vz.lobby.me.emote?.id === 'wave'), 'the emote button waves');
  await f.tap('#play');
  await P.waitForFunction(() => window.__vz.game.state === 'play', null, { timeout: 30000 });
  await P.waitForTimeout(1200);
  bad = await auditControls(P, NIGHT_CONTROLS);
  ok(!bad.length, `Play by a tap starts a night, and its controls fit the phone${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await P.evaluate(() => { const v = window.__vz; v.player.prot = 9999; v.endGame('dawn'); });
  await P.waitForFunction(() => window.__vz.game.state === 'end', null, { timeout: 30000 });
  await P.waitForTimeout(800);
  bad = await auditControls(P, [['#again', '#toMenu', '#endWardrobe']]);
  const inSight = await P.$eval('#toMenu', (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  ok(!bad.length && inSight, `the end screen's buttons are in sight and take a tap${bad.length ? ' — ' + bad.join(', ') : ''}${inSight ? '' : ' — Menu is scrolled out of sight'}`);
  await f.tap('#toMenu');
  await P.waitForFunction(() => window.__vz.lobby.me && window.__vz.MAP.id === 'lobby', null, { timeout: 30000 });
  ok(true, 'Menu takes the phone back to Ravencross');
  ok(!Ph.errors.length, `no errors on the phone${Ph.errors.length ? ':\n' + Ph.errors.slice(0, 6).join('\n') : ''}`);
  await P.context().close();

  // --- every screen size: Ravencross, its panels, and a night ----------------------------------------------------------
  const sizes = [['iPhone SE', device(375, 667)], ['small Android', device(360, 740, ANDROID)], ['Pixel 7', device(412, 915, ANDROID)], ['iPhone SE sideways', device(667, 375)],
    ['iPhone 14 sideways', device(844, 390)], ['Pixel 7 sideways', device(915, 412, ANDROID)], ['iPad', device(820, 1180)], ['iPad sideways', device(1180, 820)]];
  for (const [name, d] of sizes) {
    const { page: S, errors: se } = await openPage(browser, 'size', d);
    const sf = await fingers(S); await sf.tap([d.viewport.width / 2, d.viewport.height * 0.45]);
    const problems = [...(await auditControls(S, LOBBY_CONTROLS)).map((x) => 'lobby: ' + x), ...(await auditPanels(S))];
    await S.evaluate(() => window.__vz.start(true));
    await S.waitForFunction(() => window.__vz.game.state === 'play', null, { timeout: 30000 });
    await S.evaluate(() => { const v = window.__vz; v.player.items.apple = 2; v.player.items.holy = 1; v.player.bow = true; v.player.arrows = 5; });
    await S.waitForTimeout(1000);
    problems.push(...(await auditControls(S, NIGHT_CONTROLS)).map((x) => 'night: ' + x));
    ok(!problems.length && !se.length, `${name} (${d.viewport.width}×${d.viewport.height}): everything fits and takes a tap${problems.length ? ' — ' + problems.join(', ') : ''}${se.length ? '\n' + se.slice(0, 3).join('\n') : ''}`);
    await S.context().close();
  }

  // --- Safari's engine (WebKit), if it's installed here ----------------------------------------------------------------
  const wk = await webkit.launch().catch(() => null);
  if (!wk) console.log('– WebKit isn’t installed here (npx playwright install webkit): skipped Safari’s engine');
  else {
    const W = await (await wk.newContext({ ...devices['iPhone 14'] })).newPage();
    await routeCdn(W);
    const we = [];
    W.on('pageerror', (e) => we.push(e.message));
    await W.goto(URL + '&nodaily');
    await W.waitForFunction(() => window.__vz?.lobby?.me && document.getElementById('loading').classList.contains('out'), null, { timeout: 120000 });
    await orbDock(W);
    await W.tap('canvas', { position: { x: 200, y: 400 } });
    const lb = await auditControls(W, LOBBY_CONTROLS);
    await W.tap('#play');
    await W.waitForFunction(() => window.__vz.game.state === 'play', null, { timeout: 60000 });
    await W.waitForTimeout(1500);
    const wbad = [...lb.map((x) => 'lobby: ' + x), ...(await auditControls(W, NIGHT_CONTROLS)).map((x) => 'night: ' + x)];
    ok(!wbad.length && !we.length, `in WebKit on an iPhone: Ravencross and a night by taps, and every control fits${wbad.length ? ' — ' + wbad.join(', ') : ''}${we.length ? '\n' + we.slice(0, 3).join('\n') : ''}`);
    await wk.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
