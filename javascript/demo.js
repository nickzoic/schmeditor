/*! Demo page for schmeditor: the example schemas and the page wiring. */

// ---- Example 1: a contact schema that uses every supported keyword
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Contact',
  description: 'One schema that exercises every keyword the editor supports. Field hints name the keyword on show.',
  type: 'object',
  required: ['name', 'tags'],
  // additionalProperties at the root: any extra property must be a string, number or boolean
  additionalProperties: { type: ['string', 'number', 'boolean'] },
  properties: {
    name: { type: 'string', minLength: 2, default: 'Unnamed', description: 'required, minLength: at least two characters.' },
    username: { type: 'string', minLength: 3, default: 'ada', not: { enum: ['admin', 'root'] }, description: 'not: “admin” and “root” are forbidden.' },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, minItems: 1, maxItems: 5, description: 'items, uniqueItems, minItems, maxItems: 1 to 5 unique tags.' },
    role: { enum: ['customer', 'partner', 'staff'], description: 'enum, plus if/then at the root: “staff” adds a required department.' },
    nickname: { type: ['string', 'null'], description: 'A type array: string or null.' },
    address: { $ref: '#/$defs/address', description: '$ref by JSON pointer.' },

    strings: {
      title: 'Strings and formats', type: 'object',
      properties: {
        code: { type: 'string', minLength: 3, maxLength: 8, pattern: '^[A-Z0-9]+$', default: 'ABC', description: 'minLength, maxLength, pattern: 3 to 8 capitals or digits.' },
        bio: { type: 'string', maxLength: 300, default: 'Hello.', description: 'maxLength above 200 gives a text area.' },
        email: { type: 'string', format: 'email', title: 'email (format)' },
        website: { type: 'string', format: 'uri', title: 'website (uri)' },
        birthday: { type: 'string', format: 'date', title: 'birthday (date)' },
        lastSeen: { type: 'string', format: 'date-time', title: 'lastSeen (date-time)' },
        alarm: { type: 'string', format: 'time', title: 'alarm (time)' },
        id: { type: 'string', format: 'uuid', title: 'id (uuid)' },
        ip: { type: 'string', format: 'ipv4', title: 'ip (ipv4)' }
      }
    },

    numbers: {
      title: 'Numbers', type: 'object',
      properties: {
        quantity: { type: 'integer', minimum: 1, maximum: 99, default: 1, description: 'integer, minimum, maximum: 1 to 99.' },
        rating: { type: 'number', minimum: 0, maximum: 5, multipleOf: 0.5, description: 'multipleOf: halves from 0 to 5.' },
        ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.05, description: 'exclusiveMinimum and exclusiveMaximum: strictly between 0 and 1.' },
        even: { type: 'integer', multipleOf: 2, default: 2, description: 'multipleOf 2.' }
      }
    },

    arrays: {
      title: 'Arrays', type: 'object',
      properties: {
        location: {
          title: 'Location', type: 'array', default: [-37.8136, 144.9631],
          prefixItems: [{ type: 'number', minimum: -90, maximum: 90 }, { type: 'number', minimum: -180, maximum: 180 }],
          items: false, minItems: 2,
          description: 'prefixItems with items: false: a fixed [latitude, longitude] pair.'
        },
        legacy: {
          title: 'Legacy tuple', type: 'array', default: ['a', 1], minItems: 2,
          items: [{ type: 'string' }, { type: 'integer' }], additionalItems: { type: 'boolean' },
          description: 'Tuple items plus additionalItems: string, integer, then any number of booleans.'
        },
        milestones: {
          title: 'Milestones', type: 'array', items: { type: 'integer' }, default: [100],
          contains: { minimum: 100 }, minContains: 1, maxContains: 2,
          description: 'contains, minContains, maxContains: one or two values must be 100 or more.'
        }
      }
    },

    objects: {
      title: 'Objects', type: 'object',
      properties: {
        labels: {
          type: 'object', default: { team: 'core' },
          additionalProperties: { type: 'string' },
          propertyNames: { pattern: '^[a-z][a-z0-9_]*$', maxLength: 20 },
          minProperties: 1, maxProperties: 4,
          description: 'additionalProperties, propertyNames, minProperties, maxProperties: 1 to 4 lowercase keys with string values.'
        },
        limits: {
          type: 'object', default: { max_items: 10, flag_beta: true },
          patternProperties: { '^max_': { type: 'integer', minimum: 0 }, '^flag_': { type: 'boolean' } },
          additionalProperties: false,
          description: 'patternProperties with additionalProperties: false. Keys must start with max_ or flag_.'
        },
        scratch: { title: 'Free-form', type: 'object', default: { note: 'anything goes' }, description: 'No constraints: values can be any JSON type.' }
      }
    },

    billing: {
      title: 'Dependencies', type: 'object',
      properties: {
        card: { type: 'string', minLength: 4, default: '4242', description: 'dependentRequired: a card needs an expiry.' },
        cardExpiry: { type: 'string', pattern: '^[0-9]{2}/[0-9]{2}$', default: '01/30', description: 'MM/YY' },
        gift: { type: 'boolean', description: 'dependentSchemas: a gift needs a message.' },
        giftMessage: { type: 'string', minLength: 1, default: 'Happy birthday!' },
        phone: { type: 'string', default: '0400 000 000', description: 'dependencies (legacy array form): a phone needs a type.' },
        phoneType: { enum: ['mobile', 'landline'] }
      },
      dependentRequired: { card: ['cardExpiry'] },
      dependentSchemas: { gift: { required: ['giftMessage'] } },
      dependencies: { phone: ['phoneType'] }
    },

    shipping: {
      title: 'Shipping', type: 'object', required: ['method'],
      properties: {
        method: { enum: ['pickup', 'delivery'], description: 'if/then/else: delivery requires a street, pickup requires a store.' },
        street: { type: 'string', default: 'Main St' },
        store: { type: 'string', default: 'Central' }
      },
      if: { properties: { method: { const: 'delivery' } } },
      then: { required: ['street'] },
      else: { required: ['store'] }
    },

    composition: {
      title: 'Composition and references', type: 'object',
      properties: {
        entity: {
          title: 'Entity',
          description: 'allOf: three schemas merged, one through $ref. “kind” is a const.',
          allOf: [
            { $ref: '#/$defs/named' },
            { $ref: '#/$defs/timestamped' },
            { type: 'object', required: ['kind'], properties: { kind: { const: 'entity' } } }
          ]
        },
        reach: {
          title: 'Preferred contact',
          description: 'anyOf: an email, a phone number, or a mailing address (a $ref by anchor).',
          anyOf: [
            { title: 'Email address', type: 'string', format: 'email' },
            { title: 'Phone number', type: 'string', pattern: '^\\+?[0-9 ]{6,15}$', default: '+61 400 000 000' },
            { title: 'Mailing address', $ref: '#postal' }
          ]
        },
        pet: {
          description: 'oneOf: exactly one alternative must match.',
          oneOf: [
            { title: 'Dog', type: 'object', required: ['good'], properties: { good: { type: 'boolean' } } },
            { title: 'Fish', type: 'object', required: ['fins'], properties: { fins: { type: 'integer', minimum: 1 } } }
          ]
        },
        externalId: { type: ['string', 'integer'], description: 'A type array: string or integer.' },
        priority: { enum: [1, 2, 3, 'urgent', null], description: 'enum with mixed types.' },
        referrals: { type: 'array', items: { $ref: '#' }, maxItems: 3, description: '$ref “#”: each referral is a whole Contact.' },
        relatives: { type: 'array', items: { $ref: '#/$defs/person' }, description: 'A recursive $ref: people with relatives.' }
      }
    }
  },
  if: { required: ['role'], properties: { role: { const: 'staff' } } },
  then: { required: ['department'], properties: { department: { type: 'string', default: 'Operations' } } },
  $defs: {
    address: {
      $anchor: 'postal', title: 'Address', type: 'object', required: ['postcode'],
      properties: {
        street: { type: 'string' },
        postcode: { type: 'string', pattern: '^[0-9]{4}$', default: '3000', description: 'Four digits.' }
      }
    },
    named: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string', format: 'uuid', default: '3f2b8c1e-9d4a-4e6b-8a1f-2c7d5e9b0a13' }, label: { type: 'string', default: 'Untitled' } } },
    timestamped: { type: 'object', required: ['created'], properties: { created: { type: 'string', format: 'date-time', default: '2024-01-01T00:00:00Z' }, updated: { type: 'string', format: 'date' } } },
    person: { type: 'object', required: ['name'], properties: { name: { type: 'string', default: 'Someone' }, relatives: { type: 'array', items: { $ref: '#/$defs/person' } } } }
  }
};

