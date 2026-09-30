/* ===========================================================================
   모의 전자입찰 실습 시스템
   ---------------------------------------------------------------------------
   구성
     1) 상수 · 도메인 설정
     2) 동기화 어댑터 (FirebaseSync / LocalSync) — 같은 인터페이스
     3) 산정 로직 (순수 함수) + __selfTest()
     4) 화면 상태 · 렌더링
   =========================================================================== */

import * as cfg from './firebase-config.js';
const firebaseConfig = cfg.firebaseConfig;
const hostPinHash    = cfg.hostPinHash || '';   // 예전 설정 파일에 없어도 동작하도록

/* ── 1. 상수 ─────────────────────────────────────────────────────────────── */

const MAX_PARTICIPANTS = 20;   // 동시 참가 정원
const CAND_COUNT       = 15;   // 복수예비가격 개수
const PICK_COUNT       = 2;    // 참가인 1명이 고르는 번호 수
const TOP_COUNT        = 4;    // 예정가격 산정에 쓰는 상위 득표 번호 수
const SPREAD           = 0.03; // 기초금액 대비 ±3 %
const CODE_CHARS       = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0·O·1·I 제외

const CATEGORIES = {
  goods:   { label: '물품', rate: 90     },
  service: { label: '용역', rate: 90     },
  works:   { label: '공사', rate: 89.745 },
};

const METHODS = {
  private: { label: '수의계약', enabled: true  },
  open:    { label: '일반경쟁', enabled: false },
  limited: { label: '제한경쟁', enabled: false },
  named:   { label: '지명경쟁', enabled: false },
};

const STEP_OF = { created: 2, bidding: 3, closed: 4, decrypted: 5, opened: 6 };

// 연출 시간(ms). 모든 기기가 서버 시각 기준으로 같은 장면을 본다.
const INTRO_MS     = 7500;  // 기초금액 발표 4.5초 + 3·2·1 3초 → 이후 제한시간이 흐른다
const CLOSE_MSG_MS = 2500;  // '입찰이 마감되었습니다' 표시 후 '복호화 중'으로
const OPEN_MS      = 6500;  // 개찰 발표 전체 길이 → 이후 결과창

/* ── 2. 동기화 어댑터 ────────────────────────────────────────────────────── */

/** 브라우저 한 대 안에서만 동기화. Firebase 설정이 없을 때 자동 사용. */
class LocalSync {
  constructor() {
    this.mode = 'local';
    this.uid = null;          // 로컬 모드에는 인증이 없다
    this.key = 'bidsim_db';
    this.watchers = [];
  }
  async init() {
    try {
      this.ch = new BroadcastChannel('bidsim');
      this.ch.onmessage = () => this._fire();
    } catch { this.ch = null; }
    addEventListener('storage', e => { if (e.key === this.key) this._fire(); });
    return this;
  }
  now() { return Date.now(); }

  _read() { try { return JSON.parse(localStorage.getItem(this.key) || '{}'); } catch { return {}; } }
  _commit(db) {
    localStorage.setItem(this.key, JSON.stringify(db));
    if (this.ch) this.ch.postMessage(1);
    this._fire();
  }
  _at(db, path) {
    return path.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), db);
  }
  _put(db, path, value) {
    const keys = path.split('/').filter(Boolean);
    let o = db;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {};
      o = o[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === null) delete o[last]; else o[last] = value;
  }

  async get(path)         { const v = this._at(this._read(), path); return v === undefined ? null : v; }
  async set(path, value)  { const db = this._read(); this._put(db, path, value); this._commit(db); }
  async update(path, obj) {
    const db = this._read();
    for (const [k, v] of Object.entries(obj)) this._put(db, path + '/' + k, v);
    this._commit(db);
  }

  watch(path, cb) {
    const w = { path, cb, last: '\u0000' };
    this.watchers.push(w);
    const raw = this._at(this._read(), path);
    const v = raw === undefined ? null : raw;
    w.last = JSON.stringify(v);
    cb(v);
    return () => { this.watchers = this.watchers.filter(x => x !== w); };
  }
  /** 접속 표시. 로컬 모드는 탭을 닫을 때(pagehide) false 로 바꾼다. 대상 레코드가 없으면 만들지 않는다. */
  presence(path) {
    const parent = path.split('/').slice(0, -1).join('/');
    const put = v => { const db = this._read(); if (this._at(db, parent) != null) { this._put(db, path, v); this._commit(db); } };
    const off = () => put(false);
    const on  = () => put(true);
    addEventListener('pagehide', off);
    addEventListener('pageshow', on);
    on();
    return () => { removeEventListener('pagehide', off); removeEventListener('pageshow', on); off(); };
  }
  _fire() {
    const db = this._read();
    for (const w of this.watchers) {
      const raw = this._at(db, w.path);
      const v = raw === undefined ? null : raw;
      const j = JSON.stringify(v);
      if (j !== w.last) { w.last = j; w.cb(v); }
    }
  }
}

/** Firebase Realtime Database. 기기 간 실시간 동기화 + 서버 시각 보정. */
class FirebaseSync {
  constructor(cfg) { this.mode = 'online'; this.cfg = cfg; this.offset = 0; this.uid = null; }
  async init() {
    const [appMod, dbMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'),
    ]);
    this.app = appMod.initializeApp(this.cfg);
    // 익명 로그인 — 기기(브라우저)마다 고정된 uid 가 생긴다. 보안 규칙은 이 uid 로
    // "세션을 만든 기기만 진행 조작", "참가인은 자기 입찰서만 작성"을 구분한다.
    const cred = await authMod.signInAnonymously(authMod.getAuth(this.app));
    this.uid = cred.user.uid;
    this.db  = dbMod.getDatabase(this.app);
    this.fb  = dbMod;
    // 모든 기기의 타이머가 같이 흐르도록 서버와의 시계 차이를 구독한다.
    dbMod.onValue(dbMod.ref(this.db, '.info/serverTimeOffset'), s => { this.offset = s.val() || 0; });
    return this;
  }
  now() { return Date.now() + this.offset; }

  async get(path)         { const s = await this.fb.get(this.fb.ref(this.db, path)); return s.exists() ? s.val() : null; }
  async set(path, value)  { return this.fb.set(this.fb.ref(this.db, path), value); }
  async update(path, obj) { return this.fb.update(this.fb.ref(this.db, path), obj); }
  watch(path, cb)         { return this.fb.onValue(this.fb.ref(this.db, path), s => cb(s.exists() ? s.val() : null)); }

  /** 접속 표시. 연결될 때마다 true 로 쓰고, 탭을 닫거나 연결이 끊기면 서버가 false 로 바꾼다.
      레코드가 지워진 뒤에는 규칙(nickname 필수)이 쓰기를 막으므로 빈 레코드가 생기지 않는다. */
  presence(path) {
    const r = this.fb.ref(this.db, path);
    const off = this.fb.onValue(this.fb.ref(this.db, '.info/connected'), s => {
      if (s.val() !== true) return;
      this.fb.onDisconnect(r).set(false).then(() => this.fb.set(r, true)).catch(() => {});
    });
    return () => {
      off();
      this.fb.onDisconnect(r).cancel().catch(() => {});
      this.fb.set(r, false).catch(() => {});
    };
  }
}

