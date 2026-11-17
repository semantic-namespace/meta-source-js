'use strict';
// What the JavaScript reader finds in code, on conformance/polyglot's web/
// (the registry's part is conformance.test.js's), and the pack interface,
// on fixtures/routes.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const edn = require('../src/edn');
const index = require('../src/index');
const hover = require('../src/hover');

const { kw, toJson } = edn;
const polyglot = path.join(__dirname, '..', 'conformance', 'polyglot');
const routes = path.join(__dirname, 'fixtures', 'routes');
const idx = index.build(index.config(polyglot));
const bin = path.join(__dirname, '..', 'bin', 'meta-source-js.js');

test('a tagged declaration implements its id', () => {
  assert.deepStrictEqual(toJson(index.where(idx, kw(':fn/render-receipt')).impl),
                         { file: 'web/receipt.ts', line: 4, 'end-line': 7, var: 'web/receipt.ts#renderReceipt' });
  assert.strictEqual(index.where(idx, kw(':page/receipt')).impl.var, 'web/money.ts#ROUTES.receipt');
});

test('code referring to it, in its file and through an import, with the referring id', () => {
  const from = (id) => toJson(index.uses(idx, kw(id))['called-from']);
  assert.deepStrictEqual(from(':fn/render-receipt'), [{ var: 'web/receipt.ts#receiptPage', file: 'web/receipt.ts', line: 10 }]);
  assert.deepStrictEqual(from(':fn/format-money'),
                         [{ var: 'web/receipt.ts#renderReceipt', file: 'web/receipt.ts', line: 6, 'dev-id': 'fn/render-receipt' }]);
});

test('an id on two declarations is an error; a tag with no source saying anything is binding-only', () => {
  // the registry's problems are conformance.test.js's
  const ps = toJson(index.check(idx)).filter((p) => !['conflicting-values', 'relation-not-understood'].includes(p.problem));
  assert.deepStrictEqual(ps.map((p) => [p.severity, p.problem, p['dev-id']]),
                         [['error', 'dev-id-on-several-vars', 'fn/format-money'], ['info', 'binding-only', 'fn/format-money']]);
});

test('diagnostics underline the id in the JSDoc', () => {
  const ds = hover.diagnostics(idx, 'web/money.ts');
  assert.deepStrictEqual(ds.map((d) => [d.line, d.col, d['end-col'], d.severity, d.problem]),
                         [[1, 21, 37, 'error', 'dev-id-on-several-vars'], [9, 23, 39, 'error', 'dev-id-on-several-vars'],
                          [1, 21, 37, 'note', 'binding-only']]);
});

test('hover at a tagged name, at its tag, and at a reference to it', () => {
  const at = (file, line, col) => {
    const text = require('fs').readFileSync(path.join(polyglot, file), 'utf8').split('\n')[line - 1];
    return hover.lookupAt(idx, { file: path.join(polyglot, file), line, col, text });
  };
  assert.match(at('web/receipt.ts', 4, 20).eldoc, /^:fn\/render-receipt {2}entry/);
  assert.match(at('web/receipt.ts', 3, 25).eldoc, /^:fn\/render-receipt/);
  assert.match(at('web/receipt.ts', 6, 34).eldoc, /^:fn\/format-money {2}binding/);
  assert.deepStrictEqual(at('web/receipt.ts', 6, 34).range, { line: 6, col: 33, 'end-col': 44 });
  assert.strictEqual(at('web/receipt.ts', 5, 3).kind, 'none');
});

