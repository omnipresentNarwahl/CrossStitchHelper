import type { Session } from '../stitch/session';
import { confirmDialog, h, sheet, toast } from './dom';

export interface ColourSheetOptions {
  session: Session;
  /** Palette entries were added, removed or recoloured; rebuild any swatch UI. */
  onChanged(): void;
  /** If given, each row gets a button that calls this and closes the sheet. */
  onHighlight?(index: number): void;
}

const hex = (rgb: number[]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Bottom sheet for naming, recolouring, adding and merging the pattern's colours. */
export function openColourSheet({ session, onChanged, onHighlight }: ColourSheetOptions): void {
  const pattern = session.pattern;
  const body = h('div', { class: 'sheet-body' });
  let s: { close(): void };

  const render = () => {
    body.replaceChildren(
      h('p', { class: 'muted', text: 'Name each colour (for example its thread number from the legend), change a shade, or merge a wrong colour into another one.' }),
    );
    pattern.palette.forEach((e, k) => {
      const name = (i: number) => pattern.palette[i].label || `Colour ${i + 1}`;
      const input = h('input', { class: 'text-in', attrs: { type: 'text', placeholder: `Colour ${k + 1}`, value: e.label, maxlength: '24' } });
      input.addEventListener('input', () => {
        e.label = input.value;
        session.paletteChanged();
        onChanged();
      });
      const picker = h('input', { class: 'color-in', attrs: { type: 'color', value: hex(e.rgb) } });
      picker.addEventListener('change', () => {
        const v = parseInt(picker.value.slice(1), 16);
        e.rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
        session.paletteChanged();
        onChanged();
      });
      const merge = h('select', { class: 'select', attrs: { 'aria-label': `Merge ${name(k)} into another colour` } },
        h('option', { text: 'Merge into…', attrs: { value: '' } }),
        ...pattern.palette.flatMap((_, j) => (j === k ? [] : [h('option', { text: name(j), attrs: { value: String(j) } })])),
      );
      merge.addEventListener('change', async () => {
        if (merge.value === '') return;
        const to = Number(merge.value);
        merge.value = '';
        if (!(await confirmDialog(`Turn every ${name(k)} square into ${name(to)}? This cannot be undone.`, 'Merge'))) return;
        session.mergeColor(k, to);
        onChanged();
        render();
      });
      body.append(
        h('div', { class: 'color-block' },
          h('div', { class: 'color-row' },
            picker,
            input,
            onHighlight
              ? h('button', { class: 'btn small', text: `${session.left[k]} left`, on: { click: () => { s.close(); onHighlight(k); } } })
              : h('span', { class: 'muted nowrap', text: `${session.total[k]} squares` }),
          ),
          pattern.palette.length > 1 ? merge : null,
        ),
      );
    });
    body.append(
      h('div', { class: 'row' },
        h('button', {
          class: 'btn',
          text: '+ Add colour',
          on: {
            click: () => {
              if (pattern.palette.length >= 254) return toast('That is the most colours a pattern can hold');
              session.addColor([128, 128, 128]);
              onChanged();
              render();
            },
          },
        }),
      ),
    );
  };
  render();
  s = sheet('Colours', body);
}