/* ── 3. 산정 로직 (순수 함수) ────────────────────────────────────────────── */

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/** 기초금액 ±3 % 범위의 서로 다른 예비가격 15개. 번호 순서에 규칙이 없도록 섞는다. */
function generateCandidates(basePrice) {
  const lo = Math.floor(basePrice * (1 - SPREAD));
  const hi = Math.ceil(basePrice * (1 + SPREAD));
  const set = new Set();
  let guard = 0;
  while (set.size < CAND_COUNT && guard++ < 8000)  set.add(Math.floor(randInt(lo, hi) / 1000) * 1000);
  while (set.size < CAND_COUNT && guard++ < 30000) set.add(randInt(lo, hi)); // 금액이 아주 작을 때 대비
  const arr = [...set];
  for (let i = arr.length - 1; i > 0; i--) { const j = randInt(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/** 1~15번 득표수 집계. 참가인 1명이 2표를 행사한다. */
function tallyVotes(bids) {
  const c = {};
  for (let n = 1; n <= CAND_COUNT; n++) c[n] = 0;
  for (const b of Object.values(bids || {})) for (const n of (b.picks || [])) if (c[n] != null) c[n]++;
  return c;
}

/** 득표 많은 순 상위 4개. 동점이면 번호가 작은 쪽이 앞선다. */
function pickTopNumbers(votes) {
  return Object.keys(votes).map(Number)
    .sort((a, b) => votes[b] - votes[a] || a - b)
    .slice(0, TOP_COUNT)
    .sort((a, b) => a - b);
}

/** 상위 4개 번호에 걸린 금액의 산술평균 = 예정가격 (원 단위 절사) */
function computePredictedPrice(topNumbers, candidates) {
  const sum = topNumbers.reduce((s, n) => s + candidates[n - 1], 0);
  return Math.floor(sum / topNumbers.length);
}

/** 낙찰하한금액 = 예정가격 × 낙찰하한율 (원 단위 올림) */
function computeMinPrice(predicted, ratePercent) {
  return Math.ceil(predicted * ratePercent / 100);
}

/**
 * 순위 산정.
 *  · 낙찰하한금액 이상인 입찰만 유효
 *  · 유효 입찰 중 금액이 낮을수록(= 하한에 근접할수록) 상위
 *  · 금액이 같으면 같은 순위(동가) — 1순위 동가는 집행인이 동가 추첨으로 정한다
 *  · 하한 미달은 순위 밖
 */
function rankBids(participants, bids, minPrice) {
  const rows = Object.entries(participants || {}).map(([pid, p]) => {
    const b = (bids || {})[pid] || null;
    return {
      pid,
      nickname: p.nickname,
      amount:      b ? b.amount : null,
      picks:       b ? b.picks : null,
      submittedAt: b ? b.submittedAt : null,
    };
  });
  const sent   = rows.filter(r => r.amount != null);
  const valid  = sent.filter(r => r.amount >= minPrice);
  const under  = sent.filter(r => r.amount < minPrice).sort((a, b) => b.amount - a.amount);
  const absent = rows.filter(r => r.amount == null);
  assignRanks(valid, null);
  under.forEach(r => { r.rank = null; });
  return { valid, under, absent };
}

/**
 * 금액 오름차순으로 정렬하고 순위를 매긴다. 같은 금액은 같은 순위(동가).
 * drawnPid 가 있으면 그 사람을 동가 무리의 맨 앞에 두고 단독 순위를 준다(동가 추첨 결과).
 */
function assignRanks(valid, drawnPid) {
  valid.sort((a, b) => a.amount - b.amount
                    || (b.pid === drawnPid) - (a.pid === drawnPid)
                    || a.submittedAt - b.submittedAt);
  valid.forEach((r, i) => {
    const prev = valid[i - 1];
    r.rank = prev && prev.amount === r.amount && prev.pid !== drawnPid ? prev.rank : i + 1;
  });
  return valid;
}

/** 1순위 금액의 동가 입찰자 목록과 추첨 여부. */
function tieInfo(r) {
  const valid = (r && r.valid) || [];
  const top   = valid[0];
  const tied  = top ? valid.filter(x => x.amount === top.amount) : [];
  return { tied: tied.length >= 2 ? tied : [], drawn: !!(r && r.lottery) };
}

/** 동가 입찰자 중 1명을 무작위로 뽑아 1순위로 확정한다. */
async function drawLottery() {
  const r = state.result;
  const { tied, drawn } = tieInfo(r);
  if (!tied.length || drawn) return;
  const pick  = tied[crypto.getRandomValues(new Uint32Array(1))[0] % tied.length];
  const valid = assignRanks(r.valid.map(x => ({ ...x })), pick.pid);
  await sync.update('sessions/' + state.code + '/result', {
    valid,
    lottery: { pids: tied.map(x => x.pid), winner: pick.pid, at: sync.now() },
  });
}

/* 콘솔에서 __selfTest() 로 산정 로직을 검증할 수 있다. */
function __selfTest() {
  const out = [];
  const ok = (name, cond, got) => out.push({ 항목: name, 결과: cond ? 'PASS' : 'FAIL', 값: String(got) });

  // 예비가격 생성: 개수 · 중복 · 범위
  const cands = generateCandidates(100000000);
  ok('예비가격 15개', cands.length === 15, cands.length);
  ok('예비가격 중복 없음', new Set(cands).size === 15, new Set(cands).size);
  ok('예비가격 ±3% 이내',
     cands.every(v => v >= 97000000 - 1000 && v <= 103000000),
     Math.min(...cands).toLocaleString() + ' ~ ' + Math.max(...cands).toLocaleString());

  // 득표 집계와 동점 처리
  const bids = {
    a: { amount: 91000000, picks: [3, 7],  submittedAt: 100 },
    b: { amount: 90500000, picks: [3, 9],  submittedAt: 110 },
    c: { amount: 80000000, picks: [7, 12], submittedAt: 120 },
    d: { amount: 90500000, picks: [3, 15], submittedAt: 105 },
  };
  const votes = tallyVotes(bids);
  const total = Object.values(votes).reduce((s, v) => s + v, 0);
  ok('3번 3표', votes[3] === 3, votes[3]);
  ok('총 표수 = 인원 × 2', total === 8, total);

  // 3번 3표, 7번 2표, 나머지는 1표 → 동점이면 번호 작은 순으로 9, 12
  const top = pickTopNumbers(votes);
  ok('상위 4개 = [3,7,9,12] (동점 시 번호 오름차순)', JSON.stringify(top) === '[3,7,9,12]', JSON.stringify(top));

  // 예정가격 = 해당 4개 금액의 평균
  const fixed = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150].map(v => v * 1000000);
  const predicted = computePredictedPrice([3, 7, 9, 12], fixed); // (30+70+90+120)/4 = 77.5백만
  ok('예정가격 = 77,500,000', predicted === 77500000, predicted.toLocaleString());

  // 낙찰하한금액 (공사 89.745 %)
  const minP = computeMinPrice(100000000, 89.745);
  ok('하한금액 = 89,745,000', minP === 89745000, minP.toLocaleString());

  // 순위: 하한 90,000,000 기준
  const parts = { a: { nickname: '가' }, b: { nickname: '나' }, c: { nickname: '다' }, d: { nickname: '라' }, e: { nickname: '마' } };
  const r = rankBids(parts, bids, 90000000);
  ok('동가 1위 = 라·나 (같은 순위)', r.valid[0].rank === 1 && r.valid[1].rank === 1,
     r.valid.map(x => x.nickname + x.rank).join(' > '));
  ok('3위 = 가', r.valid[2].nickname === '가' && r.valid[2].rank === 3, r.valid[2].nickname + r.valid[2].rank);
  ok('동가 입찰자 2명', tieInfo(r).tied.length === 2, tieInfo(r).tied.length);
  const drawn = assignRanks(r.valid.map(x => ({ ...x })), 'b');
  ok('추첨 후 나=1위, 라=2위', drawn[0].nickname === '나' && drawn[0].rank === 1 && drawn[1].rank === 2,
     drawn.map(x => x.nickname + x.rank).join(' > '));
  ok('하한 미달 1명 (다)', r.under.length === 1 && r.under[0].nickname === '다', r.under.map(x => x.nickname).join(','));
  ok('미제출 1명 (마)', r.absent.length === 1 && r.absent[0].nickname === '마', r.absent.map(x => x.nickname).join(','));

  console.table(out);
  const failed = out.filter(o => o.결과 === 'FAIL').length;
  console.log(failed ? '%c' + failed + '건 실패' : '%c전체 통과',
              'color:' + (failed ? '#c9736f' : '#3f9e85') + ';font-weight:700');
  return failed === 0;
}
window.__selfTest = __selfTest;

/* ── 4. 앱 ───────────────────────────────────────────────────────────────── */

const $   = id => document.getElementById(id);
const won = n => (n == null ? '-' : Number(n).toLocaleString('ko-KR') + '원');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let sync = null;

const state = {
  role: null,          // 'host' | 'bidder'
  code: null,
  pid: null,
  meta: null,
  status: null,
  timer: null,
  closedAt: null,      // 입찰 마감 시각 — 마감 연출 기준
  participants: {},
  partsLoaded: false,  // 참가인 명단을 한 번이라도 받았는가 (명단에서 빠졌는지 판단용)
  presenceStop: null,  // 참가인 접속 표시 해제 함수
  bids: {},            // 집행인만 구독한다
  result: null,
  candidates: null,    // 집행인 기기에만 보관 — 서버로 올리지 않는다
  predicted: null,     // 복호화 후 개찰 전까지 집행인 기기에만
  unsubs: [],
  stage: 'amount',     // 참가인 입력 단계: 'amount' | 'picks'
  draftAmount: null,
  picks: [],
  closing: false,
};

/* 저장소 헬퍼 ------------------------------------------------------------- */
const store = {
  get(k, d = null) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};

/* 지금 이 탭이 어떤 역할인지는 탭마다 따로 기억한다.
   localStorage 는 탭끼리 공유되므로, 로컬 모드에서 한 PC의 여러 탭으로
   집행인·참가인을 동시에 띄울 때 역할이 서로 덮어써지는 것을 막는다. */
const tabStore = {
  get()  { try { return JSON.parse(sessionStorage.getItem('bidsim_tab')); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('bidsim_tab', JSON.stringify(v)); } catch {} },
  del()  { try { sessionStorage.removeItem('bidsim_tab'); } catch {} },
};

/* 화면 전환 --------------------------------------------------------------- */
const SCREENS = ['s-home', 's-create', 's-host', 's-join', 's-bidder'];
function show(id) {
  SCREENS.forEach(s => { $(s).hidden = (s !== id); });
  scrollTo(0, 0);
}

/* 세션 구독 --------------------------------------------------------------- */
function unsubAll() { state.unsubs.forEach(f => { try { f(); } catch {} }); state.unsubs = []; }

function subscribe(code, asHost) {
  unsubAll();
  state.partsLoaded = false;
  const base = 'sessions/' + code;
  const bind = (leaf, key) => state.unsubs.push(sync.watch(base + '/' + leaf, v => {
    state[key] = v;
    if (key === 'participants') {
      // 닉네임 없는 조각(지워진 참가인에 뒤늦게 붙은 접속 표시 등)은 명단에서 뺀다.
      state.participants = Object.fromEntries(Object.entries(v || {}).filter(([, p]) => p && p.nickname));
      state.partsLoaded = true;
    }
    if (key === 'bids' && v == null) state.bids = {};
    render();
  }));
  bind('meta', 'meta');
  bind('status', 'status');
  bind('timer', 'timer');
  bind('participants', 'participants');
  bind('result', 'result');
  bind('closedAt', 'closedAt');
  // 입찰서(bids)는 집행인만 읽는다. 참가인 화면은 남의 입찰을 받아오지 않는다.
  if (asHost) bind('bids', 'bids');
}

/* ── 홈 ──────────────────────────────────────────────────────────────────── */

/* 참가 링크(QR)로 들어왔거나 한 번이라도 참가인으로 들어간 탭은 "참가인 전용"으로 묶는다.
   이런 탭은 나가기·돌아가기를 눌러도 집행인 화면(PIN·세션 생성)으로 가지 않고 참가 화면에 머문다. */
const bidderOnlyFlag = {
  get() { try { return sessionStorage.getItem('bidsim_bidder_only') === '1'; } catch { return false; } },
  set() { try { sessionStorage.setItem('bidsim_bidder_only', '1'); } catch {} },
};

/* 집행인 PIN — firebase-config.js 의 hostPinHash(SHA-256) 와 비교한다. 통과하면 이 탭에서는 다시 묻지 않는다. */
const hostPinPassed = {
  get() { try { return sessionStorage.getItem('bidsim_pin_ok') === '1'; } catch { return false; } },
  set() { try { sessionStorage.setItem('bidsim_pin_ok', '1'); } catch {} },
};

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
window.__pinHash = async pin => console.log(await sha256Hex(String(pin)));   // 콘솔에서 PIN 해시 만들기

function enterBidderOnly() {
  state.bidderOnly = true;
  bidderOnlyFlag.set();
  $('btn-join-back').hidden = true;
}

/* 참가인 접속 표시(participants/<pid>/online) — 집행인 명단의 입장·퇴장 표시에 쓰인다. */
function startPresence() {
  stopPresence();
  if (sync.presence) state.presenceStop = sync.presence('sessions/' + state.code + '/participants/' + state.pid + '/online');
}
function stopPresence() {
  if (state.presenceStop) { try { state.presenceStop(); } catch {} }
  state.presenceStop = null;
}

/* 참가인 '실습 나가기'. 입찰 시작 전이면 명단에서 완전히 빠지고(자리 반납),
   시작 후에는 개찰 결과에 남아야 하므로 퇴장 표시만 한다. */
async function leaveAsBidder() {
  const code = state.code, pid = state.pid, st = state.status || 'created';
  stopPresence();
  if (st === 'created' && code && pid) {
    try { await sync.set('sessions/' + code + '/participants/' + pid, null); } catch (e) { console.error(e); }
    store.del('bidsim_me_' + code);
  }
  goHome();
}

function goHome(joinMsg) {
  unsubAll();
  stopPresence();
  if (state.role === 'host') store.del('bidsim_host_last');
  tabStore.del();
  const lastCode = state.code;
  state.role = null; state.code = null; state.pid = null;
  state.meta = state.status = state.timer = state.result = state.closedAt = null;
  state.participants = {}; state.bids = {}; state.partsLoaded = false;
  state.candidates = null; state.predicted = null;
  state.stage = 'amount'; state.draftAmount = null; state.picks = [];
  renderStage();
  if (state.bidderOnly) {
    if (lastCode) $('j-code').value = lastCode;
    $('join-err').textContent = joinMsg || '';
    show('s-join');
    return;
  }
  openHostEntry();
}

/* 주소로 바로 들어온 탭은 역할 선택 없이 집행인 입구로 간다.
   PIN이 설정돼 있고 이 탭에서 아직 통과하지 않았으면 PIN 화면, 아니면 곧바로 세션 생성 화면. */
function openCreate() {
  $('create-err').textContent = '';
  show('s-create');
  $('f-title').focus();
}

function openHostEntry() {
  if (!hostPinHash || hostPinPassed.get()) { openCreate(); return; }
  $('pin-err').textContent = ''; $('pin-input').value = '';
  show('s-home');
  $('pin-input').focus();
}

/* QR 없이 주소로 들어온 참가인용 — 참가인 전용으로 묶지 않으므로 '돌아가기'로 집행인 입구에 돌아올 수 있다. */
function openJoin() {
  $('join-err').textContent = '';
  show('s-join');
  $('j-nick').focus();
}

/* ── 집행인: 세션 생성 ───────────────────────────────────────────────────── */

function newCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[randInt(0, CODE_CHARS.length - 1)];
  return s;
}

function syncRateWithCategory() {
  const cat = CATEGORIES[$('f-category').value];
  if (cat) $('f-rate').value = cat.rate;
}

async function createSession() {
  const err = $('create-err');
  err.textContent = '';
  const title     = $('f-title').value.trim();
  const category  = $('f-category').value;
  const method    = $('f-method').value;
  const basePrice = Number(($('f-base').value || '').replace(/[^\d]/g, ''));
  const lowerRate = Number($('f-rate').value);
  const duration  = Number($('f-duration').value);

  if (!title)                               { err.textContent = '입찰명을 입력하세요.'; return; }
  if (!basePrice || basePrice < 1000)       { err.textContent = '기초금액을 1,000원 이상으로 입력하세요.'; return; }
  if (!(lowerRate > 0 && lowerRate <= 100)) { err.textContent = '낙찰하한율은 0 초과 100 이하로 입력하세요.'; return; }
  if (!(duration >= 10 && duration <= 600)) { err.textContent = '입찰 제한시간은 10~600초 사이로 입력하세요.'; return; }

  $('btn-create').disabled = true;
  try {
    let code = newCode();
    for (let i = 0; i < 8 && await sync.get('sessions/' + code + '/meta'); i++) code = newCode();

    const meta = { title, category, method, basePrice, lowerRate, durationMs: duration * 1000, createdAt: sync.now() };
    if (sync.uid) meta.hostUid = sync.uid;
    await sync.set('sessions/' + code, {
      meta,
      status: 'created',
    });

    state.role = 'host'; state.code = code;
    state.candidates = null; state.predicted = null;
    store.del(hostKey(code));
    tabStore.set({ role: 'host', code });
    store.set('bidsim_host_last', { code });   // 탭을 닫았다가 다시 열었을 때 복귀용
    subscribe(code, true);
    show('s-host');
    renderQR(code);
  } catch (e) {
    err.textContent = '세션 생성에 실패했습니다: ' + (e && e.message ? e.message : e);
  } finally {
    $('btn-create').disabled = false;
  }
}

function joinLink(code) {
  return location.origin + location.pathname + '?s=' + code;
}

function renderQR(code) {
  const box = $('qr');
  box.innerHTML = '';
  if (typeof QRCode === 'undefined') { box.textContent = 'QR 생성 실패'; return; }
  new QRCode(box, {
    text: joinLink(code), width: 168, height: 168,
    colorDark: '#1E3048', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.M,
  });
}

/* ── 집행인: 단계 진행 ───────────────────────────────────────────────────── */

const hostKey = code => 'bidsim_host_' + code;

async function startBidding() {
  if (!Object.keys(state.participants || {}).length) {
    if (!confirm('참가인이 한 명도 없습니다. 그래도 입찰을 시작할까요?')) return;
  }
  const cands = generateCandidates(state.meta.basePrice);
  state.candidates = cands;
  state.predicted = null;
  store.set(hostKey(state.code), { candidates: cands });   // 새로고침 대비 (이 기기 안에만)

  // 제한시간은 기초금액 발표와 3·2·1 카운트가 끝난 뒤부터 흐른다.
  const patch = { bids: null, result: null, closedAt: null, status: 'bidding',
                  timer: { startedAt: sync.now() + INTRO_MS, durationMs: state.meta.durationMs || 60000 } };
  for (const pid of Object.keys(state.participants || {})) patch['participants/' + pid + '/submitted'] = false;
  await sync.update('sessions/' + state.code, patch);
}

async function closeBidding() {
  if (state.closing || state.status !== 'bidding') return;
  state.closing = true;
  try { await sync.update('sessions/' + state.code, { status: 'closed', closedAt: sync.now() }); }
  catch (e) { console.error(e); }
  finally { state.closing = false; }
}

async function decryptBids() {
  const saved = store.get(hostKey(state.code)) || {};
  const cands = state.candidates || saved.candidates;
  if (!cands) { alert('예비가격 정보를 찾을 수 없습니다. 입찰을 다시 시작해 주세요.'); return; }
  state.candidates = cands;

  const bids = state.bids || {};
  if (!Object.keys(bids).length) { alert('제출된 입찰서가 없습니다.'); return; }

  const votes          = tallyVotes(bids);
  const topNumbers     = pickTopNumbers(votes);
  const predictedPrice = computePredictedPrice(topNumbers, cands);
  const minPrice       = computeMinPrice(predictedPrice, state.meta.lowerRate);

  state.predicted = { votes, topNumbers, predictedPrice, minPrice };
  store.set(hostKey(state.code), { candidates: cands, predicted: state.predicted });

  // 금액은 아직 공개하지 않는다. 상태만 넘긴다.
  await sync.set('sessions/' + state.code + '/status', 'decrypted');
}

async function openBids() {
  const saved = store.get(hostKey(state.code)) || {};
  const p     = state.predicted  || saved.predicted;
  const cands = state.candidates || saved.candidates;
  if (!p || !cands) { alert('복호화 정보를 찾을 수 없습니다. 복호화를 다시 실행해 주세요.'); return; }

  const { valid, under, absent } = rankBids(state.participants, state.bids, p.minPrice);
  await sync.update('sessions/' + state.code, {
    result: {
      candidates: cands,
      voteCounts: p.votes,
      topNumbers: p.topNumbers,
      predictedPrice: p.predictedPrice,
      minPrice: p.minPrice,
      valid, under, absent,
      openedAt: sync.now(),
    },
    status: 'opened',
  });
}

/** 참가인 명단 새로고침. 서버에서 다시 받아오고, 입찰 시작 전이면 퇴장(연결 끊김)한 참가인을 명단에서 뺀다.
    빠진 참가인도 같은 링크로 다시 들어오면 새로 참가할 수 있다. */
async function refreshParticipants() {
  const b = $('btn-refresh-parts');
  b.disabled = true;
  try {
    const base  = 'sessions/' + state.code;
    const parts = (await sync.get(base + '/participants')) || {};
    const status = (await sync.get(base + '/status')) || 'created';
    const gone  = Object.keys(parts).filter(pid => !parts[pid] || !parts[pid].nickname || parts[pid].online === false);
    if (status === 'created' && gone.length) {
      const patch = {};
      for (const pid of gone) patch['participants/' + pid] = null;
      await sync.update(base, patch);
    }
    state.participants = Object.fromEntries(Object.entries((await sync.get(base + '/participants')) || {})
      .filter(([, p]) => p && p.nickname));
    render();
    b.textContent = status === 'created' && gone.length ? '퇴장 ' + gone.length + '명 정리' : '최신 상태';
  } catch (e) {
    console.error(e);
    b.textContent = '실패';
  } finally {
    setTimeout(() => { b.textContent = '새로고침'; b.disabled = false; }, 1500);
  }
}

async function rebid() {
  if (!confirm('같은 조건으로 다시 입찰합니다.\n입찰서와 개찰 결과가 지워지고 참가인은 그대로 유지됩니다.')) return;
  state.candidates = null; state.predicted = null;
  store.del(hostKey(state.code));
  const patch = { bids: null, result: null, timer: null, closedAt: null, status: 'created' };
  for (const pid of Object.keys(state.participants || {})) patch['participants/' + pid + '/submitted'] = false;
  await sync.update('sessions/' + state.code, patch);
}

/* ── 참가인 ──────────────────────────────────────────────────────────────── */

async function joinSession() {
  const err = $('join-err');
  err.textContent = '';
  const nickname = $('j-nick').value.trim();
  const code     = $('j-code').value.trim().toUpperCase();
  if (!nickname)            { err.textContent = '닉네임을 입력하세요.'; return; }
  if (nickname.length > 12) { err.textContent = '닉네임은 12자 이내로 입력하세요.'; return; }
  if (code.length !== 6)    { err.textContent = '세션코드 6자리를 입력하세요.'; return; }

  $('btn-join').disabled = true;
  try {
    const meta = await sync.get('sessions/' + code + '/meta');
    if (!meta) { err.textContent = '해당 세션코드를 찾을 수 없습니다. 코드를 다시 확인해 주세요.'; return; }
    if (!confirm('‘' + meta.title + '’ 입찰에\n‘' + nickname + '’(으)로 참가하시겠습니까?')) return;

    const saved = store.get('bidsim_me_' + code);
    const parts = (await sync.get('sessions/' + code + '/participants')) || {};

    // 같은 닉네임으로 다시 들어오면 이전 참가 자격을 그대로 이어받는다.
    // 닉네임이 다르면 별개의 참가인으로 본다(한 브라우저에서 여러 명을 띄우는 연습 포함).
    let pid = (saved && saved.nickname === nickname && parts[saved.pid]) ? saved.pid : null;

    // 기기를 바꿨거나 저장 기록이 지워졌어도 명단에 같은 이름이 있으면 그 자리로 복귀시킨다.
    // 그렇지 않으면 정원이 찬 세션에서 끊긴 참가인이 영영 못 들어온다.
    if (!pid) {
      const twin = Object.entries(parts).find(([, p]) => p.nickname === nickname);
      if (twin) {
        if (twin[1].submitted) { err.textContent = '이 닉네임은 이미 입찰서를 제출했습니다. 집행인에게 문의하세요.'; return; }
        pid = twin[0];
      }
    }

    // 다른 기기에서 복귀했으면 참가 자격(uid)을 이 기기로 옮긴다. 규칙상 제출 전에만 가능.
    if (pid && sync.uid && parts[pid].uid !== sync.uid) {
      await sync.set('sessions/' + code + '/participants/' + pid + '/uid', sync.uid);
    }

    if (!pid) {
      const status = await sync.get('sessions/' + code + '/status');
      if (status && status !== 'created') { err.textContent = '이미 입찰이 진행 중이라 새로 참가할 수 없습니다.'; return; }
      if (Object.keys(parts).length >= MAX_PARTICIPANTS) { err.textContent = '정원(' + MAX_PARTICIPANTS + '명)이 찼습니다.'; return; }
      pid = 'p' + Date.now().toString(36) + randInt(100, 999);
      const me = { nickname, joinedAt: sync.now(), submitted: false };
      if (sync.uid) me.uid = sync.uid;
      await sync.set('sessions/' + code + '/participants/' + pid, me);
    }

    store.set('bidsim_me_' + code, { pid, nickname });
    tabStore.set({ role: 'bidder', code, pid });
    enterBidderOnly();
    state.role = 'bidder'; state.code = code; state.pid = pid;
    state.stage = 'amount'; state.draftAmount = null; state.picks = [];
    subscribe(code, false);
    startPresence();
    show('s-bidder');
  } catch (e) {
    err.textContent = '참가에 실패했습니다: ' + (e && e.message ? e.message : e);
  } finally {
    $('btn-join').disabled = false;
  }
}

/** 남은 시간(ms). null 이면 타이머 정보가 아직 도착하지 않은 것으로,
    '시간이 끝났다'와 반드시 구분해야 한다. 상태와 타이머는 서로 다른 감시자로
    들어오므로 상태가 먼저 도착하는 순간이 있다. */
function timeLeft() {
  if (!state.timer) return null;
  const now = sync.now();
  if (now < state.timer.startedAt) return state.timer.durationMs;   // 시작 연출 중 — 아직 흐르지 않음
  return Math.max(0, state.timer.startedAt + state.timer.durationMs - now);
}

/** 입찰 시작 연출(기초금액 발표 · 3·2·1)이 진행 중인가 */
function inIntro() {
  return state.status === 'bidding' && !!state.timer && sync.now() < state.timer.startedAt;
}

async function submitBid() {
  const left = timeLeft();
  if (inIntro()) return;
  if (state.status !== 'bidding' || left == null || left <= 0) { alert('입찰 시간이 종료되었습니다.'); return; }
  if (state.picks.length !== PICK_COUNT) { alert('번호 ' + PICK_COUNT + '개를 선택하세요.'); return; }
  $('btn-submit').disabled = true;
  try {
    await sync.set('sessions/' + state.code + '/bids/' + state.pid, {
      amount: state.draftAmount,
      picks: [...state.picks].sort((a, b) => a - b),
      submittedAt: sync.now(),
    });
    await sync.set('sessions/' + state.code + '/participants/' + state.pid + '/submitted', true);
  } catch (e) {
    alert('제출에 실패했습니다: ' + (e && e.message ? e.message : e));
    $('btn-submit').disabled = false;
  }
}

/* ── 렌더링 ──────────────────────────────────────────────────────────────── */

function metaTags() {
  if (!state.meta) return '';
  const c = CATEGORIES[state.meta.category], m = METHODS[state.meta.method];
  return '<span class="tag">' + esc(c ? c.label : state.meta.category) + '</span>' +
         '<span class="tag tag-soft">' + esc(m ? m.label : state.meta.method) + '</span>';
}

function fmtClock(ms) {
  const t = Math.ceil(ms / 1000);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function render() {
  if (state.role === 'host') renderHost();
  else if (state.role === 'bidder') renderBidder();
  renderStage();
}

/* 연출 오버레이 ----------------------------------------------------------- */
/* 연출은 이벤트로 재생하지 않고, 공유된 시각(timer.startedAt · closedAt · openedAt)과
   현재 서버 시각으로 '지금 보여야 할 장면'을 매번 계산한다. 그래서 모든 기기가
   같은 장면을 보고, 새로고침하거나 늦게 들어와도 이미 지난 연출은 건너뛴다. */

/** 기초금액이 발표되었는가 (시작 연출의 '○○원입니다' 줄이 나온 뒤부터) */
function basePriceRevealed() {
  const st = state.status || 'created';
  if (st === 'created') return false;
  if (st === 'bidding' && !state.timer) return false;
  if (st === 'bidding') return sync.now() >= state.timer.startedAt - INTRO_MS + 2000;
  return true;
}

/**
 * 지금 보여야 할 장면.
 *   group : 같은 group 안에서는 줄만 덧붙이고, group 이 바뀌면 화면 전체를 교체한다
 *   lines : [{ text, big }]  — 차례로 나타나는 문구
 *   count : 3·2·1 숫자
 *   spin  : 진행 표시
 *   fx    : 폭죽
 *   actions : 집행인 전용 버튼 ('decrypt' | 'open')
 */
function sceneNow() {
  if (!state.role || !state.meta) return null;
  const st  = state.status || 'created';
  const now = sync.now();

  if (st === 'bidding' && state.timer && now < state.timer.startedAt) {
    const t = now - (state.timer.startedAt - INTRO_MS);
    if (t < 4000) {
      const lines = [{ text: '기초금액은' }];
      if (t >= 2000) lines.push({ text: won(state.meta.basePrice) + '입니다', big: true, gold: true });
      return { group: 'intro', lines };
    }
    if (t < 4500) return { group: 'intro', lines: [{ text: '기초금액은' }, { text: won(state.meta.basePrice) + '입니다', big: true, gold: true }], leaving: true };
    return { group: 'count', count: Math.max(1, 3 - Math.floor((t - 4500) / 1000)) };
  }

  if (st === 'closed' || st === 'decrypted') {
    const t = state.closedAt ? now - state.closedAt : Infinity;
    if (t < CLOSE_MSG_MS) return { group: 'closed', lines: [{ text: '입찰이 마감되었습니다', big: true }] };
    const host = state.role === 'host';
    if (st === 'decrypted') return {
      group: 'decrypted',
      lines: [{ text: '입찰서 복호화 완료', big: true }, { text: '개찰 대기 중입니다' }],
      sub: host ? '개찰을 진행하세요.' : null,
      actions: host ? 'open' : null,
    };
    return {
      group: 'decrypt',
      lines: [{ text: '입찰서 복호화 중입니다', big: true }],
      sub: host ? '입찰서 복호화를 진행하세요.' : null,
      spin: true,
      actions: host ? 'decrypt' : null,
    };
  }

  if (st === 'opened' && state.result && state.result.lottery) {
    const t = now - state.result.lottery.at;
    if (t >= OPEN_MS || t < -2000) return null;
    const winner = (state.result.valid || [])[0];
    const lines = [{ text: '동가 추첨 결과' }];
    if (t >= 1000) lines.push({ text: '1순위 입찰자는' });
    if (t >= 3000) lines.push({ text: winner.nickname + '님 입니다.', big: true, gold: true });
    return { group: 'lottery', lines, fx: t >= 3000, leaving: t >= OPEN_MS - 500 };
  }

  if (st === 'opened' && state.result && state.result.openedAt) {
    const t = now - state.result.openedAt;
    if (t >= OPEN_MS || t < -2000) return null;
    if (tieInfo(state.result).tied.length) {
      const lines = [{ text: '개찰이 완료되었습니다.' }];
      if (t >= 1000) lines.push({ text: '1순위 동가 입찰자가 ' + tieInfo(state.result).tied.length + '명입니다' });
      if (t >= 3000) lines.push({ text: '동가 추첨으로 결정합니다', big: true });
      return { group: 'open', lines, leaving: t >= OPEN_MS - 500 };
    }
    const winner = (state.result.valid || [])[0];
    const lines = [{ text: '개찰이 완료되었습니다.' }];
    if (t >= 1000) lines.push({ text: winner ? '1순위 입찰자는' : '낙찰하한금액 이상 입찰자가 없어' });
    if (t >= 3000) lines.push({ text: winner ? winner.nickname + '님 입니다.' : '낙찰자가 없습니다', big: true, gold: !!winner });
    return { group: 'open', lines, fx: t >= 3000 && !!winner, leaving: t >= OPEN_MS - 500 };
  }
  return null;
}

const stageView = { group: null, key: null, lineCount: 0, count: null };

function renderStage() {
  const el = $('stage');
  if (!el) return;
  const sc = sync ? sceneNow() : null;

  if (!sc) {
    if (stageView.group === 'count' && state.status === 'bidding') sfx.go();   // 3·2·1 이 끝나고 입찰 시작
    if (stageView.group !== null) {
      el.classList.remove('on');
      stageView.group = stageView.key = null;
      stageView.lineCount = 0; stageView.count = null;
      fireworks.stop();
      setTimeout(() => { if (stageView.group === null) el.hidden = true; }, 450);
    }
    return;
  }

  const key = JSON.stringify(sc);
  if (key === stageView.key) return;
  stageView.key = key;

  if (el.hidden) { el.hidden = false; void el.offsetWidth; }
  el.classList.add('on');

  const inner = $('stage-inner');
  if (sc.group !== stageView.group) {
    stageView.group = sc.group;
    stageView.lineCount = 0; stageView.count = null;
    inner.innerHTML = '';
    inner.classList.remove('leaving');
    fireworks.stop();
    // 새 장면은 통째로 fade-in
    inner.classList.remove('enter'); void inner.offsetWidth; inner.classList.add('enter');
  }
  inner.classList.toggle('leaving', !!sc.leaving);

  if (sc.count != null && sc.count !== stageView.count) {
    stageView.count = sc.count;
    inner.innerHTML = '<div class="stage-count num">' + sc.count + '</div>';
    sfx.tick(sc.count);
  }

  const lines = sc.lines || [];
  for (let i = stageView.lineCount; i < lines.length; i++) {
    const p = document.createElement('p');
    p.className = 'stage-line' + (lines[i].big ? ' stage-big' : '') + (lines[i].gold ? ' stage-gold' : '');
    p.textContent = lines[i].text;
    inner.appendChild(p);
  }
  stageView.lineCount = Math.max(stageView.lineCount, lines.length);

  let spin = inner.querySelector('.stage-spin');
  if (sc.spin && !spin) {
    spin = document.createElement('div');
    spin.className = 'stage-spin';
    inner.insertBefore(spin, inner.firstChild);
  }
  let sub = inner.querySelector('.stage-sub');
  if (sc.sub) {
    if (!sub) { sub = document.createElement('p'); sub.className = 'stage-sub'; inner.appendChild(sub); }
    sub.textContent = sc.sub;
  } else if (sub) sub.remove();

  const acts = $('stage-actions');
  const want = sc.actions || '';
  if (acts.dataset.kind !== want) {
    acts.dataset.kind = want;
    acts.innerHTML = '';
    if (want) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-lg ' + (want === 'decrypt' ? 'btn-primary' : 'btn-accent');
      b.textContent = want === 'decrypt' ? '입찰서 복호화' : '개찰 진행';
      b.onclick = async () => {
        b.disabled = true;
        try { await (want === 'decrypt' ? decryptBids() : openBids()); }
        finally { b.disabled = false; }
      };
      acts.appendChild(b);
    }
  }

  if (sc.fx) fireworks.start(); else fireworks.stop();
}

/* 효과음 ------------------------------------------------------------------- */
/** 3·2·1 카운트다운 효과음. 파일 없이 Web Audio 로 합성한다.
    브라우저는 사용자가 한 번이라도 화면을 누른 뒤에만 소리를 허용하므로 첫 입력 때 깨워 둔다. */
const sfx = (() => {
  let ctx = null;
  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  ['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, ac, { passive: true }));

  // 피아노 음색: 배음 여러 개를 겹치고, 높은 배음일수록 빨리 사라지게 한다.
  const PARTIALS = [[1, 1], [2, 0.42], [3, 0.2], [4, 0.1], [5, 0.05]];   // [배수, 세기]

  /** 건반 하나를 치는 소리. dur 는 여운 길이(초) */
  function key(freq, at, dur, vol) {
    const c = ac();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + at;

    const out = c.createGain();
    out.gain.value = vol;
    const lp = c.createBiquadFilter();           // 해머가 친 직후엔 밝고, 곧 부드러워진다
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(freq * 9, 12000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 2.5, 800), t + 0.6);
    lp.connect(out).connect(c.destination);

    for (const [mul, amp] of PARTIALS) {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mul * (1 + 0.0004 * mul * mul);   // 현의 미세한 인하모닉
      const d = dur / (0.6 + mul * 0.4);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(amp * 0.35, t + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g).connect(lp);
      osc.start(t); osc.stop(t + d + 0.05);
    }
  }

  return {
    // 3 → 2 → 1 로 갈수록 한 음씩 올라간다 (솔 · 라 · 시)
    tick(n) { key({ 3: 392, 2: 440, 1: 494 }[n] || 440, 0, 1.1, 0.22); },
    // 시작: 도·미·솔·도 화음을 살짝 흘려 치듯
    go() { [523, 659, 784, 1047].forEach((f, i) => key(f, i * 0.028, 2.2, 0.15)); },
  };
})();

/* 폭죽 --------------------------------------------------------------------- */
const fireworks = (() => {
  const COLORS = ['#3F7FC1', '#4BAFBC', '#CE9139', '#3D9B83', '#A9CFEF', '#E8B04B', '#C4706C'];
  let raf = 0, parts = [], nextBurst = 0, running = false, cv = null, ctx = null, W = 0, H = 0;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function burst() {
    const x = W * (0.15 + Math.random() * 0.7);
    const y = H * (0.12 + Math.random() * 0.35);
    const color = COLORS[randInt(0, COLORS.length - 1)];
    const n = 46 + randInt(0, 20);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.2;
      const v = 2.2 + Math.random() * 3.4;
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.011 + Math.random() * 0.01,
                   color: Math.random() < 0.2 ? '#FFFFFF' : color, r: 1.8 + Math.random() * 1.6 });
    }
  }
  function frame(ts) {
    if (!running) return;
    if (ts >= nextBurst) { burst(); nextBurst = ts + 280 + Math.random() * 380; }
    ctx.clearRect(0, 0, W, H);
    parts = parts.filter(p => p.life > 0);
    for (const p of parts) {
      p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.05;
      p.x += p.vx; p.y += p.vy; p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  return {
    start() {
      if (running) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      cv = $('stage-fx'); ctx = cv.getContext('2d');
      resize(); addEventListener('resize', resize);
      running = true; parts = []; nextBurst = 0;
      burst(); burst();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      if (!running) return;
      running = false; cancelAnimationFrame(raf); parts = [];
      removeEventListener('resize', resize);
      if (ctx) ctx.clearRect(0, 0, W, H);
    },
  };
})();

