/**
 * USAHP demo — a single switch scanner whose inputs route through the USAHP
 * broker. Uses the published scan-engine class API (v0.1.x).
 *
 * In Tauri: the embedded broker grabs keys system-wide; the UsahpAdapter
 * receives them. On-screen switch buttons call inject_switch so they route
 * through the broker too — one unified path.
 *
 * In a plain browser (no broker): a KeyboardAdapter + the on-screen buttons
 * drive the GestureEngine directly, so the same UI is testable without Tauri.
 */
import {
  RowColumnScanner,
  LinearScanner,
  SnakeScanner,
  QuadrantScanner,
  EliminationScanner,
  ContinuousScanner,
  type Scanner,
  type ScanConfig,
  type ScanConfigProvider,
  type ScanSurface,
  type SwitchAction,
} from 'scan-engine';
import { ContinuousOverlay, resolveIndexAtPoint } from 'scan-engine-dom';
import { GestureEngine, UsahpAdapter, KeyboardAdapter, connectToScanner, type SwitchBindings, type SwitchInputPort } from 'switch-input';

type Role = 'select' | 'step' | 'reset' | 'cancel';
type StrategyId = 'row-column' | 'linear' | 'snake' | 'quadrant' | 'elimination' | 'continuous';
type OrderId = 'row-column' | 'linear' | 'snake' | 'quadrant' | 'elimination';
type ScanMode = 'items' | 'gliding' | 'crosshair' | 'eight-direction';

const STRATEGY_CLASSES: Record<StrategyId, new (s: ScanSurface, c: ScanConfigProvider) => Scanner> = {
  'row-column': RowColumnScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
  linear: LinearScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
  snake: SnakeScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
  quadrant: QuadrantScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
  elimination: EliminationScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
  continuous: ContinuousScanner as unknown as new (s: ScanSurface, c: ScanConfigProvider) => Scanner,
};
const STRATEGY_LABELS: Record<StrategyId, string> = {
  'row-column': 'Row–Column',
  linear: 'Linear',
  snake: 'Snake',
  quadrant: 'Quadrant',
  elimination: 'Elimination (4-colour)',
  continuous: 'Continuous (gliding)',
};

/** Elimination colours per partition (matches scan-engine-lab's convention). */
const ELIM_COLOURS: Record<string, string> = {
  switch_1: '#2196F3', // blue
  switch_2: '#F44336', // red
  switch_3: '#4CAF50', // green
  switch_4: '#FFEB3B', // yellow
};

const CONTENT: Record<string, () => string[]> = {
  Words: () => ['Hello', 'I want', 'Help', 'Yes', 'No', 'Please', 'Thank you', 'More', 'Stop', 'Go', 'Eat', 'Drink'],
  Alphabet: () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  Numbers: () => Array.from({ length: 12 }, (_, i) => String(i + 1)),
};

/** Switches the broker grabs (see default-config.toml). `code` is the browser
 * event.code used for the browser-only KeyboardAdapter fallback. */
const SWITCHES: { id: string; key: string; code: string; role: Role }[] = [
  { id: 'switch_1', key: 'Space', code: 'Space', role: 'select' },
  { id: 'switch_2', key: 'Return', code: 'Enter', role: 'step' },
  { id: 'switch_3', key: '← Left', code: 'ArrowLeft', role: 'reset' },
  { id: 'switch_4', key: '→ Right', code: 'ArrowRight', role: 'cancel' },
  { id: 'switch_5', key: 'Tab', code: 'Tab', role: 'select' },
  { id: 'switch_6', key: 'A', code: 'KeyA', role: 'step' },
];

const TAURI = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__;
const tauriInvoke = TAURI?.core?.invoke ?? null;
const inject = tauriInvoke
  ? (id: string, pressed: boolean) => tauriInvoke('inject_switch', { switchId: id, pressed })
  : null;

class DemoApp {
  private readonly host: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private items: string[] = CONTENT.Words();
  private mode: ScanMode = 'items';
  private order: OrderId = 'row-column';
  private get strategy(): StrategyId {
    return this.mode === 'items' ? this.order : 'continuous';
  }
  private readonly config = mutableConfig(baseConfig(900));

  private scanner: Scanner | null = null;
  private engine!: GestureEngine;
  private adapter: UsahpAdapter | null = null;
  private keyboard: KeyboardAdapter | null = null;
  private disconnectBridge: (() => void) | null = null;
  private captureInstalled = false;
  private focused = true;
  private paused = false;
  private handoffMode: 'focus' | 'always' | 'off' = 'focus';
  private overlay: ContinuousOverlay | null = null;
  private dwell = new Map<string, { count: number; total: number; last: number }>();
  private presses: number[] = [];
  private lastEventAt = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(host: HTMLElement) { this.host = host; }

  mount() {
    this.host.innerHTML = this.template();
    this.bindControls();
    this.bindTabs();
    this.buildScanner();
    this.setupInput();
  }

