/**
 * Arc's component catalog, as an A2UI v1.0 catalog document. The first block is a pruned copy of
 * the basic catalog's components; the second is Arc's own.
 */
export const ARC_CATALOG_ID = 'arc:catalog/1'

const ref = (name: string): { $ref: string } => ({ $ref: `common_types.json#/$defs/${name}` })
const str = ref('DynamicString')
const tone = { type: 'string', enum: ['neutral', 'info', 'positive', 'warning', 'danger'] }

function component(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: 'object',
    description,
    properties: { component: { const: name }, ...properties },
    required: ['component', ...required],
    additionalProperties: false
  }
}

const point = {
  type: 'object',
  properties: { label: { type: 'string' }, value: { type: 'number' } },
  required: ['label', 'value'],
  additionalProperties: false
}
/**
 * Compiled JSON shape of the properties added for spec 014 (what the renderer reads):
 * - `ChoicePicker.overriddenBy`: a binding, `{ "@path": "/other" }`; written `overriddenBy=$/other`.
 * - `Button.requires`: a list; each entry is a binding or a list of alternative bindings,
 *   `[{ "@path": "/a" }, [{ "@path": "/b" }, { "@path": "/c" }]]`; written `requires=[$/a, [$/b, $/c]]`.
 *   Plain strings are refused. The signature marks it (static) only because the SDK does.
 * - `TextField.submit`: the id of a Button as a plain string, `"go"`; written `submit="go"`, so the
 *   Button must be assigned to a variable of that name (an inline Button would be orphaned).
 * - `ChoicePicker.display`, `Text.maxLines`, `CodeBlock.maxLines/maxChars`: plain literals.
 */
const path = ref('DataBinding')
const series = {
  oneOf: [{ type: 'array', items: point, minItems: 1, maxItems: 60 }, ref('DataBinding')]
}

