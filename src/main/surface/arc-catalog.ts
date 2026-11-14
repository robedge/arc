/**
 * SPIKE (A2UI): Arc's component catalog, as an A2UI v1.0 catalog document. The first block is a
 * pruned copy of the basic catalog's components; the second is Arc's own. Throwaway.
 */
export const ARC_CATALOG_ID = 'arc:catalog/spike-1'

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
const series = {
  oneOf: [{ type: 'array', items: point, minItems: 1, maxItems: 60 }, ref('DataBinding')]
}

const components: Record<string, Record<string, unknown>> = {
  // ---- from the A2UI basic catalog (pruned) ----
  Text: component(
    'Text',
    'A piece of text. Use h1 to h3 for headings and caption for small muted text.',
    {
      text: str,
      variant: { type: 'string', enum: ['body', 'caption', 'h1', 'h2', 'h3'], default: 'body' }
    },
    ['text']
  ),
  Column: component(
    'Column',
    'Stacks its children vertically.',
    { children: { type: 'array', items: ref('ComponentId') } },
    ['children']
  ),
  Row: component(
    'Row',
    'Places its children side by side; wraps when narrow.',
    { children: { type: 'array', items: ref('ComponentId') } },
    ['children']
  ),
  Card: component(
    'Card',
    'A bordered box around one child. Wrap several children in a Column.',
    { child: ref('Child') },
    ['child']
  ),
  Divider: component('Divider', 'A horizontal line.', {}, []),
  Button: component(
    'Button',
    'A button. `child` is a Text with the label. `action` is an Event the agent receives.',
    {
      child: ref('Child'),
      action: ref('Action'),
      variant: { type: 'string', enum: ['default', 'primary', 'borderless'], default: 'default' }
    },
    ['child', 'action']
  ),
  TextField: component(
    'TextField',
    'A text input. Bind `value` to a data path to receive what the user types.',
    {
      label: str,
      value: str,
      placeholder: str,
      variant: { type: 'string', enum: ['shortText', 'longText'], default: 'shortText' }
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
    'Pick from options. Bind `value` to a string-array data path holding the chosen option values.',
    {
      label: str,
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: str, value: { type: 'string' } },
          required: ['label', 'value'],
          additionalProperties: false
        }
      },
      value: ref('DynamicStringList'),
      variant: {
        type: 'string',
        enum: ['mutuallyExclusive', 'multipleSelection'],
        default: 'mutuallyExclusive'
      }
    },
    ['options', 'value']
  ),
  // ---- Arc's own ----
  Grid: component(
    'Grid',
    'Lays its children out in equal columns, for example a row of Stat tiles.',
    {
      children: { type: 'array', items: ref('ComponentId') },
      columns: { type: 'integer', minimum: 1, maximum: 6, default: 2 }
    },
    ['children']
  ),
  Stat: component(
    'Stat',
    'A KPI tile: a label, a big value, and optionally a change such as "+18%" with its direction and a short note.',
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
    'A highlighted notice with a title and text. `child` is an optional Button shown at its right.',
    { title: str, text: str, tone, child: ref('Child') },
    ['title']
  ),
  Badge: component('Badge', 'A small pill, for a status or a count.', { text: str, tone }, [
    'text'
  ]),
  Table: component(
    'Table',
    'A table. `columns` are the header labels; each row is a list of cells in the same order. `rows` may be bound to a data path.',
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
    'A bar chart with a value axis. `data` is a list of {label, value}, or a data path to one.',
    {
      title: str,
      subtitle: str,
      data: series,
      unit: { type: 'string', description: 'Shown after axis values, for example "reviews".' },
      orientation: { type: 'string', enum: ['vertical', 'horizontal'], default: 'vertical' }
    },
    ['data']
  ),
  LineChart: component(
    'LineChart',
    'A line chart over ordered points. `data` is a list of {label, value}, or a data path to one.',
    { title: str, subtitle: str, data: series, unit: { type: 'string' } },
    ['data']
  )
}

export const ARC_CATALOG: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ARC_CATALOG_ID,
  catalogId: ARC_CATALOG_ID,
  protocolVersion: '1.0',
  title: 'Arc catalog (spike)',
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