const initial = {
  name: 'Ada', username: 'ada', tags: ['math', 'engines'], role: 'customer', nickname: null,
  address: { postcode: '3000' },
  strings: { code: 'ABC123', email: 'ada@example.com' },
  numbers: { quantity: 3, rating: 4.5 },
  arrays: { location: [-37.8136, 144.9631], legacy: ['x', 2, true], milestones: [50, 100] },
  objects: { labels: { team: 'core' }, limits: { max_items: 10, flag_beta: true }, scratch: { note: 'anything goes', count: 3 } },
  billing: { card: '4242', cardExpiry: '01/30' },
  shipping: { method: 'pickup', store: 'Central' },
  composition: {
    entity: { kind: 'entity', id: '3f2b8c1e-9d4a-4e6b-8a1f-2c7d5e9b0a13', label: 'Analytical Engine', created: '1843-10-01T00:00:00Z' },
    reach: 'ada@example.com',
    pet: { good: true },
    externalId: 42,
    priority: 'urgent',
    referrals: [],
    relatives: [{ name: 'Charles', relatives: [{ name: 'Annabella' }] }]
  }
};

// ---- Example 2: a metaschema, so the editor can edit schemas (and build a form from them)
// A metaschema for exactly the JSON Schema features SchemaEditor supports.
// A schema is true/false, or an object of one "kind". Each kind lists only the keywords
// that apply to it, and additionalProperties:false stops unsupported keywords creeping in.
const metaschema = (() => {
  const S = { $ref: '#/$defs/schema' };                       // any schema (recursive)
  const schemaList = { type: 'array', items: S, minItems: 1 };
  const strings = { type: 'array', items: { type: 'string', minLength: 1, default: 'name' }, uniqueItems: true };
  const count = { type: 'integer', minimum: 0, default: 0 };
  const types = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];

  // Keywords that can accompany any kind of schema.
  const common = {
    $schema: { type: 'string' },
    $anchor: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', description: 'A name that “$ref”: “#name” can point to.' },
    $defs: { type: 'object', additionalProperties: S, description: 'Named schemas for “$ref” to reuse.' },
    $ref: { type: 'string', pattern: '^#', description: 'Local references only: “#”, “#/$defs/name” or “#anchor”.' },
    title: { type: 'string' },
    description: { type: 'string' },
    default: {},
    enum: { type: 'array', minItems: 1, items: {}, uniqueItems: true, description: 'The allowed values, of any JSON type. Each must be different.' },
    const: {},
    allOf: schemaList,
    anyOf: schemaList,
    oneOf: schemaList,
    not: S,
    if: S,
    then: S,
    else: S
  };
  const stringKw = {
    minLength: count,
    maxLength: count,
    pattern: { type: 'string' },
    format: {
      enum: ['email', 'uri', 'date', 'date-time', 'time', 'uuid', 'ipv4', 'password', 'textarea'],
      description: 'password and textarea are hints for the editor.'
    }
  };
  const numberKw = {
    minimum: { type: 'number', default: 0 },
    maximum: { type: 'number', default: 100 },
    exclusiveMinimum: { type: 'number', default: 0 },
    exclusiveMaximum: { type: 'number', default: 100 },
    multipleOf: { type: 'number', exclusiveMinimum: 0, default: 1 }
  };
  const objectKw = {
    properties: { type: 'object', additionalProperties: S, description: 'A schema for each named property.' },
    patternProperties: { type: 'object', additionalProperties: S, description: 'Schemas for properties whose names match a regular expression.' },
    additionalProperties: { ...S, description: 'A schema for any other property, or false to forbid them.' },
    required: { ...strings, description: 'Names of properties that must be present.' },
    minProperties: count,
    maxProperties: count,
    propertyNames: S,
    dependentRequired: { type: 'object', additionalProperties: strings },
    dependentSchemas: { type: 'object', additionalProperties: S },
    dependencies: {
      type: 'object',
      description: 'The older form: each entry is a list of required names or a schema.',
      additionalProperties: { anyOf: [{ title: 'Required names', ...strings }, { title: 'Schema', ...S }] }
    }
  };
  const arrayKw = {
    items: {
      description: 'One schema for every item, or a list of schemas for a tuple.',
      anyOf: [{ title: 'One schema', ...S }, { title: 'Tuple of schemas', type: 'array', items: S }]
    },
    prefixItems: { type: 'array', items: S, minItems: 1 },
    additionalItems: S,
    minItems: count,
    maxItems: count,
    uniqueItems: { type: 'boolean' },
    contains: S,
    minContains: count,
    maxContains: count
  };
  const allKw = { ...stringKw, ...numberKw, ...objectKw, ...arrayKw };

  const kind = (title, props, typeProp) => ({
    title, type: 'object',
    required: typeProp ? ['type'] : [],
    properties: { ...(typeProp ? { type: typeProp } : {}), ...props },
    additionalProperties: false
  });
  const typed = (name, t, kw) => kind(name, { ...common, ...kw }, { const: t });

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'JSON Schema (editor subset)',
    description: 'Describes the schemas SchemaEditor can use. Pick a kind for each schema, then add keywords.',
    $ref: '#/$defs/schema',
    $defs: {
      schema: {
        title: 'Schema',
        oneOf: [
          typed('String', 'string', stringKw),
          typed('Number', 'number', numberKw),
          typed('Integer', 'integer', numberKw),
          typed('Boolean', 'boolean', {}),
          typed('Null', 'null', {}),
          typed('Object', 'object', objectKw),
          typed('Array', 'array', arrayKw),
          kind('Several types', { ...common, ...allKw },
            { type: 'array', items: { enum: types }, minItems: 2, uniqueItems: true, description: 'The value may be any one of these types.' }),
          kind('Untyped', { ...common, ...allKw }, null),
          { title: 'true / false', type: 'boolean' }
        ]
      }
    }
  };
})();

