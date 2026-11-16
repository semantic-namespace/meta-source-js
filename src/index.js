'use strict';
// The static view of a JavaScript/TypeScript project's sources, as
// meta-source.index builds one for Clojure: the entries in its EDN registry
// files, with the line each key is written on; what JS packs give; and the
// declarations that carry the meta key in their JSDoc
// (/** @meta-source/id :fn/x */), with what refers to each. Nothing is
// loaded or run.
//
// The questions (where, uses, dependencies, dataKey, check, summary) answer
// with the same shapes as meta-source.index's, so an editor or CI can ask
// either reader: about the registry, both say the same (conformance/).
const fs = require('fs');
const path = require('path');
const edn = require('./edn');
const { kw, prStr, keyedLines, walk, itemsOf, isQualifiedKeyword } = edn;
const { mergeSources } = require('./merge');
const code = require('./code');

const DEFAULT_ID_KEY = ':meta-source/id';

// =============================================================================
// Files and settings
// =============================================================================

const hidden = (name) => name.startsWith('.') || name.startsWith('#');

function filesUnder(root, dirs, keep) {
  const out = [];
  const visit = (f, top) => {
    let st;
    try {
      st = fs.statSync(f);
    } catch (_) {
      return;
    }
    if (st.isDirectory()) {
      if (!top && (hidden(path.basename(f)) || path.basename(f) === 'node_modules')) return;
      for (const n of fs.readdirSync(f)) visit(path.join(f, n), false);
    } else if (st.isFile() && !hidden(path.basename(f)) && keep(f)) out.push(fs.realpathSync(f));
  };
  for (const d of dirs) visit(path.resolve(root, d), true);
  return [...new Set(out)].sort();
}

const asStrings = (v, dflt) => (v == null ? dflt : itemsOf(v).map(String));

/**
 * The settings in root/meta-source.edn, the file the Clojure reader reads:
 * :registry, :src, :id-key, :dataflow, :relations, :merge, and :js {:packs {"module" opts}}
 * for packs this reader runs. Keys only the Clojure reader knows are ignored.
 */