  private template(): string {
    return `
      <header class="hd">
        <h1>USAHP Switch Scanner</h1>
        <div class="hd-right">
          <span class="cap-state" data-capture-state hidden></span>
          <button class="capture-btn" data-capture hidden>Pause</button>
          <div class="status" data-status>starting…</div>
        </div>
      </header>
      <nav class="tabs">
        <button class="tab active" data-tab="scanner">Scanner</button>
        <button class="tab" data-tab="manager">USAHP Manager</button>
      </nav>
      <main class="mn" data-tabpanel="scanner">
        <section class="preview">
          <div class="grid" data-grid></div>
          <dl class="state">
            <div><dt>Highlight</dt><dd data-state="highlight">—</dd></div>
            <div><dt>Output</dt><dd data-state="output" class="out"></dd></div>
          </dl>
        </section>
        <aside class="panel">
          <fieldset><legend>Content</legend>
            <select data-ctrl="content">
              ${Object.keys(CONTENT).map((k) => `<option value="${k}">${k}</option>`).join('')}
            </select>
          </fieldset>
          <fieldset><legend>Scanning</legend>
            <label class="row"><span>Mode</span>
              <select data-ctrl="scanmode">
                <option value="items">Scan items</option>
                <option value="gliding">Gliding cursor</option>
                <option value="crosshair">Crosshair</option>
                <option value="eight-direction">Radar (8-direction)</option>
              </select>
            </label>
            <label class="row" data-order-row><span>Scan order</span>
              <select data-ctrl="order">
                <option value="row-column">Row–Column</option>
                <option value="linear">Linear</option>
                <option value="snake">Snake</option>
                <option value="quadrant">Quadrant</option>
                <option value="elimination">Elimination (4-colour)</option>
              </select>
            </label>
            <label class="row"><span>Pace</span><input type="range" min="200" max="2000" step="100" value="900" data-ctrl="rate"/><output data-out="rate">900</output></label>
            <label class="row" data-input-mode-row><span>Input mode</span>
              <select data-ctrl="mode"><option value="auto">Auto</option><option value="manual">Manual (step)</option></select>
            </label>
          </fieldset>
          <fieldset><legend>USAHP routing</legend>
            <label class="row"><span>Handoff</span>
              <select data-ctrl="handoff">
                <option value="focus">Focus (exclusive_foreground)</option>
                <option value="always">Always (primary_controller)</option>
                <option value="off">Released (passive)</option>
              </select>
            </label>
            <div class="usahp-info" data-usahp-info></div>
          </fieldset>
          <fieldset><legend>Switches (routed through USAHP)</legend>
            <div class="switches" data-switches></div>
            <p class="hint">In Tauri these keys are grabbed by the broker; tap a button to inject the same way. Roles can be reassigned.</p>
          </fieldset>
          <fieldset><legend>Broker activity</legend>
            <div class="stats" data-stats></div>
            <ul class="activity" data-activity></ul>
          </fieldset>
        </aside>
      </main>
      <main class="mn manager" data-tabpanel="manager" hidden>
        <section class="mgr-section">
          <h3>Daemon status</h3>
          <dl class="mgr-grid">
            <div><dt>Running</dt><dd data-mgr="running">—</dd></div>
            <div><dt>Port</dt><dd data-mgr="port">—</dd></div>
            <div><dt>Capture</dt><dd data-mgr="capture">—</dd></div>
            <div><dt>Switches</dt><dd data-mgr="switches">—</dd></div>
          </dl>
          <button class="mgr-refresh" data-mgr-refresh>Refresh</button>
        </section>
        <section class="mgr-section">
          <h3>Switch mappings</h3>
          <table class="mgr-table">
            <thead><tr><th>Switch</th><th>Key (click to register)</th><th>Role</th><th></th></tr></thead>
            <tbody data-mgr-rows></tbody>
          </table>
          <div class="mgr-actions">
            <button class="mgr-btn" data-mgr-add>Add switch</button>
            <button class="mgr-btn mgr-apply" data-mgr-apply>Apply changes</button>
          </div>
        </section>
        <section class="mgr-section">
          <h3>Failsafe config</h3>
          <dl class="mgr-grid">
            <div><dt>Heartbeat interval</dt><dd>500 ms</dd></div>
            <div><dt>Missed heartbeat limit</dt><dd>3 (1.5 s timeout)</dd></div>
            <div><dt>Escape hold (Trigger A)</dt><dd>4000 ms</dd></div>
            <div><dt>Arbitration timeout</dt><dd>15 s <span class="mgr-future">(Stage 3)</span></dd></div>
          </dl>
        </section>
        <section class="mgr-section">
          <h3>Output routing</h3>
          <p class="mgr-hint">Translate broker events to external apps. Grid 3 maps switch_1→Grid switch 1 (up to 8, Windows only). Keystroke lets you register a key per switch (any app that reads keyboard).</p>
          <label class="row"><span>Mode</span>
            <select data-mgr-output-mode>
              <option value="disabled">Disabled</option>
              <option value="keystroke">Keystroke</option>
              <option value="grid3">Grid 3 (Windows)</option>
            </select>
          </label>
          <table class="mgr-table" data-mgr-output-table>
            <thead><tr><th>Switch</th><th>Output key</th><th></th></tr></thead>
            <tbody data-mgr-output-rows></tbody>
          </table>
          <div class="mgr-actions">
            <button class="mgr-btn mgr-apply" data-mgr-output-apply>Apply</button>
          </div>
          <p class="mgr-hint" data-mgr-output-status hidden></p>
        </section>
        <section class="mgr-section">
          <h3>Session</h3>
          <div class="mgr-actions">
            <button class="mgr-btn" data-mgr-claim>Claim session</button>
            <button class="mgr-btn" data-mgr-release hidden>Release session</button>
          </div>
          <p class="mgr-hint">Claiming establishes a managed session (exclusive_foreground). The escape hatch fires if any switch is held > 4s. On macOS, focus loss revokes the session.</p>
          <h3>Session log</h3>
          <ul class="mgr-log" data-mgr-sessionlog></ul>
        </section>
      </main>`;
  }