test('the entity hover says where it is implemented and who calls it', () => {
  const h = hover.lookup(idx, kw(':fn/render-receipt'));
  assert.match(h.describe, /\nimpl {7}web\/receipt\.ts#renderReceipt {4}web\/receipt\.ts:4-7\n/);
  assert.match(h.describe, /\ncalled from\n {2}web\/receipt\.ts#receiptPage {4}web\/receipt\.ts:10/);
  assert.deepStrictEqual(h.definitions.map((d) => d.summary), ['defined: calls doc reads returns', 'impl: web/receipt.ts#renderReceipt']);
});

test('a JS pack: its entities are one more source, its problems are check\'s', () => {
  const r = index.build(index.config(routes));
  const w = toJson(index.where(r, kw(':route/cart')));
  assert.deepStrictEqual(w.entry, { 'route/title': 'Your cart', 'route/path': '/shop/cart' });
  assert.deepStrictEqual(w.sources.map((s) => s.pack || 'edn'), ['edn', 'routes']);
  assert.deepStrictEqual(toJson(index.check(r)).map((p) => [p.problem, p['dev-id'], p.message]),
                         [['route-outside-prefix', 'route/legacy', '/v1/legacy is outside /shop']]);
  assert.match(hover.lookup(r, kw(':route/cart')).eldoc, /^:route\/cart {2}entry\n\/shop\/cart/);
});

test('the command: --fail-on exits 1 at that severity, --brief prints one line each', () => {
  const run = (...args) => {
    try {
      return { out: execFileSync('node', [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) {
      return { out: e.stdout, code: e.status };
    }
  };
  assert.strictEqual(run('check', '--root', routes, '--fail-on', 'error').code, 0);
  assert.strictEqual(run('check', '--root', routes, '--fail-on', 'warning').code, 1);
  assert.match(run('check', '--root', routes, '--brief').out, /^warning src\/routes\.ts:3 +\/v1\/legacy is outside \/shop\n$/);
  assert.strictEqual(run('check', '--fail-on', 'loud').code, 1);
});

test('serve: one JSON reply per request', () => {
  const out = execFileSync('node', [bin, 'serve', '--root', polyglot], {
    encoding: 'utf8',
    input: ['{"id":1,"op":"hover","keyword":":fn/price"}', '{"id":2,"op":"summary"}', '{"id":3,"op":"nope"}'].join('\n') + '\n',
  });
  const [a, b, c] = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(a.result.kind, 'entity');
  assert.strictEqual(b.result.entities, 5);
  assert.deepStrictEqual(c, { id: 3, result: { error: 'unknown op nope' } });
});

test('EDN: lines of top-level keys, sets, tags, discards, and what is not readable', () => {
  const rows = edn.keyedLines(';; c\n{:a/b {:x #{:y :y} :s "q\\"z" :t #inst "2026"}\n #_ :gone #_ 1\n :c/d [1 nil true \\a]}');
  assert.deepStrictEqual(rows.map((r) => [r.key.text, r.line]), [[':a/b', 2], [':c/d', 4]]);
  assert.strictEqual(edn.prStr(rows[0].value), '{:x #{:y}, :s "q\\"z", :t #inst "2026"}');
  assert.deepStrictEqual(toJson(rows[1].value), [1, null, true, 'a']);
  assert.strictEqual(edn.keyedLines('[1 2]'), null);
  assert.throws(() => edn.keyedLines('{:a 1} :b'), /something after the map/);
  assert.throws(() => edn.keyedLines('{:a}'), /a key with no value/);
});

test('relations: a key given two verbs is untyped, an error naming who gave which; a pack gives relations; :relations carries dataflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-js-relations-'));
  fs.mkdirSync(path.join(dir, 'registry'));
  fs.writeFileSync(path.join(dir, 'registry', 'r.edn'),
    '{:fn/run {:fn/deps [:fn/load] :fn/reads [:job/spec] :adr/notes [:fn/load]}\n :fn/load {}\n :job/spec {}}');
  fs.writeFileSync(path.join(dir, 'pack.js'), "module.exports = { id: 'adr', relations: { 'adr/notes': 'adr/notes' } };");
  fs.writeFileSync(path.join(dir, 'meta-source.edn'),
    '{:registry ["registry"] :src [] :relations {:fn/reads {:verb :consumes} :fn/deps {:verb :depends}}\n' +
    ' :dataflow {:produces [:fn/deps]} :js {:packs {"./pack.js" {}}}}');
  const ri = index.build(index.config(dir));
  const deps = toJson(index.dependencies(ri, kw(':fn/run'))['depends-on']).map((d) => [d['dev-id'], d.via, d.verb || null]);
  assert.deepStrictEqual(deps, [['fn/load', 'fn/deps', null], ['job/spec', 'fn/reads', 'consumes'], ['fn/load', 'adr/notes', 'adr/notes']]);
  assert.deepStrictEqual(toJson(index.check(ri)).filter((p) => p.problem === 'conflicting-relations'),
                         [{ severity: 'error', problem: 'conflicting-relations', property: 'fn/deps',
                            verbs: { depends: ['meta-source.edn'], produces: ['meta-source.edn'] } }]);
  assert.deepStrictEqual(toJson(index.dataKey(ri, kw(':job/spec')).consumers.map((c) => c['dev-id'])), ['fn/run']);
  assert.ok(index.isDependency(null) && index.isDependency(kw(':depends')) && !index.isDependency(kw(':adr/notes')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("relations: a pack with untyped: 'relation' makes its vocabulary's undeclared keys relations; others stay dependencies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-js-untyped-'));
  fs.mkdirSync(path.join(dir, 'registry'));
  fs.writeFileSync(path.join(dir, 'registry', 'r.edn'),
    '{:adr/cache {:adr/mitigates [:risk/slow] :adr/needs [:db/main] :team/uses [:svc/mail]}\n :risk/slow {:k/x 1} :db/main {:k/x 1} :svc/mail {:k/x 1}}');
  fs.writeFileSync(path.join(dir, 'pack.js'),
    "module.exports = { id: 'adr', vocabulary: ['adr'], untyped: 'relation', relations: { 'adr/needs': 'depends' } };");
  fs.writeFileSync(path.join(dir, 'bad.js'), "module.exports = { id: 'bad', untyped: 'dependency' };");
  fs.writeFileSync(path.join(dir, 'meta-source.edn'), '{:registry ["registry"] :src [] :js {:packs {"./pack.js" {} "./bad.js" {}}}}');
  const ri = index.build(index.config(dir));
  assert.deepStrictEqual(toJson(index.dependencies(ri, kw(':adr/cache'))['depends-on']).map((d) => [d['dev-id'], d.verb || null, d.depends || null]),
                         [['risk/slow', 'adr/mitigates', null], ['db/main', 'depends', null], ['svc/mail', null, null]]);
  assert.deepStrictEqual(toJson(ri.untypedRelations), { 'adr/mitigates': 'adr' });
  assert.deepStrictEqual(toJson(index.check(ri)).filter((p) => p.problem === 'relation-not-understood').map((p) => [p.source, p.given]),
                         [['bad', 'dependency']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relations: {:verb v :depends true} is a relation and a dependency; :depends given by one source and not another is a conflict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-js-depends-'));
  fs.mkdirSync(path.join(dir, 'registry'));
  fs.writeFileSync(path.join(dir, 'registry', 'r.edn'), '{:wf/checkout {:wf/producers [:fn/charge] :wf/notes [:fn/charge]}\n :fn/charge {}}');
  fs.writeFileSync(path.join(dir, 'pack.js'),
    "module.exports = { id: 'wf', relations: { 'wf/producers': 'wf/has-producer', 'wf/notes': { verb: 'wf/notes', depends: true } } };");
  fs.writeFileSync(path.join(dir, 'meta-source.edn'),
    '{:registry ["registry"] :src [] :js {:packs {"./pack.js" {}}}\n' +
    ' :relations {:wf/producers {:verb :wf/has-producer :depends true} :wf/notes {:verb :wf/notes :depends true}\n' +
    '             :fn/reads {:verb :consumes :depends true}}}');
  const ri = index.build(index.config(dir));
  assert.deepStrictEqual(toJson(index.dependencies(ri, kw(':wf/checkout'))['depends-on']).map((d) => [d.via, d.verb || null, d.depends || null]),
                         [['wf/producers', null, null], ['wf/notes', 'wf/notes', true]]);
  const ps = toJson(index.check(ri));
  assert.deepStrictEqual(ps.filter((p) => p.problem === 'conflicting-relations'),
                         [{ severity: 'error', problem: 'conflicting-relations', property: 'wf/producers',
                            verbs: { 'wf/has-producer': ['meta-source.edn', 'wf'] }, depends: { false: ['wf'], true: ['meta-source.edn'] } }]);
  assert.deepStrictEqual(ps.filter((p) => p.problem === 'relation-not-understood').map((p) => p.reason),
                         ["dataflow is no dependency: :depends true goes with :depends or a verb of the project's own"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