/* 집행인 화면 ------------------------------------------------------------- */
function renderHost() {
  if (!state.meta) return;
  const st    = state.status || 'created';
  const parts = state.participants || {};
  const ids   = Object.keys(parts).sort((a, b) => (parts[a].joinedAt || 0) - (parts[b].joinedAt || 0));

  document.querySelectorAll('#stepbar li').forEach(li => {
    const n = Number(li.dataset.step), cur = STEP_OF[st] || 1;
    li.classList.toggle('done', n < cur);
    li.classList.toggle('now', n === cur);
  });

  $('h-title').textContent = state.meta.title;
  $('h-tags').innerHTML    = metaTags();
  $('h-base').textContent  = won(state.meta.basePrice);
  $('h-rate').textContent  = state.meta.lowerRate + '%';
  $('h-dur').textContent   = Math.round((state.meta.durationMs || 60000) / 1000) + '초';
  $('h-code').textContent  = state.code;
  $('h-link').textContent  = joinLink(state.code);

  // online === false 인 참가인은 창을 닫았거나 연결이 끊긴 것(퇴장). 값이 없으면 접속 중으로 본다.
  const gone = ids.filter(pid => parts[pid].online === false).length;
  $('h-count').textContent = (ids.length - gone) + ' / ' + MAX_PARTICIPANTS + '명' + (gone ? ' · 퇴장 ' + gone : '');
  $('btn-refresh-parts').hidden = st !== 'created';
  $('h-plist').innerHTML = ids.length
    ? ids.map(pid => {
        const p = parts[pid];
        const off  = p.online === false;
        const done = st !== 'created' && p.submitted;
        const label = st === 'created' ? (off ? '퇴장' : '입장')
                    : (done ? '제출 완료' : '대기 중') + (off ? ' · 연결 끊김' : '');
        return '<li class="person' + (done ? ' is-done' : '') + (off && st === 'created' ? ' is-off' : '') + '">' +
                 '<span class="person-name">' + esc(p.nickname) + '</span>' +
                 '<span class="person-state">' + label + '</span>' +
               '</li>';
      }).join('')
    : '<li class="empty">아직 참가한 인원이 없습니다. 아래 코드나 QR을 공유하세요.</li>';

  const submitted = ids.filter(pid => parts[pid].submitted).length;
  $('h-submitted').textContent = st === 'created' ? '' : '제출 ' + submitted + '명 / 참가 ' + ids.length + '명';

  // 단계별 조작 패널
  $('h-panel-start').hidden   = st !== 'created';
  $('h-panel-timer').hidden   = st !== 'bidding';
  $('h-panel-closed').hidden  = st !== 'closed';
  $('h-panel-decrypt').hidden = st !== 'decrypted';
  $('h-panel-result').hidden  = st !== 'opened';
  $('h-share').hidden         = st !== 'created';

  if (st === 'bidding') {
    const left = timeLeft();
    if (left == null) {                       // 타이머 정보 도착 대기
      $('h-clock').textContent = '--:--';
      $('h-clock').classList.remove('urgent');
      $('h-bar-fill').style.width = '100%';
    } else {
      $('h-clock').textContent = fmtClock(left);
      $('h-clock').classList.toggle('urgent', left <= 10000 && !inIntro());
      $('h-bar-fill').style.width = (100 * left / state.timer.durationMs).toFixed(2) + '%';
      if (left <= 0) closeBidding();
    }
    const allIn = ids.length > 0 && submitted === ids.length && !inIntro();
    $('btn-close-early').disabled = !allIn;
    $('h-close-note').textContent = allIn
      ? '모든 참가인이 제출했습니다. 지금 마감할 수 있습니다.'
      : '모든 참가인이 입찰서를 제출하면 조기 종료할 수 있습니다.';
  }

  if (st === 'opened' && state.result) {
    $('h-result-body').innerHTML = resultHTML(state.result, null);
    const tie = tieInfo(state.result);
    $('btn-lottery').hidden   = !tie.tied.length;
    $('btn-lottery').disabled = tie.drawn;
    $('btn-lottery').textContent = tie.drawn ? '동가 추첨 완료' : '동가 추첨 프로그램';
  }
}

