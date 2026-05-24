/* directions/hearth/tweaks-panel.js
 * Shared Tweaks panel for all Hearth pages.
 * Reads window.HEARTH_TWEAK_DEFAULTS if defined (for index.html disk persistence),
 * otherwise uses its own baked-in defaults.
 * Persists user choices to localStorage('hearth-tweaks') so they carry across pages.
 */
(function () {
  var defaults = (typeof window.HEARTH_TWEAK_DEFAULTS === 'object')
    ? window.HEARTH_TWEAK_DEFAULTS
    : { mood: 'ember', voice: 'editorial', atmosphere: 50 };

  var moodMap = {
    ember:      { accent: 'oklch(0.78 0.13 70)',  deep: 'oklch(0.62 0.15 55)', mute: 'oklch(0.55 0.10 65)', wash: 'oklch(0.32 0.10 60)', glowRGB: '232, 188, 110', label: 'Ember' },
    hearthfire: { accent: 'oklch(0.74 0.18 40)',  deep: 'oklch(0.58 0.18 35)', mute: 'oklch(0.52 0.12 38)', wash: 'oklch(0.30 0.13 38)', glowRGB: '230, 130, 80',  label: 'Hearthfire' },
    brass:      { accent: 'oklch(0.82 0.13 95)',  deep: 'oklch(0.65 0.14 90)', mute: 'oklch(0.55 0.10 90)', wash: 'oklch(0.32 0.10 90)', glowRGB: '220, 200, 100', label: 'Cool brass' },
    iron:       { accent: 'oklch(0.78 0.10 230)', deep: 'oklch(0.60 0.12 230)', mute: 'oklch(0.55 0.08 230)', wash: 'oklch(0.30 0.10 230)', glowRGB: '120, 160, 220', label: 'Iron' }
  };
  var voiceLabel = { editorial: 'Editorial', modern: 'Modern', lab: 'Lab' };

  var state = Object.assign({}, defaults);
  try {
    var saved = localStorage.getItem('hearth-tweaks');
    if (saved) state = Object.assign(state, JSON.parse(saved));
  } catch (e) {}

  // Inject styles + DOM once
  function init() {
    if (document.getElementById('hearthTweaksStyles')) return;
    var css = `
.tweaks-panel { position: fixed; right: 24px; bottom: 76px; z-index: 9999; width: 300px; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: var(--shadow-3), 0 0 32px var(--accent-glow); font-family: var(--sans); color: var(--fg); overflow: hidden; animation: tw-in 200ms cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes tw-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.tweaks-panel[hidden] { display: none; }
.tweaks-head { padding: 10px 14px; background: var(--bg-3); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; font-family: var(--mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); }
.tweaks-head button { background: none; border: none; color: var(--fg-mute); cursor: pointer; width: 22px; height: 22px; border-radius: 3px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
.tweaks-head button:hover { background: var(--bg-1); color: var(--fg); }
.tweaks-body { padding: 14px; display: flex; flex-direction: column; gap: 16px; }
.tweaks-body section { display: flex; flex-direction: column; gap: 6px; }
.tweak-label { font-family: var(--serif); font-size: 18px; font-weight: 400; line-height: 1; display: flex; align-items: baseline; justify-content: space-between; }
.tweak-value { font-family: var(--mono); font-size: 11px; color: var(--accent); font-weight: 400; background: var(--accent-wash); padding: 1px 6px; border-radius: 3px; }
.tweak-hint { font-family: var(--serif); font-style: italic; font-size: 12px; color: var(--fg-mute); line-height: 1.4; margin-top: 2px; }
.tweak-radio { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.tweak-radio button { padding: 8px 10px; background: var(--bg-1); border: 1px solid var(--line-strong); color: var(--fg-mute); cursor: pointer; font-family: var(--sans); font-size: 12px; font-weight: 500; border-radius: 4px; transition: all 100ms cubic-bezier(0.16, 1, 0.3, 1); text-align: left; }
.tweak-radio button:hover { color: var(--fg); border-color: var(--fg-faint); }
.tweak-radio button.active { background: var(--accent-wash); color: var(--accent); border-color: var(--accent); box-shadow: 0 0 12px var(--accent-glow); }
.tweak-radio button .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.tweaks-body input[type=range] { width: 100%; accent-color: var(--accent); margin: 4px 0 2px; }
.tweak-axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-faint); }
html[data-voice="modern"] { --serif: 'Geist', system-ui, sans-serif; }
html[data-voice="modern"] .hero h1, html[data-voice="modern"] .display, html[data-voice="modern"] h1, html[data-voice="modern"] h2, html[data-voice="modern"] .h1, html[data-voice="modern"] .h2 { letter-spacing: -0.04em; font-weight: 600; }
html[data-voice="modern"] .italic, html[data-voice="modern"] em.italic, html[data-voice="modern"] .hero h1 .em, html[data-voice="modern"] .em.italic { font-style: normal; }
html[data-voice="lab"] { --serif: 'JetBrains Mono', ui-monospace, monospace; }
html[data-voice="lab"] .hero h1, html[data-voice="lab"] .display, html[data-voice="lab"] h1, html[data-voice="lab"] h2, html[data-voice="lab"] .h1, html[data-voice="lab"] .h2 { letter-spacing: -0.05em; font-weight: 600; }
html[data-voice="lab"] .italic, html[data-voice="lab"] em.italic, html[data-voice="lab"] .hero h1 .em { font-style: normal; }
html { --atmosphere: 1; }
.hero h1 .em, .section-head .title .em, .display .italic { text-shadow: 0 0 calc(32px * var(--atmosphere, 1)) var(--accent-glow); }
.theme-toggle.tweaks-open-btn { right: 240px !important; }
`;
    var style = document.createElement('style');
    style.id = 'hearthTweaksStyles';
    style.textContent = css;
    document.head.appendChild(style);

    var openBtn = document.createElement('button');
    openBtn.className = 'theme-toggle tweaks-open-btn';
    openBtn.id = 'hearthTweaksOpen';
    openBtn.setAttribute('aria-label', 'Open Tweaks');
    openBtn.innerHTML = '<span class="sym">⚙</span><span style="letter-spacing: 0.16em;">Tweaks</span>';
    document.body.appendChild(openBtn);

    var panel = document.createElement('div');
    panel.className = 'tweaks-panel';
    panel.id = 'hearthTweaks';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="tweaks-head">
        <span>Tweaks</span>
        <button id="hearthTweaksClose" aria-label="Close">✕</button>
      </div>
      <div class="tweaks-body">
        <section>
          <div class="tweak-label">Mood <span class="tweak-value" id="moodVal">Ember</span></div>
          <div class="tweak-radio" id="moodControl">
            <button data-value="ember"><span class="swatch" style="background: oklch(0.78 0.13 70);"></span>Ember</button>
            <button data-value="hearthfire"><span class="swatch" style="background: oklch(0.74 0.18 40);"></span>Hearthfire</button>
            <button data-value="brass"><span class="swatch" style="background: oklch(0.82 0.13 95);"></span>Cool brass</button>
            <button data-value="iron"><span class="swatch" style="background: oklch(0.78 0.10 230);"></span>Iron</button>
          </div>
          <p class="tweak-hint">Re-tunes the accent across firelight hues &mdash; from low ember to cool iron.</p>
        </section>
        <section>
          <div class="tweak-label">Voice <span class="tweak-value" id="voiceVal">Editorial</span></div>
          <div class="tweak-radio" style="grid-template-columns: 1fr 1fr 1fr;" id="voiceControl">
            <button data-value="editorial">Editorial</button>
            <button data-value="modern">Modern</button>
            <button data-value="lab">Lab</button>
          </div>
          <p class="tweak-hint">Swaps display type: <em>Newsreader serif</em>, <em>Geist sans</em>, or <em>JetBrains Mono</em>.</p>
        </section>
        <section>
          <div class="tweak-label">Atmosphere <span class="tweak-value" id="atmosphereVal">50</span></div>
          <input type="range" min="0" max="100" value="50" id="atmosphereSlider">
          <div class="tweak-axis"><span>Quiet</span><span>Charged</span></div>
          <p class="tweak-hint">Modulates the warmth of the glow on accent moments. Quiet = monastic; charged = the room is on fire.</p>
        </section>
      </div>
    `;
    document.body.appendChild(panel);
    wire();
  }

  function apply() {
    var m = moodMap[state.mood] || moodMap.ember;
    var atm = +state.atmosphere / 50;
    var html = document.documentElement;
    html.style.setProperty('--accent', m.accent);
    html.style.setProperty('--accent-deep', m.deep);
    html.style.setProperty('--accent-mute', m.mute);
    html.style.setProperty('--accent-wash', m.wash);
    var alpha = (0.20 * Math.max(atm, 0.1)).toFixed(3);
    html.style.setProperty('--accent-glow', 'rgba(' + m.glowRGB + ', ' + alpha + ')');
    html.style.setProperty('--atmosphere', atm.toFixed(2));
    html.setAttribute('data-voice', state.voice);

    var moodValEl = document.getElementById('moodVal');
    if (!moodValEl) return;
    moodValEl.textContent = m.label;
    document.getElementById('voiceVal').textContent = voiceLabel[state.voice] || 'Editorial';
    document.getElementById('atmosphereVal').textContent = state.atmosphere;
    document.querySelectorAll('#moodControl button').forEach(function (b) { b.classList.toggle('active', b.dataset.value === state.mood); });
    document.querySelectorAll('#voiceControl button').forEach(function (b) { b.classList.toggle('active', b.dataset.value === state.voice); });
    document.getElementById('atmosphereSlider').value = state.atmosphere;
  }

  function persist() {
    try { localStorage.setItem('hearth-tweaks', JSON.stringify(state)); } catch (e) {}
    try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: state }, '*'); } catch (e) {}
  }

  function wire() {
    var panel = document.getElementById('hearthTweaks');
    document.getElementById('hearthTweaksOpen').addEventListener('click', function () { panel.hidden = !panel.hidden; });
    document.getElementById('hearthTweaksClose').addEventListener('click', function () {
      panel.hidden = true;
      try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {}
    });
    document.querySelectorAll('#moodControl button').forEach(function (b) {
      b.addEventListener('click', function () { state.mood = b.dataset.value; apply(); persist(); });
    });
    document.querySelectorAll('#voiceControl button').forEach(function (b) {
      b.addEventListener('click', function () { state.voice = b.dataset.value; apply(); persist(); });
    });
    document.getElementById('atmosphereSlider').addEventListener('input', function (e) {
      state.atmosphere = +e.target.value; apply(); persist();
    });
    apply();
  }

  // Listener BEFORE announcing
  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || !d.type) return;
    var panel = document.getElementById('hearthTweaks');
    if (!panel) return;
    if (d.type === '__activate_edit_mode') panel.hidden = false;
    if (d.type === '__deactivate_edit_mode') panel.hidden = true;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      init();
      try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
    });
  } else {
    init();
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
  }
})();