const metaInitial = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Task',
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
    done: { type: 'boolean' },
    priority: { enum: ['low', 'medium', 'high'], default: 'medium' },
    due: { type: 'string', format: 'date' },
    subtasks: { type: 'array', items: { $ref: '#' } }
  }
};

// ---- Page wiring
const contactSchema = schema;
const $ = id => document.getElementById(id);

const examples = {
  contact: {
    schema: contactSchema,
    initial,
    tools: [
      ['push("/tags", …)', () => editor.push('/tags', 'tag' + (Date.now() % 1000)), 'push'],
      ['set("/numbers/quantity", 999)', () => editor.set('/numbers/quantity', 999), 'set quantity'],
      ['remove("/address")', () => editor.remove('/address'), 'remove address'],
      ['setDocument(…)', () => editor.setDocument(initial), 'Reset']
    ]
  },
  meta: {
    schema: metaschema,
    initial: metaInitial,
    form: true,
    tools: [
      ['push("/required", "id")', () => editor.push('/required', 'id'), 'push'],
      ['set("/type", "array")', () => editor.set('/type', 'array'), 'set type'],
      ['setDocument(Contact schema)', () => editor.setDocument(contactSchema), 'Load'],
      ['setDocument(Task)', () => editor.setDocument(metaInitial), 'Reset']
    ]
  }
};