/* 참가인 화면 ------------------------------------------------------------- */
function renderBidder() {
  if (!state.meta) return;
  const st = state.status || 'created';
  const me = (state.participants || {})[state.pid];
  // 입찰 시작 전에 집행인이 명단을 정리해 내 자리가 사라졌으면 참가 화면으로 돌려보낸다.
  if (!me && st === 'created' && state.partsLoaded) {
    goHome('참가 명단에서 빠졌습니다. 다시 참가하려면 ‘참가하기’를 눌러 주세요.');
    return;
  }
  const mySubmitted = !!(me && me.submitted);

  $('b-title').textContent = state.meta.title;
  $('b-tags').innerHTML    = metaTags();
  // 기초금액은 입찰 시작 연출에서 발표되기 전까지 참가인에게 보이지 않는다.
  const baseShown = basePriceRevealed();
  $('b-base').textContent  = baseShown ? won(state.meta.basePrice) : '공개 전';
  $('b-base').classList.toggle('masked', !baseShown);
  $('b-rate').textContent  = state.meta.lowerRate + '%';
  $('b-me').textContent    = me ? me.nickname : '';

  const left = timeLeft();                       // null = 타이머 정보 도착 전
  const pending = st === 'bidding' && (left == null || inIntro());
  const inBidding = st === 'bidding' && !pending && !mySubmitted && left > 0;
  const waitingAfter = !pending && ((st === 'closed' || st === 'decrypted') || (st === 'bidding' && !inBidding));

  $('b-wait').hidden    = !(st === 'created' || pending);
  $('b-bidding').hidden = !inBidding;
  $('b-done').hidden    = !waitingAfter;
  $('b-result').hidden  = st !== 'opened';

  $('b-wait-title').textContent = pending ? '입찰 시작' : '참가 완료';
  $('b-wait-msg').textContent   = pending ? '곧 입찰서 작성 화면으로 넘어갑니다.'
                                          : '집행인이 입찰을 시작하면 자동으로 입찰서 작성 화면으로 넘어갑니다.';
  $('b-wait-count').hidden = pending;
  if (st === 'created') {
    $('b-wait-count').textContent = '현재 ' + Object.keys(state.participants || {}).length + '명 참가 중';
    if (state.picks.length || state.draftAmount !== null) {
      state.picks = []; state.draftAmount = null; state.stage = 'amount';
      $('b-amount').value = ''; $('btn-submit').disabled = false;
    }
  }

  if (inBidding) {
    $('b-clock').textContent = fmtClock(left);
    $('b-clock').classList.toggle('urgent', left <= 10000);
    $('b-bar-fill').style.width = (100 * left / state.timer.durationMs).toFixed(2) + '%';
    $('b-stage-amount').hidden = state.stage !== 'amount';
    $('b-stage-picks').hidden  = state.stage !== 'picks';
    if (state.stage === 'picks') {
      $('b-amount-echo').textContent = won(state.draftAmount);
      $('b-pick-count').textContent  = state.picks.length + ' / ' + PICK_COUNT;
      $('btn-submit').disabled = state.picks.length !== PICK_COUNT;
      padButtons.forEach(({ btn, n }) => btn.classList.toggle('picked', state.picks.includes(n)));
    }
  }

  if (waitingAfter) {
    $('b-done-title').textContent =
      st === 'bidding' ? (mySubmitted ? '입찰서 제출 완료' : '입찰 시간 종료')
    : st === 'closed'  ? '입찰 완료'
    :                    '입찰서 복호화 완료';
    $('b-done-msg').textContent =
      st === 'bidding' ? (mySubmitted ? '개찰을 기다리는 중입니다.' : '제한 시간 안에 제출하지 못했습니다.')
    : st === 'closed'  ? '집행인이 입찰서를 복호화하는 중입니다.'
    :                    '예정가격이 산정되었습니다. 개찰을 기다리는 중입니다.';
    $('b-done').classList.toggle('is-miss', st === 'bidding' && !mySubmitted);
  }

  if (st === 'opened' && state.result) $('b-result-body').innerHTML = resultHTML(state.result, state.pid);
}