  private bindControls() {
    this.host.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const ctrl = t.dataset.ctrl;
      if (!ctrl) return;
      if (ctrl === 'content') { this.items = CONTENT[t.value](); this.buildScanner(); }
      else if (ctrl === 'scanmode') {
        this.mode = t.value as ScanMode;
        this.applyModeConfig();
        this.buildScanner();
        this.reconnectBindings();
        this.renderSwitchPanel();
      }
      else if (ctrl === 'order') {
        this.order = t.value as OrderId;
        this.applyModeConfig();
        this.buildScanner();
        this.reconnectBindings();
        this.renderSwitchPanel();
      }
      else if (ctrl === 'mode') { this.config.set({ scanInputMode: t.value as ScanConfig['scanInputMode'] }); }
      else if (ctrl === 'handoff') {
        this.handoffMode = t.value as 'focus' | 'always' | 'off';
        this.updateCapture();
      }
    });
    this.host.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.ctrl === 'rate') {
        const v = Number(t.value);
        this.config.set({ scanRate: v });
        const out = this.host.querySelector('[data-out="rate"]');
        if (out) out.textContent = String(v);
      }
    });
  }

  private renderSwitchPanel() {
    const root = this.host.querySelector('[data-switches]');
    if (!root) return;
    if (this.strategy === 'continuous') {
      const cont = [
        { sw: SWITCHES[0], role: 'Select' },
        { sw: SWITCHES[1], role: 'Cancel' },
        { sw: SWITCHES[2], role: 'Reset' },
      ];
      root.innerHTML =
        cont
          .map(({ sw, role }) => `<div class="sw"><span class="sw-key">${sw.key}</span><strong style="flex:1">${role}</strong><button data-inject="${sw.id}">${role}</button></div>`)
          .join('') + `<p class="hint">Continuous: Select locks / advances the cursor, Cancel restarts.</p>`;
    } else if (this.strategy === 'elimination') {
      // 4 coloured partition buttons (no role select).
      root.innerHTML = SWITCHES.map((s) => `
        <div class="sw" data-id="${s.id}">
          <span class="sw-key">${s.key}</span>
          <button class="sw-colour" data-inject="${s.id}" style="background:${ELIM_COLOURS[s.id]};color:${s.id === 'switch_4' ? '#333' : '#fff'}">${s.id.replace('switch_', 'Sw ')}</button>
        </div>`).join('');
    } else {
      root.innerHTML = SWITCHES.map((s) => `
        <div class="sw" data-id="${s.id}">
          <span class="sw-key">${s.key}</span>
          <select data-role="${s.id}">
            ${(['select', 'step', 'reset', 'cancel'] as Role[]).map((r) => `<option value="${r}" ${r === s.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <button data-inject="${s.id}">${s.id.replace('switch_', 'Sw ')}</button>
        </div>`).join('');
      root.querySelectorAll<HTMLSelectElement>('[data-role]').forEach((sel) => {
        sel.addEventListener('change', () => {
          const id = sel.dataset.role!;
          SWITCHES.find((x) => x.id === id)!.role = sel.value as Role;
          this.reconnectBindings();
        });
      });
    }
    // On-screen buttons: route through the broker (inject) in Tauri, else drive
    // the engine directly so the browser fallback works.
    root.querySelectorAll<HTMLButtonElement>('[data-inject]').forEach((btn) => {
      const id = btn.dataset.inject!;
      const down = (ev: Event) => { ev.preventDefault(); inject ? inject(id, true) : this.engine.press(id); };
      const up = () => { inject ? inject(id, false) : this.engine.release(id); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('pointercancel', up);
    });
  }

  private bindTabs() {
    const tabs = this.host.querySelectorAll('[data-tab]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = (tab as HTMLElement).dataset.tab!;
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        this.host.querySelectorAll('[data-tabpanel]').forEach((panel) => {
          (panel as HTMLElement).hidden = (panel as HTMLElement).dataset.tabpanel !== target;
        });
        if (target === 'manager') this.refreshManager();
      });
    });
    const refreshBtn = this.host.querySelector('[data-mgr-refresh]');
    refreshBtn?.addEventListener('click', () => this.refreshManager());
    this.host.querySelector('[data-mgr-add]')?.addEventListener('click', () => {
      const nextNum = SWITCHES.length + 1;
      if (nextNum > 16) return;
      SWITCHES.push({ id: `switch_${nextNum}`, code: '', role: 'select', key: '' });
      this.renderSwitchEditor();
    });
    this.host.querySelector('[data-mgr-apply]')?.addEventListener('click', () => this.applySwitchEditor());

    // Session claim/release
    const claimBtn = this.host.querySelector('[data-mgr-claim]') as HTMLButtonElement | null;
    const releaseBtn = this.host.querySelector('[data-mgr-release]') as HTMLButtonElement | null;
    claimBtn?.addEventListener('click', async () => {
      if (!tauriInvoke) return;
      try {
        await tauriInvoke('claim_session');
      } catch (e) {
        const log = this.host.querySelector('[data-mgr-sessionlog]');
        if (log) {
          const li = document.createElement('li');
          li.textContent = `${new Date().toLocaleTimeString()} — Claim failed: ${e}`;
          log.prepend(li);
        }
      }
    });
    releaseBtn?.addEventListener('click', async () => {
      if (!tauriInvoke) return;
      try {
        await tauriInvoke('release_session');
      } catch (e) {
        const log = this.host.querySelector('[data-mgr-sessionlog]');
        if (log) {
          const li = document.createElement('li');
          li.textContent = `${new Date().toLocaleTimeString()} — Release failed: ${e}`;
          log.prepend(li);
        }
      }
    });
  }

  private async refreshManager() {
    if (!tauriInvoke) return;
    const st = (await tauriInvoke('usahp_status')) as {
      running?: boolean; port?: number; switches?: string[];
      capture_installed?: boolean; capturing?: boolean;
    };
    const set = (key: string, val: string) => {
      const el = this.host.querySelector(`[data-mgr="${key}"]`);
      if (el) el.textContent = val;
    };
    set('running', st.running ? 'Yes' : 'No');
    set('port', String(st.port ?? 7312));
    set('capture', st.capture_installed ? (st.capturing ? '● Active' : '⏸ Paused') : 'Webview');
    set('switches', (st.switches ?? []).join(', ') || '—');
    this.renderSwitchEditor();
    this.renderOutputRouting();
  }

  private renderOutputRouting() {
    const tbody = this.host.querySelector('[data-mgr-output-rows]');
    const modeSel = this.host.querySelector('[data-mgr-output-mode]') as HTMLSelectElement | null;
    if (!tbody || !modeSel) return;

    const renderRows = (mode: string) => {
      if (mode === 'grid3') {
        tbody.innerHTML = SWITCHES.slice(0, 8).map((s, i) => `
          <tr><td>${s.id}</td><td>Grid switch ${i + 1}</td><td></td></tr>`).join('');
        return;
      }
      if (mode === 'keystroke') {
        tbody.innerHTML = SWITCHES.map((s) => `
          <tr>
            <td>${s.id}</td>
            <td><input class="mgr-input mgr-key" data-output-key="${s.id}" placeholder="click, then press a key"/></td>
            <td><button class="mgr-x" data-output-clear="${s.id}">✕</button></td>
          </tr>`).join('');
        tbody.querySelectorAll<HTMLInputElement>('.mgr-key').forEach((input) => {
          input.addEventListener('keydown', (e) => {
            e.preventDefault();
            input.value = e.key.length === 1 ? e.key.toUpperCase() : e.key;
            input.dataset.keyCode = String(e.keyCode || e.which);
            input.blur();
          });
        });
        tbody.querySelectorAll('[data-output-clear]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.outputClear!;
            const input = this.host.querySelector(`[data-output-key="${id}"]`) as HTMLInputElement | null;
            if (input) { input.value = ''; delete input.dataset.keyCode; }
          });
        });
        return;
      }
      tbody.innerHTML = '<tr><td colspan="3" style="color:#999;text-align:center;padding:12px">Select a mode</td></tr>';
    };

    renderRows(modeSel.value);
    modeSel.addEventListener('change', () => renderRows(modeSel.value));

    const applyBtn = this.host.querySelector('[data-mgr-output-apply]');
    applyBtn?.addEventListener('click', async () => {
      const mode = modeSel.value;
      const statusEl = this.host.querySelector('[data-mgr-output-status]') as HTMLElement | null;
      if (mode === 'disabled') {
        if (tauriInvoke) await tauriInvoke('set_output', { mode: 'disabled', mapping: null });
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Output disabled.'; }
        return;
      }
      if (mode === 'grid3') {
        if (tauriInvoke) await tauriInvoke('set_output', { mode: 'grid3', mapping: null });
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Grid 3 output enabled (Windows only). switch_1→Grid 1, switch_2→Grid 2, etc.'; }
        return;
      }
      // keystroke mode — collect registered keys
      const mapping: Record<string, number> = {};
      this.host.querySelectorAll<HTMLInputElement>('[data-output-key]').forEach((input) => {
        const code = parseInt(input.dataset.keyCode || '0', 10);
        if (code > 0) mapping[input.dataset.outputKey!] = code;
      });
      if (Object.keys(mapping).length === 0) {
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'No keys registered — click a cell and press a key first.'; }
        return;
      }
      if (tauriInvoke) await tauriInvoke('set_output', { mode: 'keystroke', mapping });
      if (statusEl) { statusEl.hidden = false; statusEl.textContent = `Keystroke output enabled (${Object.keys(mapping).length} switches mapped).`; }
    });
  }

  private renderSwitchEditor() {
    const tbody = this.host.querySelector('[data-mgr-rows]');
    if (!tbody) return;
    const roles: Role[] = ['select', 'step', 'reset', 'cancel'];
    tbody.innerHTML = SWITCHES.map((s, i) => `
      <tr data-row="${i}">
        <td>
          <select data-field="id" class="mgr-input">
            ${Array.from({length: 8}, (_, n) => `switch_${n + 1}`).map(id =>
              `<option value="${id}" ${id === s.id ? 'selected' : ''}>${id}</option>`
            ).join('')}
          </select>
        </td>
        <td><input data-field="code" class="mgr-input mgr-key" value="${s.code}" placeholder="click, then press a key"/></td>
        <td>
          <select data-field="role" class="mgr-input">
            ${roles.map(r => `<option value="${r}" ${r === s.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </td>
        <td><button class="mgr-x" data-mgr-remove="${i}">✕</button></td>
      </tr>`).join('');

    // "Click to register" on key inputs — capture one keydown, set event.code.
    tbody.querySelectorAll<HTMLInputElement>('.mgr-key').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        e.preventDefault();
        input.value = e.code;
        input.blur();
      });
    });

    // Remove buttons
    tbody.querySelectorAll('[data-mgr-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.mgrRemove!, 10);
        SWITCHES.splice(idx, 1);
        this.renderSwitchEditor();
      });
    });
  }

  private applySwitchEditor() {
    const rows = this.host.querySelectorAll('[data-row]');
    const updated: typeof SWITCHES = [];
    rows.forEach((row) => {
      const el = row as HTMLElement;
      const id = (el.querySelector('[data-field="id"]') as HTMLSelectElement).value;
      const code = (el.querySelector('[data-field="code"]') as HTMLInputElement).value;
      const role = (el.querySelector('[data-field="role"]') as HTMLSelectElement).value as Role;
      updated.push({ id, code, role, key: code });
    });
    SWITCHES.length = 0;
    SWITCHES.push(...updated);
    // Rebuild keyboard adapter + bindings + switch panel with the new mappings.
    this.rebuildKeyboard();
    this.reconnectBindings();
    this.renderSwitchPanel();
    this.refreshManager();
  }

  private rebuildKeyboard() {
    this.keyboard?.detach();
    const keyMap: Record<string, string> = {};
    for (const s of SWITCHES) keyMap[s.code] = s.id;
    if (inject) {
      const brokerPort: SwitchInputPort = {
        press: (id: string) => { void inject(id, true); },
        release: (id: string) => { void inject(id, false); },
        disconnect: () => {},
        suspend: () => {},
      };
      this.keyboard = new KeyboardAdapter(window, brokerPort, keyMap, { preventDefaultOnBound: true });
    } else {
      this.keyboard = new KeyboardAdapter(window, this.engine, keyMap, { preventDefaultOnBound: true });
    }
  }

  private applyModeConfig() {
    const orderRow = this.host.querySelector('[data-order-row]') as HTMLElement | null;
    const inputRow = this.host.querySelector('[data-input-mode-row]') as HTMLElement | null;
    if (this.mode === 'items') {
      if (orderRow) orderRow.hidden = false;
      if (inputRow) inputRow.hidden = false;
      this.config.set({ scanPattern: this.order as ScanConfig['scanPattern'] });
      if (this.order === 'elimination') {
        // Elimination is press-driven: show all colour partitions at once.
        this.config.set({ scanInputMode: 'manual' });
        const modeSel = this.host.querySelector('[data-ctrl="mode"]') as HTMLSelectElement | null;
        if (modeSel) modeSel.value = 'manual';
      }
    } else {
      // Continuous: auto-animate (must be auto, else scheduleNextStep bails and
      // nothing moves), and scan-order / input-mode don't apply.
      if (orderRow) orderRow.hidden = true;
      if (inputRow) inputRow.hidden = true;
      this.config.set({ continuousTechnique: this.mode as ScanConfig['continuousTechnique'] });
      this.config.set({ scanInputMode: 'auto' });
    }
  }

  private buildScanner() {
    this.scanner?.stop();
    // Tear down any previous continuous overlay.
    if (this.overlay) { this.overlay.destroy(); this.overlay = null; }

    const grid = this.host.querySelector('[data-grid]') as HTMLElement;
    grid.innerHTML = '';
    this.cells.length = 0;
    this.items.forEach((label, i) => {
      const cell = document.createElement('button');
      cell.className = 'cell grid-cell';
      cell.dataset.index = String(i);
      cell.textContent = label;
      grid.appendChild(cell);
      this.cells.push(cell);
    });

    if (this.strategy === 'continuous') {
      this.overlay = new ContinuousOverlay(grid);
    }

    const surface: ScanSurface = {
      getItemsCount: () => this.cells.length,
      getColumns: () => 4,
      setFocus: (indices) => {
        for (const c of this.cells) c.classList.remove('focus');
        for (const i of indices) this.cells[i]?.classList.add('focus');
        const hl = this.host.querySelector('[data-state="highlight"]');
        if (hl) hl.textContent = indices.length ? indices.map((i) => this.items[i] ?? `#${i}`).join(', ') : '—';
      },
      setSelected: (index) => {
        const c = this.cells[index];
        if (!c) return;
        c.classList.add('selected');
        window.setTimeout(() => c.classList.remove('selected'), 250);
        this.appendOutput(this.items[index] ?? '');
      },
      getItemData: (index) => {
        const c = this.cells[index];
        return c ? { label: c.textContent ?? '', isEmpty: false } : null;
      },
      setItemStyle: (index, style) => {
        const c = this.cells[index];
        if (!c) return;
        if (style.backgroundColor !== undefined) c.style.backgroundColor = style.backgroundColor;
        if (style.textColor !== undefined) c.style.color = style.textColor;
        if (style.borderColor !== undefined) c.style.borderColor = style.borderColor;
        if (style.borderWidth !== undefined) c.style.borderWidth = `${style.borderWidth}px`;
        if (style.boxShadow !== undefined) c.style.boxShadow = style.boxShadow;
        if (style.opacity !== undefined) c.style.opacity = String(style.opacity);
      },
      clearItemStyles: () => {
        for (const c of this.cells) {
          c.style.backgroundColor = '';
          c.style.color = '';
          c.style.borderColor = '';
          c.style.borderWidth = '';
          c.style.boxShadow = '';
          c.style.opacity = '';
        }
      },
      getContainerElement: () => grid,
      resolveIndexAtPoint: (xPercent, yPercent) => resolveIndexAtPoint(grid, xPercent, yPercent),
    };

    type Cb = { onContinuousUpdate?: (state: import('scan-engine').ContinuousUpdate) => void };
    const callbacks: Cb =
      this.strategy === 'continuous'
        ? { onContinuousUpdate: (st) => this.overlay?.update(st) }
        : {};
    const ScanCtor = STRATEGY_CLASSES[this.strategy] as unknown as new (
      s: ScanSurface,
      c: ScanConfigProvider,
      cb?: Cb,
    ) => Scanner;

    this.scanner = new ScanCtor(surface, this.config.provider, callbacks);
    this.scanner.start();
  }

  private setupInput() {
    this.engine = new GestureEngine({ tapWindowMs: 250, holdThresholdMs: 1000 });
    this.reconnectBindings();

    const keyMap: Record<string, string> = {};
    for (const s of SWITCHES) keyMap[s.code] = s.id;

    // USAHP adapter drives the engine from the embedded broker (Tauri), or
    // retries disconnected in a browser.
    this.adapter = new UsahpAdapter(this.engine, {
      onStatus: (st) => this.setStatus(`broker: ${st}`),
      onSwitches: () => this.setStatus('broker: connected'),
    });

    if (inject) {
      // Tauri: the broker's own global grab is disabled (rdev/macOS trap), so we
      // capture keys here and route them THROUGH the broker — KeyboardAdapter →
      // inject_switch → broker → UsahpAdapter → engine. Same path on-screen
      // buttons take; the engine is driven only by the adapter.
      const brokerPort = {
        press: (id: string) => { void inject(id, true); },
        release: (id: string) => { void inject(id, false); },
        disconnect: () => {},
        suspend: () => {},
      };
      this.keyboard = new KeyboardAdapter(window, brokerPort as unknown as import('switch-input').SwitchInputPort, keyMap, { preventDefaultOnBound: true });
    } else {
      // Browser fallback: keyboard drives the engine directly (no broker).
      this.keyboard = new KeyboardAdapter(window, this.engine, keyMap, { preventDefaultOnBound: true });
    }

    // Log switch activity flowing through the engine (broker-routed in Tauri).
    this.engine.on('press', (e) => { this.logActivity(e.switchId, 'press'); this.recordPress(); });
    this.engine.on('release', (e) => { this.logActivity(e.switchId, 'release'); this.recordDwell(e.switchId, e.durationMs); });
    this.renderStats();
    this.statsTimer = setInterval(() => this.renderStats(), 1000);

    this.renderSwitchPanel();

    // USAHP handoff (exclusive_foreground): when the OS grab is installed, capture
    // follows window focus — focused → app grabs the switches, blurred → keys pass
    // to the OS / Switch Control. A Pause button overrides (hold capture off).
    if (tauriInvoke) {
      tauriInvoke('usahp_status').then((s) => {
        const st = s as { capture_installed?: boolean; port?: number; switches?: string[]; running?: boolean };
        this.captureInstalled = !!st.capture_installed;
        const info = this.host.querySelector('[data-usahp-info]');
        if (info && st.running) {
          info.textContent = `ws://127.0.0.1:${st.port ?? 7312} · ${(st.switches ?? []).length} switches registered`;
        }
        if (this.captureInstalled) {
          const btn = this.host.querySelector('[data-capture]') as HTMLButtonElement | null;
          if (btn) btn.hidden = false;
          this.focused = true;
          this.paused = false;
          this.updateCapture();
        } else {
          const ind = this.host.querySelector('[data-capture-state]') as HTMLElement | null;
          if (ind) {
            ind.hidden = false;
            ind.textContent = '○ Inject mode';
            ind.style.color = '#2196f3';
          }
        }
      });
      const tauriListen = (window as unknown as {
        __TAURI__?: { event?: { listen: (ev: string, cb: (e: { payload: boolean }) => void) => Promise<() => void> } };
      }).__TAURI__?.event?.listen;
      if (tauriListen) {
        tauriListen('usahp-focus', (e) => { this.focused = !!e.payload; this.updateCapture(); });
      }
      // Listen for session lifecycle events from the backend monitor.
    if (tauriListen) {
      tauriListen('usahp-session-event', (e) => {
        const payload = String(e.payload);
        const log = this.host.querySelector('[data-mgr-sessionlog]');
        if (log) {
          const li = document.createElement('li');
          const t = new Date().toLocaleTimeString();
          li.textContent = `${t} — ${payload}`;
          log.prepend(li);
          while (log.children.length > 20) log.removeChild(log.lastChild!);
        }
        // Toggle Claim/Release buttons based on session state.
        const claimBtn = this.host.querySelector('[data-mgr-claim]') as HTMLButtonElement | null;
        const releaseBtn = this.host.querySelector('[data-mgr-release]') as HTMLButtonElement | null;
        if (payload.includes('claimed') || payload.includes('Accepted')) {
          if (claimBtn) claimBtn.hidden = true;
          if (releaseBtn) releaseBtn.hidden = false;
        } else if (payload.includes('revoked') || payload.includes('Released')) {
          if (claimBtn) claimBtn.hidden = false;
          if (releaseBtn) releaseBtn.hidden = true;
        }
      });
    }

    const capBtn = this.host.querySelector('[data-capture]') as HTMLButtonElement | null;
      capBtn?.addEventListener('click', () => { this.paused = !this.paused; this.updateCapture(); });
    }

    this.setStatus(inject ? 'Tauri — broker routing' : 'Browser — direct (no broker)');
  }

  private logActivity(switchId: string, action: string) {
    const list = this.host.querySelector('[data-activity]');
    if (!list) return;
    const li = document.createElement('li');
    li.textContent = `${switchId} · ${action}`;
    li.className = `act act-${action}`;
    list.prepend(li);
    while (list.children.length > 8) list.removeChild(list.lastChild!);
  }

  private recordPress() {
    const now = performance.now();
    this.presses.push(now);
    this.lastEventAt = now;
    this.renderStats();
  }

  private recordDwell(id: string, ms: number) {
    const d = this.dwell.get(id) ?? { count: 0, total: 0, last: 0 };
    d.count += 1;
    d.total += ms;
    d.last = ms;
    this.dwell.set(id, d);
    this.lastEventAt = performance.now();
    this.renderStats();
  }

  private renderStats() {
    const el = this.host.querySelector('[data-stats]');
    if (!el) return;
    const now = performance.now();
    this.presses = this.presses.filter((t) => now - t < 60_000);
    const rate = this.presses.length; // presses in the last 60s ≈ /min
    const ageS = this.lastEventAt ? (now - this.lastEventAt) / 1000 : -1;
    const last = ageS < 0 ? '—' : ageS < 1 ? 'now' : `${Math.floor(ageS)}s ago`;
    const rows = SWITCHES.map((s) => {
      const d = this.dwell.get(s.id);
      const label = s.id.replace('switch_', 'sw');
      if (!d || d.count === 0) return `<span class="stat-mute">${label} —</span>`;
      const avg = Math.round(d.total / d.count);
      return `<span><b>${label}</b> ${avg}ms (${d.count})</span>`;
    }).join(' · ');
    el.innerHTML = `<div><b>${rate}</b>/min · last ${last}</div><div class="dwell">${rows}</div>`;
  }

  private reconnectBindings() {
    this.disconnectBridge?.();
    const bindings: SwitchBindings = {};
    if (this.strategy === 'elimination') {
      // Each physical switch selects its coloured partition directly.
      for (const s of SWITCHES) bindings[s.id] = { press: `switch-${s.id.slice(-1)}` as SwitchAction };
    } else if (this.strategy === 'continuous') {
      // Select locks/advances; Cancel restarts; Reset clears.
      bindings['switch_1'] = { press: 'select' };
      bindings['switch_2'] = { press: 'cancel' };
      bindings['switch_3'] = { press: 'reset' };
    } else {
      for (const s of SWITCHES) bindings[s.id] = { press: s.role };
    }
    const proxy = { handleAction: (a: SwitchAction) => this.scanner?.handleAction(a) };
    this.disconnectBridge = connectToScanner(this.engine, proxy, bindings);
  }

  private appendOutput(text: string) {
    if (!text) return;
    const el = this.host.querySelector('[data-state="output"]');
    if (el) el.textContent = (el.textContent || '') + text + ' ';
  }

  private setStatus(text: string) {
    const el = this.host.querySelector('[data-status]');
    if (el) el.textContent = text;
  }

  private async updateCapture() {
    if (!this.captureInstalled) return;
    let effective: boolean;
    let label: string;
    let color: string;
    if (this.paused) {
      effective = false;
      label = '⏸ Paused';
      color = '#ff9800';
    } else if (this.handoffMode === 'off') {
      effective = false;
      label = '○ Released';
      color = '#999';
    } else if (this.handoffMode === 'always') {
      effective = true;
      label = '● Always (primary)';
      color = '#4caf50';
    } else {
      effective = this.focused;
      label = this.focused ? '● App control' : '○ System';
      color = this.focused ? '#4caf50' : '#999';
    }
    const ind = this.host.querySelector('[data-capture-state]') as HTMLElement | null;
    if (tauriInvoke) {
      try {
        await tauriInvoke('set_capture', { enabled: effective });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(`capture error: ${message}`);
        if (ind) {
          ind.hidden = false;
          ind.textContent = 'Capture error';
          ind.style.color = '#c62828';
        }
        return;
      }
    }
    if (ind) {
      ind.hidden = false;
      ind.textContent = label;
      ind.style.color = color;
    }
    const btn = this.host.querySelector('[data-capture]') as HTMLButtonElement | null;
    if (btn) btn.textContent = this.paused ? 'Resume' : 'Pause';
  }
}

