/* Kings Pass
   One Google sign-in for all of Neel's games. The games only open for Google accounts that have signed up on
   https://elyneel.github.io/play/ so a link passed on is no use to anyone without their own pass.

   In a game:      <script src="/play/gate.js" data-game="street-kings"></script>  (in the <head>)
   Pages use it:   window.KingsPass (sign in button, session, calls to the database)

   The sign-in is the same one Street Kings already uses (Supabase + Google), kept in the same place on this
   website, so signing in once covers the sign-up page, Street Kings and Castaway Kings.
   Only switched on for the real website: local files, the copy inside Claude and test pages are left alone. */
(function () {
  'use strict';
  if (window.KingsPass) return;

  var SB_URL = 'https://wdtrktzxszfaftotrdyw.supabase.co';
  var SB_KEY = 'sb_publishable_Llb7ESB5jkatL60gq7vNpw_WXucSND0';   // publishable: meant to be public, the database rules do the protecting
  var GOOGLE_CLIENT_ID = '976658848882-hsh1cgvct6gpfjkh0lu0bt1nttk2nqgq.apps.googleusercontent.com';
  var SESSION_KEY = 'streetkings.session';   // shared with Street Kings on purpose
  var PASS_KEY = 'kingspass.ok';             // the last good check on this device
  var HOME = 'https://elyneel.github.io/play/';
  var GAMES = {
    'street-kings': { name: 'Street Kings', url: 'https://elyneel.github.io/street-kings/' },
    'castaway-kings': { name: 'Castaway Kings', url: 'https://elyneel.github.io/castaway-kings/' }
  };
  var LIVE = location.hostname === 'elyneel.github.io';

  var script = document.currentScript;
  var GAME = script && script.getAttribute('data-game');

  function store(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function read(k) {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
  }
  function claims(tok) {
    try { return JSON.parse(decodeURIComponent(escape(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; }
  }

  var Pass = {
    games: GAMES,
    home: HOME,
    live: LIVE,

    /* ---- the sign-in kept on this device ---- */
    session: function () {
      var s = read(SESSION_KEY);
      return s && s.access_token ? s : null;
    },
    setSession: function (j) {
      var c = claims(j.access_token);
      var s = { access_token: j.access_token, refresh_token: j.refresh_token,
        expires_at: j.expires_at || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), uid: c.sub || null };
      store(SESSION_KEY, s);
      return s;
    },
    // who is signed in, straight from the sign-in itself: { uid, email, name, firstName, picture }
    who: function () {
      var s = this.session(); if (!s) return null;
      var c = claims(s.access_token), m = c.user_metadata || {};
      var full = m.full_name || m.name || '';
      return { uid: c.sub, email: c.email || m.email || '', name: full, firstName: full.split(' ')[0] || '', picture: m.avatar_url || m.picture || '' };
    },
    // a working access token, refreshed when it has run out (null when nobody is signed in)
    token: function () {
      var self = this, s = this.session();
      if (!s) return Promise.resolve(null);
      if ((s.expires_at || 0) - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
      if (this._refreshing) return this._refreshing;
      this._refreshing = fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j.access_token) return self.setSession(j).access_token;
          var now = self.session();
          // another page (or the game itself) refreshed it first: use theirs
          if (now && now.refresh_token !== s.refresh_token) return now.access_token;
          if (r.status >= 400 && r.status < 500) { store(SESSION_KEY, null); return null; }
          throw new Error('offline');
        });
      }, function () { throw new Error('offline'); });
      this._refreshing.then(clear, clear);
      function clear() { self._refreshing = null; }
      return this._refreshing;
    },
    // calls one of the kings_ database functions
    rpc: function (name, args) {
      return this.token().then(function (tok) {
        if (!tok) { var e = new Error('Sign in first'); e.code = 'signin'; throw e; }
        return fetch(SB_URL + '/rest/v1/rpc/' + name, {
          method: 'POST',
          headers: { apikey: SB_KEY, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {})
        }).then(function (r) {
          return r.text().then(function (t) {
            var d = null; try { d = t ? JSON.parse(t) : null; } catch (x) { d = t; }
            if (!r.ok) {
              var err = new Error((d && (d.message || d.msg)) || ('Error ' + r.status));
              err.status = r.status; err.code = d && d.code; throw err;
            }
            return d;
          });
        }, function () { var e = new Error('offline'); e.offline = true; throw e; });
      });
    },
    signOut: function () {
      var self = this;
      return this.token().catch(function () { return null; }).then(function (tok) {
        store(SESSION_KEY, null); store(PASS_KEY, null);
        if (tok) return fetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + tok } }).catch(function () {});
      }).then(function () { try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {} self._gis = null; });
    },
    device: function () {
      var ua = navigator.userAgent || '';
      if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
      if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'phone';
      return 'computer';
    },

    /* ---- Google's sign-in button ---- */
    loadGoogle: function () {
      if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
      if (!this._gisLoad) this._gisLoad = new Promise(function (res, rej) {
        var sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
        sc.onload = function () { res(); };
        sc.onerror = function () { Pass._gisLoad = null; rej(new Error('Google did not load')); };
        document.head.appendChild(sc);
      });
      return this._gisLoad;
    },
    // puts Google's button in el. done(true) once signed in, done(false, message) if it didn't work
    button: function (el, done, opts) {
      var self = this;
      opts = opts || {};
      el.innerHTML = '';
      return this.loadGoogle().then(function () {
        // Google gets a hashed one-off code and the database checks the plain one, so a stolen sign-in can't be replayed
        var raw = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(24)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then(function (dig) {
          var hashed = Array.prototype.map.call(new Uint8Array(dig), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
          google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID, nonce: hashed, ux_mode: 'popup', auto_select: false, itp_support: true, use_fedcm_for_button: true,
            callback: function (resp) {
              fetch(SB_URL + '/auth/v1/token?grant_type=id_token', {
                method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'google', id_token: resp.credential, nonce: raw })
              }).then(function (r) {
                return r.json().then(function (j) {
                  if (!r.ok || !j.access_token) throw new Error(j.msg || j.error_description || j.message || 'please try again');
                  self.setSession(j);
                  done(true);
                });
              }).catch(function (e) {
                done(false, 'Sign-in didn’t work: ' + (e.message === 'Failed to fetch' ? 'check your internet' : e.message));
                self.button(el, done, opts);   // a fresh one-off code for the next go
              });
            }
          });
          var w = Math.max(220, Math.min(340, el.clientWidth || 300));
          google.accounts.id.renderButton(el, { type: 'standard', theme: opts.theme || 'filled_black', size: 'large', text: opts.text || 'continue_with', shape: 'pill', logo_alignment: 'left', width: w });
        });
      }).catch(function () {
        // Google's button was blocked (an ad blocker or a strict browser): the plain way still works
        el.innerHTML = '';
        var a = document.createElement('button');
        a.type = 'button'; a.className = 'kp-google-fallback'; a.textContent = 'Continue with Google';
        a.onclick = function () { self.redirectSignIn(); };
        el.appendChild(a);
      });
    },
    // the plain way: off to Google and back to this page
    redirectSignIn: function () {
      var back = location.href.split('#')[0];
      location.href = SB_URL + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(back);
    },
    // coming back from the plain way: the sign-in is in the address after the #
    fromRedirect: function () {
      var h = location.hash || '';
      if (h.indexOf('access_token=') < 0) return false;
      var q = new URLSearchParams(h.slice(1));
      history.replaceState(null, '', location.pathname + location.search);
      this.setSession({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'),
        expires_at: Number(q.get('expires_at')) || 0, expires_in: q.get('expires_in') });
      return true;
    },

    // a link back to the sign-up page that returns here afterwards
    signupLink: function (game) {
      var u = HOME + '?game=' + encodeURIComponent(game || '');
      if (LIVE) u += '&back=' + encodeURIComponent(location.href.split('#')[0]);
      return u;
    },
    // only ever send people back to Neel's own games
    safeBack: function (u) {
      try { var x = new URL(u); return x.origin === 'https://elyneel.github.io' && x.pathname.indexOf('/play') !== 0 ? x.href : null; } catch (e) { return null; }
    }
  };
  window.KingsPass = Pass;
  if (LIVE) Pass.fromRedirect();

  /* =====================================================================
     THE LOCK (only in a game, only on the real website)
     ===================================================================== */
  if (!GAME || !LIVE || window.__noGate === true) return;
  var game = GAMES[GAME] || { name: 'this game', url: location.href };
  var locked = false, el = null, fresh = false;
  var REMEMBER_MS = 12 * 3600 * 1000;      // a good check on this device lets you straight in for 12 hours (still checked quietly)
  var OFFLINE_MS = 14 * 24 * 3600 * 1000;  // with no internet, a good check from the last 2 weeks still lets you play

  var css = '' +
    '#kp-lock{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:24px 16px;' +
    'padding-top:calc(24px + env(safe-area-inset-top,0px));padding-bottom:calc(24px + env(safe-area-inset-bottom,0px));' +
    'background:radial-gradient(120% 90% at 50% 0%,rgba(30,34,52,.94),rgba(8,10,16,.97));color:#f1ece0;' +
    'font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;' +
    'overflow-y:auto;user-select:text;-webkit-user-select:text;touch-action:auto;color-scheme:dark;transition:opacity .25s}' +
    '#kp-lock.kp-out{opacity:0;pointer-events:none}' +
    '#kp-lock *{box-sizing:border-box}' +
    '#kp-card{width:100%;max-width:400px;background:#161a25;border:1px solid #2b3142;border-radius:20px;padding:26px 22px 22px;' +
    'box-shadow:0 30px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:14px;text-align:left}' +
    '#kp-card .kp-tag{display:flex;align-items:center;gap:8px;font:700 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:#f2b630}' +
    '#kp-card .kp-tag svg{width:18px;height:14px;fill:#f2b630}' +
    '#kp-card h2{margin:0;font:800 24px/1.15 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:-.01em;text-wrap:balance}' +
    '#kp-card p{margin:0;color:#b3b8c6}' +
    '#kp-card b{color:#f1ece0;font-weight:700;word-break:break-all}' +
    '#kp-card .kp-btn{display:flex;align-items:center;justify-content:center;min-height:48px;padding:12px 18px;border-radius:999px;border:0;' +
    'background:#f2b630;color:#1a1306;font:800 16px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;text-decoration:none;cursor:pointer}' +
    '#kp-card .kp-btn:focus-visible,#kp-card .kp-link:focus-visible{outline:3px solid #8fb4ff;outline-offset:3px}' +
    '#kp-card .kp-link{background:none;border:0;padding:0;color:#b3b8c6;font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer;align-self:flex-start}' +
    '#kp-card .kp-g{min-height:44px;display:flex;justify-content:center}' +
    '#kp-card .kp-note{font-size:13px;color:#8a90a0}' +
    '#kp-card .kp-err{font-size:14px;color:#ff9b8a}' +
    '#kp-card .kp-spin{width:22px;height:22px;border-radius:50%;border:3px solid #2b3142;border-top-color:#f2b630;animation:kpspin .8s linear infinite}' +
    '@keyframes kpspin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){#kp-card .kp-spin{animation-duration:3s}#kp-lock{transition:none}}' +
    '.kp-google-fallback{min-height:44px;padding:10px 20px;border-radius:999px;border:1px solid #3a4154;background:#fff;color:#1f1f1f;font:600 15px system-ui,sans-serif;cursor:pointer}';
  var CROWN = '<svg viewBox="0 0 18 14" aria-hidden="true"><path d="M1 3l4 4 4-6 4 6 4-4-1.6 10H2.6z"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // while the lock is up, keys and taps don't reach the game underneath
  function block(e) { if (locked && el && !el.contains(e.target)) { e.stopImmediatePropagation(); if (e.cancelable && e.type !== 'keyup') e.preventDefault(); } }
  ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'touchstart', 'click', 'wheel', 'contextmenu'].forEach(function (t) {
    window.addEventListener(t, block, { capture: true, passive: false });
  });

  function show(html) {
    if (!el) {
      var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);
      el = document.createElement('div'); el.id = 'kp-lock'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', game.name + ' pass check');
      document.documentElement.appendChild(el);
    }
    locked = true;
    el.classList.remove('kp-out');
    el.innerHTML = '<div id="kp-card"><div class="kp-tag">' + CROWN + 'Kings Pass</div>' + html + '</div>';
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch (e) {}
    return el;
  }
  function unlock() {
    locked = false;
    if (el) { el.classList.add('kp-out'); setTimeout(function () { if (!locked && el) { el.remove(); el = null; } }, 300); }
  }
  function remember(uid) { store(PASS_KEY, { uid: uid, at: Date.now() }); }

  function checking() {
    show('<h2>' + esc(game.name) + '</h2><div style="display:flex;gap:12px;align-items:center"><div class="kp-spin" aria-hidden="true"></div><p>Checking your pass…</p></div>');
  }
  function signIn(msg) {
    show('<h2>Sign in to play ' + esc(game.name) + '</h2>' +
      '<p>Use the Google account you got your pass with. The game only opens for that account.</p>' +
      '<div class="kp-g" id="kp-g"></div>' +
      (msg ? '<p class="kp-err" role="alert">' + esc(msg) + '</p>' : '') +
      '<p class="kp-note">No pass yet? It’s free and takes a minute.</p>' +
      '<a class="kp-btn" href="' + esc(Pass.signupLink(GAME)) + '">Get my free pass</a>');
    Pass.button(document.getElementById('kp-g'), function (ok, m) {
      stopWatch();
      if (ok) { fresh = true; check(); } else signIn(m);
    });
    // Google's sign-in is shared with the page: if the game's own Google button answers instead of this one,
    // the sign-in still lands in the same place, so watch for it and carry on
    stopWatch();
    var before = (Pass.session() || {}).access_token;
    watch = setInterval(function () { var s = Pass.session(); if (s && s.access_token !== before) { stopWatch(); fresh = true; checking(); check(); } }, 800);
  }
  var watch = 0;
  function stopWatch() { if (watch) { clearInterval(watch); watch = 0; } }
  function needPass(email) {
    show('<h2>No pass on this account yet</h2>' +
      '<p>You’re signed in as <b>' + esc(email || 'this Google account') + '</b>, but it hasn’t got a pass for ' + esc(game.name) + '.</p>' +
      '<a class="kp-btn" href="' + esc(Pass.signupLink(GAME)) + '">Get my free pass</a>' +
      '<button class="kp-link" type="button" id="kp-other">Use a different Google account</button>');
    document.getElementById('kp-other').onclick = function () { Pass.signOut().then(function () { signIn(); }); };
  }
  function blocked(email) {
    show('<h2>This account can’t play right now</h2>' +
      '<p><b>' + esc(email || '') + '</b> has been taken off the list for ' + esc(game.name) + '.</p>' +
      '<button class="kp-link" type="button" id="kp-other">Use a different Google account</button>');
    document.getElementById('kp-other').onclick = function () { Pass.signOut().then(function () { signIn(); }); };
  }
  function trouble() {
    show('<h2>Couldn’t check your pass</h2><p>Check your internet, then try again.</p>' +
      '<button class="kp-btn" type="button" id="kp-again">Try again</button>');
    document.getElementById('kp-again').onclick = function () { checking(); check(); };
  }

  // quiet = the player is already in (a recent good check on this device); only interrupt if the pass has gone
  function check(quiet) {
    var s = Pass.session();
    if (!s) { store(PASS_KEY, null); signIn(); return; }
    Pass.rpc('kings_enter', { p_game: GAME, p_device: Pass.device() }).then(function (r) {
      if (r && r.ok) {
        remember(s.uid || (Pass.who() || {}).uid);
        if (fresh) { location.reload(); return; }   // signed in just now: start the game fresh so it knows who you are
        unlock(); return;
      }
      store(PASS_KEY, null);
      var why = r && r.reason;
      if (why === 'signup') needPass(r.email);
      else if (why === 'blocked') blocked(r.email);
      else signIn();
    }).catch(function (e) {
      if (e && e.code === 'signin') { store(PASS_KEY, null); signIn(); return; }
      var ok = read(PASS_KEY), who = Pass.who();
      if (e && (e.offline || e.message === 'offline') && ok && who && ok.uid === who.uid && Date.now() - ok.at < OFFLINE_MS) { unlock(); return; }
      if (quiet) return;   // already playing: a hiccup on the quiet check isn't worth stopping them for
      if (e && e.status === 404) { unlock(); return; }   // the pass system isn't set up in the database yet: don't lock everyone out
      trouble();
    });
  }

  var last = read(PASS_KEY), who = Pass.who();
  if (last && who && last.uid === who.uid && Date.now() - last.at < REMEMBER_MS) check(true);
  else { checking(); check(); }
})();