/* 결과표 (집행인·참가인 공용) --------------------------------------------- */
function resultHTML(r, mePid) {
  const rate = amt => (r.predictedPrice ? (amt / r.predictedPrice * 100).toFixed(3) + '%' : '-');
  const diff = amt => (amt == null || r.minPrice == null) ? '-'
    : (amt - r.minPrice >= 0 ? '+' : '') + Number(amt - r.minPrice).toLocaleString('ko-KR');
  const row = (x, label) =>
    '<tr class="' + (x.pid === mePid ? 'is-me' : '') + '">' +
      '<td class="col-rank">' + label + '</td>' +
      '<td class="col-name">' + esc(x.nickname) + (x.pid === mePid ? ' <span class="badge-me">나</span>' : '') + '</td>' +
      '<td class="col-num">' + won(x.amount) + '</td>' +
      '<td class="col-num">' + rate(x.amount) + '</td>' +
      '<td class="col-num">' + diff(x.amount) + '</td>' +
    '</tr>';

  const valid  = r.valid  || [];
  const under  = r.under  || [];
  const absent = r.absent || [];
  const winner = valid[0];
  const tie    = tieInfo(r);
  const votes  = r.voteCounts || {};
  const maxVote = Math.max(1, ...Object.values(votes));

  return '' +
  '<div class="result-head">' +
    '<div class="big-stat"><span class="big-stat-label">예정가격</span>' +
      '<strong class="big-stat-value">' + won(r.predictedPrice) + '</strong></div>' +
    '<div class="big-stat big-stat-accent"><span class="big-stat-label">낙찰하한금액</span>' +
      '<strong class="big-stat-value">' + won(r.minPrice) + '</strong></div>' +
  '</div>' +

  (tie.tied.length && !tie.drawn
    ? '<p class="notice notice-warn">1순위 동가 입찰자가 ' + tie.tied.length + '명입니다 (' +
      tie.tied.map(x => esc(x.nickname)).join(', ') + '). 집행인의 동가 추첨으로 1순위를 결정합니다.</p>'
    : winner
    ? '<div class="winner-card"><span class="winner-label">낙찰예정자' + (tie.drawn ? ' · 동가 추첨' : '') + '</span>' +
      '<strong class="winner-name">' + esc(winner.nickname) + '</strong>' +
      '<span class="winner-amount">' + won(winner.amount) + ' · 투찰율 ' + rate(winner.amount) + '</span></div>'
    : '<p class="notice notice-warn">낙찰하한금액 이상으로 입찰한 참가인이 없어 낙찰자가 없습니다.</p>') +

  '<h3 class="sub">입찰 순위</h3>' +
  '<div class="table-wrap"><table class="tbl">' +
    '<thead><tr><th>순위</th><th>참가인</th><th>입찰금액</th><th>투찰율</th><th>하한 대비</th></tr></thead><tbody>' +
      valid.map(x => row(x, x.rank)).join('') +
      under.map(x => row(x, '<span class="out">순위 밖</span>')).join('') +
      (!valid.length && !under.length ? '<tr><td colspan="5" class="empty">제출된 입찰서가 없습니다.</td></tr>' : '') +
    '</tbody></table></div>' +
  (under.length ? '<p class="foot-note">‘순위 밖’은 낙찰하한금액(' + won(r.minPrice) + ') 미만으로 입찰해 낙찰 대상에서 제외된 경우입니다.</p>' : '') +
  (absent.length ? '<p class="foot-note">미제출: ' + absent.map(x => esc(x.nickname)).join(', ') + '</p>' : '') +

  '<h3 class="sub">복수예비가격 추첨 결과</h3>' +
  '<p class="foot-note">참가인이 가장 많이 선택한 <strong>' + (r.topNumbers || []).join(', ') +
    '번</strong>의 금액을 평균해 예정가격을 산정했습니다.</p>' +
  '<ul class="cand-grid">' +
    (r.candidates || []).map((amt, i) => {
      const n = i + 1, v = votes[n] || 0;
      const chosen = (r.topNumbers || []).includes(n);
      return '<li class="cand ' + (chosen ? 'is-top' : '') + '">' +
               '<span class="cand-no">' + n + '</span>' +
               '<span class="cand-amt">' + Number(amt).toLocaleString('ko-KR') + '</span>' +
               '<span class="cand-vote"><i style="width:' + (v / maxVote * 100).toFixed(0) + '%"></i>' + v + '표</span>' +
             '</li>';
    }).join('') +
  '</ul>';
}