let editor = null, current = null, view = 'doc', previewEditor = null, previewTimer = null;

function say(msg, isErr) { $('status').textContent = msg; $('status').className = isErr ? 'err' : ''; }

function render() {
  const doc = editor.getDocument();
  $('out').hidden = view === 'form';
  $('preview').hidden = view !== 'form';
  if (view !== 'form') $('out').textContent = JSON.stringify(view === 'doc' ? doc : current.schema, null, 2);
  $('valid').textContent = editor.isValid() ? 'Document is valid.' : 'Document has errors: ' + editor.validate().length;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
}

// Metaschema mode: rebuild a form from the schema being edited (debounced: big schemas are slow to rebuild).
function updatePreview() {
  clearTimeout(previewTimer);
  if (!current || !current.form) return;
  previewTimer = setTimeout(() => {
    const target = $('preview-editor');
    const schemaDoc = editor.getDocument();
    const show = d => { $('pout').textContent = JSON.stringify(d, null, 2); };
    try {
      const prev = previewEditor ? previewEditor.getDocument() : undefined;
      let pe = new SchemaEditor(target, schemaDoc, prev);
      if (prev !== undefined && !pe.isValid()) pe = new SchemaEditor(target, schemaDoc);
      pe.onChange(d => show(d));
      previewEditor = pe;
      show(pe.getDocument());
      $('pmsg').textContent = editor.isValid() ? '' : 'The schema has errors, so the form may be incomplete.';
    } catch (e) {
      $('pmsg').textContent = 'No form yet: ' + e.message;
    }
  }, 200);
}

function run(label, fn) {
  try { fn(); say(label + ' applied.'); } catch (e) { say(label + ' was refused: ' + e.message, true); }
  render();
  updatePreview();
}

function mount(key) {
  current = examples[key];
  if (editor) editor.destroy();
  previewEditor = null;
  $('preview-editor').textContent = '';
  $('pout').textContent = '';
  $('pmsg').textContent = '';
  editor = new SchemaEditor($('editor'), current.schema, current.initial);
  editor.onChange((doc, info) => {
    // info.patch is a JSON Patch (RFC 6902) describing the change; info.path and info.value say what changed
    const patch = JSON.stringify(info.patch);
    say('patch: ' + (patch.length > 110 ? patch.slice(0, 109) + '…' : patch));
    render();
    updatePreview();
  });

  for (const k of Object.keys(examples)) {
    $('ex-' + k).setAttribute('aria-selected', String(k === key));
    $('intro-' + k).hidden = k !== key;
  }
  $('t-form').hidden = !current.form;
  view = current.form ? 'form' : 'doc';

  const bar = $('toolbar');
  bar.textContent = '';
  for (const [text, fn, label] of current.tools) {
    const b = document.createElement('button');
    const c = document.createElement('code');
    c.className = 'm';
    c.textContent = text;
    b.append(c);
    b.onclick = () => run(label, fn);
    bar.append(b);
  }
  say('Ready.');
  render();
  updatePreview();
}

document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => { view = b.dataset.view; render(); }; });
$('ex-contact').onclick = () => mount('contact');
$('ex-meta').onclick = () => mount('meta');
mount('contact');
