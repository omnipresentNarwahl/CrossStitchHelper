type Child = Node | string | null | false | undefined;

interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

/** Tiny hyperscript helper: h('button', { class: 'btn', on: { click } }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
    if (props.style) Object.assign(el.style, props.style);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

export interface View {
  el: HTMLElement;
  destroy(): void;
}

export function toast(message: string, ms = 2200): void {
  const t = h('div', { class: 'toast', text: message });
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Bottom sheet; resolves nothing, just manages open/close. */
export function sheet(title: string, body: HTMLElement): { close(): void } {
  const backdrop = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'sheet' });
  const close = () => {
    backdrop.remove();
    box.remove();
  };
  box.append(
    h('div', { class: 'sheet-head' }, h('strong', { text: title }), h('button', { class: 'icon-btn', text: '✕', attrs: { 'aria-label': 'Close' }, on: { click: close } })),
    body,
  );
  backdrop.addEventListener('click', close);
  document.body.append(backdrop, box);
  return { close };
}

export function confirmDialog(message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = h('div', { class: 'sheet-body' }, h('p', { text: message }));
    let s: { close(): void } | null = null;
    const finish = (v: boolean) => {
      s?.close();
      resolve(v);
    };
    body.append(
      h('div', { class: 'row end' },
        h('button', { class: 'btn', text: 'Cancel', on: { click: () => finish(false) } }),
        h('button', { class: 'btn danger', text: okLabel, on: { click: () => finish(true) } }),
      ),
    );
    s = sheet('Are you sure?', body);
  });
}