/* ── 시작 ────────────────────────────────────────────────────────────────── */

function tick() {
  if (state.status === 'bidding') render();   // render() 안에서 renderStage() 도 호출된다
  else renderStage();
}

function wire() {
  // 집행인 PIN
  const checkPin = async () => {
    const v = $('pin-input').value.trim();
    if (!v) { $('pin-err').textContent = 'PIN을 입력하세요.'; return; }
    if (await sha256Hex(v) !== hostPinHash.toLowerCase()) {
      $('pin-err').textContent = 'PIN이 올바르지 않습니다.'; $('pin-input').select(); return;
    }
    hostPinPassed.set();
    openCreate();
  };
  $('btn-pin-ok').onclick  = checkPin;
  $('pin-input').onkeydown = e => { if (e.key === 'Enter') checkPin(); };
  $('btn-go-join-pin').onclick    = openJoin;
  $('btn-go-join-create').onclick = openJoin;

  // 세션 생성
  $('f-category').onchange  = syncRateWithCategory;
  $('btn-create').onclick   = createSession;
  $('f-base').oninput = e => {
    const n = e.target.value.replace(/[^\d]/g, '');
    e.target.value = n ? Number(n).toLocaleString('ko-KR') : '';
  };

  // 집행인 조작
  $('btn-start').onclick     = startBidding;
  $('btn-decrypt').onclick   = decryptBids;
  $('btn-close-early').onclick = closeBidding;
  $('btn-lottery').onclick = async e => {
    e.currentTarget.disabled = true;
    try { await drawLottery(); } catch (err) { console.error(err); e.currentTarget.disabled = false; }
  };
  $('btn-open').onclick      = openBids;
  $('btn-rebid').onclick     = rebid;
  $('btn-refresh-parts').onclick = refreshParticipants;
  $('btn-host-exit').onclick = () => { if (confirm('집행인 화면을 나갑니다. 세션은 그대로 남아 있습니다.')) goHome(); };
  $('btn-copy-link').onclick = async () => {
    const b = $('btn-copy-link');
    try { await navigator.clipboard.writeText(joinLink(state.code)); b.textContent = '복사됨'; }
    catch { b.textContent = '복사 실패'; }
    setTimeout(() => { b.textContent = '링크 복사'; }, 1500);
  };

  // 참가
  $('btn-join').onclick      = joinSession;
  $('btn-join-back').onclick = () => goHome();
  $('j-code').oninput   = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
  $('j-nick').onkeydown = e => { if (e.key === 'Enter') $('j-code').focus(); };
  $('j-code').onkeydown = e => { if (e.key === 'Enter') joinSession(); };

  // 입찰 입력
  $('b-amount').oninput = e => {
    const n = e.target.value.replace(/[^\d]/g, '');
    e.target.value = n ? Number(n).toLocaleString('ko-KR') : '';
  };
  $('btn-amount-next').onclick = () => {
    const n = Number(($('b-amount').value || '').replace(/[^\d]/g, ''));
    if (!n) { $('b-amount-err').textContent = '입찰금액을 입력하세요.'; return; }
    $('b-amount-err').textContent = '';
    state.draftAmount = n; state.stage = 'picks'; state.picks = [];
    buildPad();
    render();
  };
  $('btn-pick-back').onclick   = () => { state.stage = 'amount'; render(); };
  $('btn-submit').onclick      = submitBid;
  $('btn-bidder-exit').onclick = () => {
    const msg = (state.status || 'created') === 'created'
      ? '실습에서 나갑니다.\n참가 명단에서 빠지며, 다시 참가하려면 닉네임을 새로 입력해야 합니다.'
      : '실습에서 나갑니다.';
    if (confirm(msg)) leaveAsBidder();
  };

}