function baseConfig(rate: number): ScanConfig {
  return {
    scanRate: rate,
    scanInputMode: 'auto',
    scanDirection: 'circular',
    scanPattern: 'row-column',
    scanTechnique: 'block',
    scanMode: null,
    continuousTechnique: 'crosshair',
    compassMode: 'continuous',
    eliminationSwitchCount: 4,
    allowEmptyItems: false,
    initialItemPause: 0,
    scanLoops: 0,
    criticalOverscan: { enabled: false, fastRate: 100, slowRate: 1000 },
    colorCode: { errorRate: 0.1, selectThreshold: 0.95 },
  };
}

function mutableConfig(initial: ScanConfig) {
  let current = initial;
  const provider: ScanConfigProvider = { get: () => current };
  return { provider, set: (o: Partial<ScanConfig>) => { current = { ...current, ...o }; } };
}

const style = document.createElement('style');
style.textContent = `
  [hidden] { display: none !important; }
  .tabs { display:flex; gap:0; background:#222; padding:0 16px; }
  .tab { padding:8px 20px; border:none; background:transparent; color:#999; font-size:.9rem; cursor:pointer; border-bottom:2px solid transparent; }
  .tab.active { color:#fff; border-bottom-color:#16845b; }
  .tab:hover { color:#ccc; }
  .manager { display:flex; flex-direction:column; gap:20px; padding:20px; background:#fff; border-radius:0 0 10px 10px; }
  .mgr-section { border:1px solid #eee; border-radius:8px; padding:16px; }
  .mgr-section h3 { margin:0 0 12px; font-size:1rem; }
  .mgr-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin:0; }
  .mgr-grid dt { font-size:.75rem; color:#888; }
  .mgr-grid dd { margin:2px 0 0; font-weight:600; font-size:.9rem; }
  .mgr-table { width:100%; border-collapse:collapse; font-size:.85rem; }
  .mgr-table th, .mgr-table td { text-align:left; padding:6px 10px; border-bottom:1px solid #eee; }
  .mgr-table th { color:#888; font-weight:600; }
  .mgr-refresh { margin-top:12px; padding:6px 16px; border:1px solid #16845b; border-radius:6px; background:#16845b; color:#fff; cursor:pointer; font-size:.85rem; }
  .mgr-refresh:hover { background:#0f6b47; }
  .mgr-input { padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:.82rem; width:100%; box-sizing:border-box; }
  .mgr-key { font-family:monospace; cursor:pointer; }
  .mgr-key:focus { border-color:#16845b; outline:none; }
  .mgr-x { padding:2px 8px; border:none; background:transparent; color:#f44336; cursor:pointer; font-size:1rem; }
  .mgr-x:hover { background:#ffe0e0; border-radius:4px; }
  .mgr-actions { display:flex; gap:8px; margin-top:10px; }
  .mgr-btn { padding:6px 14px; border:1px solid #ccc; border-radius:6px; background:#f8f8f8; cursor:pointer; font-size:.85rem; }
  .mgr-btn:hover { background:#f0f0f0; }
  .mgr-apply { background:#16845b; color:#fff; border-color:#16845b; }
  .mgr-apply:hover { background:#0f6b47; }
  .mgr-log { list-style:none; margin:0; padding:0; max-height:200px; overflow:auto; font-family:monospace; font-size:.75rem; }
  .mgr-log li { padding:3px 0; color:#666; border-bottom:1px solid #f5f5f5; }
  .mgr-future { font-size:.7rem; color:#bbb; font-style:italic; }
  .mgr-hint { font-size:.78rem; color:#888; margin:0 0 10px; line-height:1.4; }
  .mgr-keycode { font-family:monospace; font-size:.75rem; color:#888; }
  .hd { display:flex; justify-content:space-between; align-items:center; padding:12px 20px; background:#222; color:#fff; }
  .hd h1 { font-size:1.1rem; margin:0; font-weight:600; }
  .hd-right { display:flex; align-items:center; gap:10px; }
  .status { font-size:.8rem; opacity:.85; }
  .capture-btn { font-size:.78rem; padding:4px 10px; border:1px solid #555; border-radius:6px; background:#333; color:#fff; cursor:pointer; }
  .capture-btn:hover { background:#444; }
  .cap-state { font-size:.78rem; font-weight:600; }
  .mn { display:grid; grid-template-columns: 1fr 320px; gap:16px; padding:16px; }
  .preview { background:#fff; border-radius:10px; padding:16px; }
  .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; min-height:300px; position:relative; }
  .cell { padding:18px 8px; font-size:1rem; background:#eef0f3; border:2px solid transparent; border-radius:8px; cursor:default; }
  .cell.focus { border-color:#ff9800; background:#fff3e0; }
  .cell.selected { background:#4caf50; color:#fff; }
  .state { display:flex; gap:18px; margin-top:14px; font-size:.85rem; }
  .state dt { color:#888; margin:0; }
  .state dd { margin:2px 0 0; font-weight:600; }
  .state .out { color:#2196f3; }
  .panel { background:#fff; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:12px; }
  .panel fieldset { border:1px solid #e0e0e0; border-radius:8px; padding:10px; }
  .panel legend { font-size:.8rem; font-weight:600; color:#555; padding:0 4px; }
  .panel select, .panel input[type=range] { width:100%; }
  .row { display:flex; align-items:center; gap:8px; margin-top:8px; }
  .row output { min-width:42px; text-align:right; font-size:.8rem; }
  .switches { display:flex; flex-direction:column; gap:6px; }
  .sw { display:grid; grid-template-columns: 64px 1fr auto; gap:8px; align-items:center; }
  .sw-key { font-family:monospace; font-size:.75rem; background:#f0f0f0; padding:2px 6px; border-radius:4px; text-align:center; }
  .sw button { padding:6px 10px; border:1px solid #ccc; border-radius:6px; background:#fafafa; cursor:pointer; }
  .sw button:active { background:#ff9800; color:#fff; }
  .hint { font-size:.72rem; color:#999; margin:.4em 0 0; line-height:1.3; }
  .usahp-info { font-size:.72rem; color:#888; margin-top:4px; font-family:monospace; }
  .activity { list-style:none; margin:0; padding:0; max-height:130px; overflow:auto; font-family:monospace; font-size:.72rem; }
  .activity li { padding:2px 0; color:#888; border-bottom:1px solid #f2f2f2; }
  .act-press { color:#2196f3; }
  .act-release { color:#999; }
  .stats { font-size:.72rem; color:#666; margin-bottom:6px; line-height:1.5; }
  .stats b { color:#2196f3; }
  .stats .dwell { color:#888; }
  .stat-mute { color:#ccc; }
  @media (max-width: 800px) { .mn { grid-template-columns: 1fr; } }
`;
document.head.appendChild(style);

new DemoApp(document.getElementById('app')!).mount();