function config(root, overrides = {}) {
  const f = path.join(root, 'meta-source.edn');
  let m = new Map();
  if (fs.existsSync(f)) {
    try {
      m = edn.readString(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      throw new Error(`meta-source.edn is not readable: ${e.message}`);
    }
  }
  const g = (k) => m.get(kw(k));
  const dataflow = g('dataflow');
  const js = g('js');
  const packs = js instanceof Map && js.get(kw('packs'));
  return {
    root: fs.realpathSync(root),
    registry: overrides.registry && overrides.registry.length ? overrides.registry : asStrings(g('registry'), ['registry']),
    src: overrides.src && overrides.src.length ? overrides.src : asStrings(g('src'), ['src']),
    idKey: g('id-key') ? g('id-key').text : DEFAULT_ID_KEY,
    dataflow: {
      consumes: dataflow instanceof Map ? itemsOf(dataflow.get(kw('consumes'))) : [],
      produces: dataflow instanceof Map ? itemsOf(dataflow.get(kw('produces'))) : [],
    },
    relations: g('relations') === undefined ? new Map() : g('relations'),
    merge: g('merge') instanceof Map ? new Map([...g('merge')].map(([k, v]) => [k, String(v)])) : new Map(),
    packs: packs instanceof Map ? [...packs].map(([spec, opts]) => ({ spec: String(spec), opts })) : [],
  };
}

/**
 * A pack named by a path (./tools/pack.js) is the project's; one named by a
 * module is looked up from the project's root, then from where meta-source
 * itself is installed, so a pack installed beside it is found:
 *   npx -p github:semantic-namespace/meta-source -p <the pack's package> meta-source-js check
 */
function resolvePack(root, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return path.resolve(root, spec);
  try {
    return require.resolve(spec, { paths: [root] });
  } catch (_) {
    try {
      return require.resolve(spec);
    } catch (e) {
      throw new Error(`${spec} is not installed in the project, nor beside meta-source`);
    }
  }
}

function loadPack(root, spec) {
  const p = require(resolvePack(root, spec));
  const pack = p && (p.pack || p.default || p);
  if (!pack || !pack.id || !(pack.check || pack.entities || pack.describe || pack.relations))
    throw new Error(`${spec}: a pack is an object with an id and check, entities, describe or relations`);
  return pack;
}

// =============================================================================
// Building
// =============================================================================

/**
 * The index of the project at cfg.root. Parsed code files are cached by
 * modification time, so a long-lived process (serve) rebuilds cheaply.
 */
function build(cfg) {
  const { root } = cfg;
  const rel = (f) => path.relative(root, f);
  const ednFiles = filesUnder(root, cfg.registry, (f) => f.endsWith('.edn'));
  const codeFiles = filesUnder(root, cfg.src, code.isCode);
  const readProblems = [];

  // registry files: one source per entry, labelled by where it is written
  const sources = [];
  for (const f of ednFiles) {
    let rows;
    try {
      rows = keyedLines(fs.readFileSync(f, 'utf8'));
      if (rows === null) throw new Error('A registry file must hold a map of dev-id to entry');
    } catch (e) {
      readProblems.push({ problem: kw('unreadable-registry-file'), file: rel(f), message: e.message });
      continue;
    }
    for (const { key, value, line } of rows)
      sources.push({ source: { file: rel(f), line }, entities: new Map([[key, value instanceof Map ? value : new Map()]]) });
  }

  const { files: analysis, analysed } = code.analyse(root, codeFiles, cfg.idKey);
  const vars = [...analysis.values()].flatMap((a) => a.vars);
  const refs = [...analysis.values()].flatMap((a) => a.refs);

  const idx = { root, cfg, analysis, vars, refs, analysed, packs: [], packProblems: [] };

  // packs: entities they give are one more source each
  for (const { spec, opts } of cfg.packs) {
    let pack;
    try {
      pack = loadPack(root, spec);
    } catch (e) {
      readProblems.push({ problem: kw('pack-not-loaded'), pack: spec, message: e.message });
      continue;
    }
    idx.packs.push({ pack, opts });
  }
  const packSources = [];
  for (const { pack, opts } of idx.packs) {
    if (!pack.entities) continue;
    try {
      for (const e of pack.entities(context(idx, opts)) || [])
        packSources.push({ source: { file: e.file, line: e.line }, kind: pack.id, entities: new Map([[toKw(e.id), e.entry || new Map()]]) });
    } catch (err) {
      readProblems.push({ problem: kw('pack-failed'), pack: pack.id, message: err.message });
    }
  }

  const merged = mergeSources([...sources, ...packSources], cfg.merge);
  const entities = new Map();
  const defsOf = new Map();
  for (const s of [...sources.map((x) => ({ ...x, kind: 'edn' })), ...packSources])
    for (const [id, entry] of s.entities) {
      if (!defsOf.has(id)) defsOf.set(id, []);
      defsOf.get(id).push({ kind: s.kind, file: s.source.file, line: s.source.line, keys: sortKeywords([...entry.keys()]) });
    }
  for (const [id, entry] of merged.entities) entities.set(id, { id, entry, definitions: defsOf.get(id), kind: defsOf.get(id)[0].kind });

  // a var naming an id no source gives: the id exists, nothing said about it yet
  idx.linked = new Map();
  for (const v of vars)
    if (v.devId) {
      const id = kw(v.devId);
      if (!idx.linked.has(id)) idx.linked.set(id, []);
      idx.linked.get(id).push(v);
    }
  for (const [id, vs] of idx.linked)
    if (!entities.has(id))
      entities.set(id, { id, entry: new Map(), kind: 'binding', definitions: [{ kind: 'binding', file: rel(vs[0].file), line: vs[0].line, keys: [], binding: true }] });

  idx.entities = new Map([...entities].sort(([a], [b]) => compareKeywords(a, b)));
  const relations = relationsOf(cfg, idx.packs);
  idx.relations = relations.verbs;
  idx.depending = relations.depending;
  idx.relationsProblems = relations.problems;
  idx.dataflow = {
    consumes: [...relations.verbs].filter(([, v]) => v === kw('consumes')).map(([k]) => k),
    produces: [...relations.verbs].filter(([, v]) => v === kw('produces')).map(([k]) => k),
  };
  idx.readProblems = [
    ...readProblems,
    ...merged.conflicts.map((c) => ({ problem: kw('conflicting-values'), 'dev-id': c.id, key: c.key,
      values: c.values.map((v) => ({ value: v.value, sources: v.sources })) })),
  ];
  for (const { pack, opts } of idx.packs) {
    if (!pack.check) continue;
    try {
      for (const p of pack.check(context(idx, opts)) || []) idx.packProblems.push(normaliseProblem(p, pack));
    } catch (err) {
      idx.packProblems.push({ severity: 'error', problem: kw('pack-failed'), pack: pack.id, message: err.message });
    }
  }
  return idx;
}

const toKw = (x) => (x instanceof edn.Keyword ? x : kw(String(x)));

// The verbs meta-source itself acts on: :depends a dependency, :consumes and
// :produces the dataflow. Any other verb is a qualified keyword, a relation
// of the project's own: not a dependency.
const RESERVED_VERBS = [kw('consumes'), kw('depends'), kw('produces')];

/** True when an edge of verb is a dependency: :depends, or untyped. */
const isDependency = (verb) => verb == null || verb === kw('depends');

/**
 * What each entry key's ids are, as the Clojure reader says: [[key verb
 * source given]] claims from meta-source.edn's :relations and :dataflow, and
 * each pack's `relations` ({"ns/key": "ns/verb"}); {verbs, problems}, a key
 * given two verbs a :conflicting-relations error that leaves it untyped.
 */
function relationsOf(cfg, packs) {
  // [key verb source given depends]
  const claims = [];
  const ofRelations = (m, source) => {
    if (!(m instanceof Map)) return claims.push([null, null, source, m]);
    for (const [k, r] of m)
      claims.push([k, r instanceof Map ? r.get(kw('verb')) : null, source, r, r instanceof Map ? r.get(kw('depends')) : undefined]);
  };
  ofRelations(cfg.relations, 'meta-source.edn');
  for (const [verb, ks] of [[kw('consumes'), cfg.dataflow.consumes], [kw('produces'), cfg.dataflow.produces]])
    for (const k of ks) claims.push([k, verb, 'meta-source.edn']);
  for (const { pack } of packs)
    if (pack.relations)
      for (const [k, v] of Object.entries(pack.relations)) {
        const r = typeof v === 'object' && v !== null ? v : { verb: v };
        claims.push([kw(k), kw(String(r.verb)), kw(pack.id), undefined, r.depends]);
      }
  const DATAFLOW = [kw('consumes'), kw('produces')];
  const problemOf = ([k, v, , , depends]) =>
    k == null ? ':relations is a map of entry key to {:verb v}'
      : !(k instanceof edn.Keyword) ? 'an entry key is a keyword'
      : !(RESERVED_VERBS.includes(v) || isQualifiedKeyword(v)) ? `a verb is one of (${RESERVED_VERBS.map(prStr).join(' ')}) or a qualified keyword`
      : ![undefined, null, true, false].includes(depends) ? ':depends is true or false'
      : depends === true && DATAFLOW.includes(v) ? "dataflow is no dependency: :depends true goes with :depends or a verb of the project's own"
      : null;
  // what reach makes of a claim: :depends, or a verb of its own marked :depends true
  const dependsOf = ([, v, , , depends]) => v === kw('depends') || depends === true;
  const byKey = new Map();
  for (const c of claims.filter((c) => !problemOf(c))) {
    if (!byKey.has(c[0])) byKey.set(c[0], []);
    byKey.get(c[0]).push(c);
  }
  const verbs = new Map();
  const depending = new Set();
  const problems = [];
  for (const c of claims) {
    const reason = problemOf(c);
    if (!reason) continue;
    const [k, , source, given] = c;
    const p = { severity: 'error', problem: kw('relation-not-understood'), source, reason };
    if (k instanceof edn.Keyword) Object.assign(p, { property: k, given });
    problems.push(p);
  }
  for (const [k, cs] of [...byKey].sort(([a], [b]) => a.text.slice(1).localeCompare(b.text.slice(1)))) {
    const vs = [...new Set(cs.map((c) => c[1]))];
    const ds = [...new Set(cs.map(dependsOf))];
    if (vs.length === 1 && ds.length === 1) {
      verbs.set(k, vs[0]);
      if (ds[0] && vs[0] !== kw('depends')) depending.add(k);
    } else {
      const sourcesOf = (f) => [...new Set(cs.filter(f).map((c) => c[2]))];
      const p = { severity: 'error', problem: kw('conflicting-relations'), property: k,
                  verbs: new Map(vs.sort((a, b) => a.text.localeCompare(b.text)).map((v) => [v, sourcesOf((c) => c[1] === v)])) };
      if (vs.length === 1 && ds.length > 1) p.depends = new Map([[false, sourcesOf((c) => !dependsOf(c))], [true, sourcesOf(dependsOf)]]);
      problems.push(p);
    }
  }
  return { verbs, depending, problems };
}

function normaliseProblem(p, pack) {
  const out = { ...p, problem: toKw(p.problem), pack: pack.id };
  if (p['dev-id']) out['dev-id'] = toKw(p['dev-id']);
  if (!out.severity) out.severity = 'warning';
  return out;
}

/** What a pack is given: the index, its options from meta-source.edn, and helpers. */
function context(idx, opts) {
  return {
    idx, opts, root: idx.root, kw, edn,
    // the parser meta-source read the code with: its ASTs are the ones sourceFile gives
    ts: require('typescript'),
    relative: (f) => path.relative(idx.root, f),
    sourceFile: (f) => idx.analysis.get(f) && idx.analysis.get(f).sf,
    files: () => [...idx.analysis.keys()],
    vars: () => idx.vars,
    refs: () => idx.refs,
    entities: () => idx.entities || new Map(),
    implOf: (id) => implOf(idx, toKw(id)),
    refsTo: (v) => refsTo(idx, v),
  };
}

// =============================================================================
// Locations
// =============================================================================

function compareKeywords(a, b) {
  const an = a.namespace || '', bn = b.namespace || '';
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
const sortKeywords = (ks) => [...ks].sort((a, b) => (a instanceof edn.Keyword && b instanceof edn.Keyword ? compareKeywords(a, b) : prStr(a).localeCompare(prStr(b))));

const implOf = (idx, id) => (idx.linked.get(id) || [])[0] || null;

function varLoc(idx, v) {
  return { file: path.relative(idx.root, v.file), line: v.line, 'end-line': v.endLine, var: v.var };
}

function loc(idx, e) {
  const d = e.definitions[0];
  const l = { file: d.file, line: d.line };
  if (d.binding) l.binding = true;
  if (d.kind && d.kind !== 'edn' && d.kind !== 'binding') l.pack = d.kind;
  return l;
}

// =============================================================================
// Questions
// =============================================================================

/** Where id is defined and implemented, with its merged entry. */
function where(idx, id) {
  const e = idx.entities.get(id);
  if (!e) return null;
  const impl = implOf(idx, id);
  return {
    'dev-id': id,
    definition: loc(idx, e),
    impl: impl ? varLoc(idx, impl) : null,
    sources: e.definitions.map((d) => {
      const s = { file: d.file, line: d.line };
      if (d.binding) s.binding = true;
      if (d.kind && d.kind !== 'edn' && d.kind !== 'binding') s.pack = d.kind;
      s.keys = d.keys;
      return s;
    }),
    entry: e.entry,
  };
}

/**
 * [[key, id, verb, depends]] for every entity an entry names in its values;
 * verb, what the relations say key is (null: untyped); depends, whether the
 * edge is a dependency (untyped, :depends, or a verb of its own marked
 * {:depends true}).
 */
function references(idx, entry) {
  const out = [];
  const seen = new Set();
  for (const [k, v] of entry)
    for (const x of walk(v))
      if (isQualifiedKeyword(x) && idx.entities.has(x)) {
        const sig = prStr(k) + ' ' + x.text;
        if (!seen.has(sig)) {
          const verb = idx.relations.get(k) || null;
          seen.add(sig), out.push([k, x, verb, isDependency(verb) || idx.depending.has(k)]);
        }
      }
  return out;
}

/** The refs to var v: by its file and name. */
function refsTo(idx, v) {
  return idx.refs.filter((r) => r.toFile === v.file && r.toName === v.name && !(r.file === v.file && r.line === v.nameAt.line && r.col === v.nameAt.col));
}

function coverage(idx) {
  const linked = idx.vars.filter((v) => v.devId).length;
  const fns = idx.vars.filter((v) => v.fn && v.exported).length;
  return { 'linked-vars': linked, 'public-fns': fns,
           note: linked > 0 && linked < fns ? 'only linked vars are seen as entities; calls from unlinked code are listed but not their entities' : null };
}

/** What refers to id: entries naming it, and code referring to its implementation. */
function uses(idx, id) {
  const impl = implOf(idx, id);
  const varId = new Map(idx.vars.filter((v) => v.devId).map((v) => [`${v.file}#${v.name}`, kw(v.devId)]));
  return {
    'dev-id': id,
    'referenced-by': [...idx.entities].flatMap(([other, e]) =>
      references(idx, e.entry).filter(([, x]) => x === id)
        .map(([prop, , verb, dep]) => ({ 'dev-id': other, via: prop, definition: loc(idx, e), ...(verb ? { verb } : {}),
                                         ...(dep && !isDependency(verb) ? { depends: true } : {}) }))),
    'called-from': impl
      ? refsTo(idx, impl).map((r) => {
          const c = { var: `${path.relative(idx.root, r.file)}#${r.from || '(top level)'}`, file: path.relative(idx.root, r.file), line: r.line };
          const from = r.from && varId.get(`${r.file}#${r.from}`);
          if (from) c['dev-id'] = from;
          return c;
        })
      : [],
    coverage: coverage(idx),
  };
}

function dependencies(idx, id) {
  const e = idx.entities.get(id);
  if (!e) return null;
  return { 'dev-id': id,
           'depends-on': references(idx, e.entry).map(([prop, x, verb, dep]) =>
             ({ 'dev-id': x, via: prop, definition: loc(idx, idx.entities.get(x)), ...(verb ? { verb } : {}),
                ...(dep && !isDependency(verb) ? { depends: true } : {}) })) };
}

/** The data keys entry consumes and produces: the values of the keys whose verb is :consumes or :produces (:dataflow, :relations). */
function contractKeys(idx, entry) {
  const declared = (ks) => new Set(ks.flatMap((k) => itemsOf(entry.get(k))));
  return { consumes: declared(idx.dataflow.consumes), produces: declared(idx.dataflow.produces) };
}

function dataKey(idx, k) {
  const rows = [...idx.entities].map(([id, e]) => {
    const { consumes, produces } = contractKeys(idx, e.entry);
    return { 'dev-id': id, produces: produces.has(k), consumes: consumes.has(k), definition: loc(idx, e) };
  });
  return {
    'data-key': k,
    producers: rows.filter((r) => r.produces).map((r) => ({ 'dev-id': r['dev-id'], definition: r.definition })),
    consumers: rows.filter((r) => r.consumes).map((r) => ({ 'dev-id': r['dev-id'], definition: r.definition })),
  };
}

const RANK = { error: 0, warning: 1 };

/** Where code and registry files disagree, most severe first. */
function check(idx) {
  const ps = [
    ...idx.readProblems.map((p) => ({ ...p, severity: 'error' })),
    ...idx.relationsProblems,
    ...[...idx.linked].filter(([, vs]) => vs.length > 1)
      .map(([id, vs]) => ({ severity: 'error', problem: kw('dev-id-on-several-vars'), 'dev-id': id, vars: vs.map((v) => varLoc(idx, v)) })),
    ...[...idx.entities].filter(([, e]) => e.kind === 'binding')
      .map(([id]) => ({ severity: 'info', problem: kw('binding-only'), 'dev-id': id, impl: varLoc(idx, implOf(idx, id)) })),
    ...idx.packProblems,
  ];
  return ps.map((p, i) => [p, i]).sort(([a, i], [b, j]) => (RANK[a.severity] ?? 2) - (RANK[b.severity] ?? 2) || i - j).map(([p]) => p);
}

function summary(idx) {
  const kinds = {};
  for (const [, e] of idx.entities) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const { note, ...cov } = coverage(idx);
  return {
    entities: idx.entities.size,
    'entities-by-source': Object.fromEntries(Object.entries(kinds).sort()),
    packs: Object.fromEntries(idx.packs.map(({ pack }) => [pack.id, {}])),
    'pack-snapshots': {},
    'source-files': idx.analysis.size,
    'analysed-now': idx.analysed,
    coverage: cov,
  };
}

module.exports = {
  context, config, build, where, uses, dependencies, isDependency, dataKey, check, summary, contractKeys, implOf, refsTo, varLoc,
  compareKeywords, sortKeywords, DEFAULT_ID_KEY,
};