const components: Record<string, Record<string, unknown>> = {
  // ---- from the A2UI basic catalog (pruned) ----
  Text: component(
    'Text',
    'Text. h1 to h3 are headings; caption is small and muted. Longer than `maxLines` it is cut with "Show more".',
    {
      text: str,
      variant: { type: 'string', enum: ['body', 'caption', 'h1', 'h2', 'h3'], default: 'body' },
      maxLines: { type: 'integer', minimum: 1, maximum: 100 }
    },
    ['text']
  ),
  Column: component(
    'Column',
    'Children stacked vertically.',
    { children: { type: 'array', items: ref('ComponentId') } },
    ['children']
  ),
  Row: component(
    'Row',
    'Children side by side.',
    { children: { type: 'array', items: ref('ComponentId') } },
    ['children']
  ),
  Card: component('Card', 'A bordered box around one child.', { child: ref('Child') }, ['child']),
  Divider: component('Divider', 'A horizontal line.', {}, []),
  Button: component(
    'Button',
    'A button. `child` is a Text label. `action` is an Event. Unavailable until each `requires` entry has text at one of its paths.',
    {
      child: ref('Child'),
      action: ref('Action'),
      variant: { type: 'string', enum: ['default', 'primary', 'borderless'], default: 'default' },
      requires: { type: 'array', items: { oneOf: [path, { type: 'array', items: path }] } }
    },
    ['child', 'action']
  ),
  TextField: component(
    'TextField',
    'A text input. Bind `value` to a data path. Enter runs the Button named by `submit`.',
    {
      label: str,
      value: str,
      placeholder: str,
      variant: { type: 'string', enum: ['shortText', 'longText'], default: 'shortText' },
      submit: { type: 'string' }
    },
    ['label']
  ),
  CheckBox: component(
    'CheckBox',
    'A checkbox. Bind `value` to a boolean data path.',
    { label: str, value: ref('DynamicBoolean') },
    ['label', 'value']
  ),
  ChoicePicker: component(
    'ChoicePicker',
    'Pick from options. `value` is a string-array path holding the picks. Picks show as unselected while `overriddenBy` has text.',
    {
      label: str,
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: str, value: { type: 'string' }, description: str },
          required: ['label', 'value'],
          additionalProperties: false
        }
      },
      value: ref('DynamicStringList'),
      variant: {
        type: 'string',
        enum: ['mutuallyExclusive', 'multipleSelection'],
        default: 'mutuallyExclusive'
      },
      display: { type: 'string', enum: ['buttons', 'radio'], default: 'buttons' },
      overriddenBy: path
    },
    ['options', 'value']
  ),
  // ---- Arc's own ----
  Grid: component(
    'Grid',
    'Equal columns, for example Stat tiles.',
    {
      children: { type: 'array', items: ref('ComponentId') },
      columns: { type: 'integer', minimum: 1, maximum: 6, default: 2 }
    },
    ['children']
  ),
  CodeBlock: component(
    'CodeBlock',
    'Monospace text. Longer than `maxLines` or `maxChars` it is cut with "Show more".',
    {
      text: str,
      maxLines: { type: 'integer', minimum: 1, maximum: 100 },
      maxChars: { type: 'integer', minimum: 1, maximum: 20000 }
    },
    ['text']
  ),
  KeyValue: component(
    'KeyValue',
    'Labelled values; a value is a string or a list of strings.',
    {
      items: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            label: str,
            value: { oneOf: [str, { type: 'array', items: str, maxItems: 50 }] }
          },
          required: ['label', 'value'],
          additionalProperties: false
        }
      }
    },
    ['items']
  ),
  Stat: component(
    'Stat',
    'A KPI tile: label, big value, optional change like "+18%", trend and note.',
    {
      label: str,
      value: str,
      delta: str,
      trend: { type: 'string', enum: ['up', 'down', 'flat'] },
      note: str,
      tone
    },
    ['label', 'value']
  ),
  Callout: component(
    'Callout',
    'A notice with a title and text. `child` is an optional Button at its right.',
    { title: str, text: str, tone, child: ref('Child') },
    ['title']
  ),
  Badge: component('Badge', 'A small pill, for a status or a count.', { text: str, tone }, [
    'text'
  ]),
  Table: component(
    'Table',
    'A table. `columns` are headers; each row is a list of cells in order. `rows` may be a data path.',
    {
      columns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
      rows: {
        oneOf: [
          {
            type: 'array',
            maxItems: 100,
            items: { type: 'array', items: { type: ['string', 'number', 'boolean'] } }
          },
          ref('DataBinding')
        ]
      }
    },
    ['columns', 'rows']
  ),
  BarChart: component(
    'BarChart',
    'A bar chart. `data` is a list of {label, value} or a data path.',
    {
      title: str,
      subtitle: str,
      data: series,
      unit: { type: 'string' },
      orientation: { type: 'string', enum: ['vertical', 'horizontal'], default: 'vertical' }
    },
    ['data']
  ),
  LineChart: component(
    'LineChart',
    'A line chart. `data` is a list of {label, value} or a data path.',
    { title: str, subtitle: str, data: series, unit: { type: 'string' } },
    ['data']
  )
}

/** The component names a surface may use. */
export const ARC_COMPONENT_NAMES: ReadonlySet<string> = new Set(Object.keys(components))

export const ARC_CATALOG: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ARC_CATALOG_ID,
  catalogId: ARC_CATALOG_ID,
  protocolVersion: '1.0',
  title: 'Arc catalog',
  description: 'Layout, inputs, KPI tiles, tables and charts drawn by Arc.',
  instructions:
    'Use Column and Row for layout and Grid for equal columns. There are no functions: do not concatenate or format strings, write the final text. Never draw charts or tables from text characters; use BarChart, LineChart and Table.',
  components,
  functions: {},
  $defs: {
    anyComponent: {
      oneOf: Object.keys(components).map((name) => ({ $ref: `#/components/${name}` })),
      discriminator: { propertyName: 'component' }
    },
    anyFunction: { oneOf: [] }
  }
}