/** 예비가격 선택판. 참가인끼리 번호·위치로 담합하지 못하도록 칸에 번호를 쓰지 않고
    배치를 매번 섞는다. 실제 번호(1~15)는 DOM이 아니라 padButtons 에만 둔다. */
let padButtons = [];
function buildPad() {
  const order = Array.from({ length: CAND_COUNT }, (_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pad = $('b-pad');
  pad.innerHTML = '';
  padButtons = order.map((n, pos) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', '예비가격 칸 ' + (pos + 1));
    b.onclick = () => {
      const i = state.picks.indexOf(n);
      if (i >= 0) state.picks.splice(i, 1);
      else if (state.picks.length < PICK_COUNT) state.picks.push(n);
      else { state.picks.shift(); state.picks.push(n); }  // 3번째를 누르면 먼저 고른 것이 빠진다
      render();
    };
    pad.appendChild(b);
    return { btn: b, n };
  });
}

async function boot() {
  // 선택 목록 구성 (수의계약 외에는 준비 중)
  $('f-method').innerHTML = Object.entries(METHODS)
    .map(([k, v]) => '<option value="' + k + '"' + (v.enabled ? '' : ' disabled') + '>' +
                     v.label + (v.enabled ? '' : ' (준비 중)') + '</option>').join('');
  $('f-method').value = 'private';
  $('f-category').innerHTML = Object.entries(CATEGORIES)
    .map(([k, v]) => '<option value="' + k + '">' + v.label + ' · 낙찰하한율 ' + v.rate + '%</option>').join('');
  syncRateWithCategory();

  wire();

  const online = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.databaseURL);
  let fellBack = false, authOff = false;
  try {
    sync = await (online ? new FirebaseSync(firebaseConfig).init() : new LocalSync().init());
  } catch (e) {
    console.error('Firebase 연결 실패 — 로컬 모드로 전환합니다.', e);
    authOff = !!(e && ['auth/operation-not-allowed', 'auth/admin-restricted-operation',
                       'auth/configuration-not-found'].includes(e.code));
    sync = await new LocalSync().init();
    fellBack = true;
  }
  const badge = $('mode-badge');
  badge.textContent = sync.mode === 'online'
    ? '온라인 모드 · 여러 기기에서 접속할 수 있습니다'
    : authOff  ? 'Firebase 익명 로그인이 꺼져 있습니다 · 설치 가이드 1단계를 확인하세요 (지금은 로컬 모드)'
    : fellBack ? '연결 실패 · 로컬 모드로 동작합니다'
    :            '로컬 모드 · 이 브라우저의 탭끼리만 동기화됩니다';
  badge.classList.toggle('local', sync.mode !== 'online');

  setInterval(tick, 100);

  // 링크에 담긴 세션코드 · 지난번 닉네임 자동 입력
  const q = new URLSearchParams(location.search).get('s');
  if (q || bidderOnlyFlag.get()) enterBidderOnly();
  if (q) {
    const code = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    $('j-code').value = code;
    const me = store.get('bidsim_me_' + code);
    if (me && me.nickname) $('j-nick').value = me.nickname;
  }

  /* 어느 화면으로 돌아갈지 정한다.
     ① 이 탭이 기억하는 역할(새로고침 대비)
     ② 참가 링크 없이 열었다면 마지막으로 진행하던 집행인 세션
     참가 링크로 들어온 새 탭은 항상 참가 화면을 보여준다. 닉네임만 채워 두면
     한 번 눌러 원래 자격으로 돌아갈 수 있고, 다른 이름을 쓰면 별개 참가인이 된다. */
  let resume = tabStore.get();
  if (!resume && !state.bidderOnly) {
    const h = store.get('bidsim_host_last');
    if (h && h.code) resume = { role: 'host', code: h.code };
  }

  if (resume && resume.code && await sync.get('sessions/' + resume.code + '/meta')) {
    if (resume.role === 'host') {
      state.role = 'host'; state.code = resume.code;
      const h = store.get(hostKey(resume.code)) || {};
      state.candidates = h.candidates || null;
      state.predicted  = h.predicted  || null;
      tabStore.set({ role: 'host', code: resume.code });
      subscribe(resume.code, true);
      show('s-host'); renderQR(resume.code);
      return;
    }
    if (resume.role === 'bidder' && resume.pid &&
        await sync.get('sessions/' + resume.code + '/participants/' + resume.pid)) {
      state.role = 'bidder'; state.code = resume.code; state.pid = resume.pid;
      tabStore.set({ role: 'bidder', code: resume.code, pid: resume.pid });
      subscribe(resume.code, false);
      startPresence();
      show('s-bidder');
      return;
    }
  }
  if (state.bidderOnly) { show('s-join'); $('j-nick').focus(); } else openHostEntry();
}

boot();
