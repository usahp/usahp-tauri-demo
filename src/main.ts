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
  private capturing = false;
  private overlay: ContinuousOverlay | null = null;
  private dwell = new Map<string, { count: number; total: number; last: number }>();
  private presses: number[] = [];
  private lastEventAt = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(host: HTMLElement) { this.host = host; }

  mount() {
    this.host.innerHTML = this.template();
    this.bindControls();
    this.buildScanner();
    this.setupInput();
  }

  private template(): string {
    return `
      <header class="hd">
        <h1>USAHP Switch Scanner</h1>
        <div class="hd-right">
          <button class="capture-btn" data-capture hidden>Pause capture</button>
          <div class="status" data-status>starting…</div>
        </div>
      </header>
      <main class="mn">
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
          <fieldset><legend>Switches (routed through USAHP)</legend>
            <div class="switches" data-switches></div>
            <p class="hint">In Tauri these keys are grabbed by the broker; tap a button to inject the same way. Roles can be reassigned.</p>
          </fieldset>
          <fieldset><legend>Broker activity</legend>
            <div class="stats" data-stats></div>
            <ul class="activity" data-activity></ul>
          </fieldset>
        </aside>
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
      cell.className = 'cell';
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

    // If the OS grab is installed, surface a pause/resume capture toggle.
    const capBtn = this.host.querySelector('[data-capture]') as HTMLButtonElement | null;
    if (tauriInvoke && capBtn) {
      tauriInvoke('usahp_status').then((s) => {
        const st = s as { capture_installed?: boolean; capturing?: boolean };
        if (st.capture_installed) {
          this.capturing = !!st.capturing;
          capBtn.hidden = false;
          capBtn.textContent = this.capturing ? 'Pause capture' : 'Resume capture';
        }
      });
      capBtn.addEventListener('click', async () => {
        const next = !this.capturing;
        await tauriInvoke('set_capture', { enabled: next });
        this.capturing = next;
        capBtn.textContent = next ? 'Pause capture' : 'Resume capture';
        this.setStatus(next ? 'capture resumed' : 'capture released — keys pass through');
      });
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
  .hd { display:flex; justify-content:space-between; align-items:center; padding:12px 20px; background:#222; color:#fff; }
  .hd h1 { font-size:1.1rem; margin:0; font-weight:600; }
  .hd-right { display:flex; align-items:center; gap:10px; }
  .status { font-size:.8rem; opacity:.85; }
  .capture-btn { font-size:.78rem; padding:4px 10px; border:1px solid #555; border-radius:6px; background:#333; color:#fff; cursor:pointer; }
  .capture-btn:hover { background:#444; }
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
