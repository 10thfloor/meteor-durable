import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

const READONLY = Symbol('lens.readonly');

/** readonly(fn) — visible in the view, structurally unwritable. */
export function readonly(get) {
  return { [READONLY]: true, get };
}

// Field kinds:
//   'memo'                         rename/projection — lawful by construction
//   readonly(doc => ...)           computed, get-only
//   { from, get, set }             custom pair; get(baseFieldValue), set(viewValue, ctx) -> baseFieldValue
function classify(spec) {
  if (typeof spec === 'string') return { kind: 'rename', from: spec };
  if (spec && spec[READONLY]) return { kind: 'readonly', get: spec.get };
  if (spec && spec.from && spec.get && spec.set) return { kind: 'custom', ...spec };
  throw new Error('Lens field must be a rename string, readonly(fn), or { from, get, set }');
}

// `where` supports plain equality selectors only ({ status: 'submitted' }).
// Enough to express row scope honestly; anything fancier needs a matcher engine.
function matchesWhere(doc, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => doc[k] === v);
}

function currentCtx() {
  let userId = null;
  try { userId = Meteor.userId(); } catch (e) { /* outside a method invocation */ }
  return { userId, now: new Date() };
}

class Lens {
  constructor(base, config) {
    this.base = base;
    this.where = config.where || null;
    this.onEscape = config.onEscape || 'forbid';
    this.insertPolicy = config.insert ?? false;   // false | create(view, ctx) => baseDoc
    this.removePolicy = config.remove ?? 'forbid'; // 'forbid' | 'delete' | update-spec
    this.fields = {};
    for (const [name, spec] of Object.entries(config.fields)) {
      this.fields[name] = classify(spec);
    }
  }

  /** base doc -> view doc. get transforms may be async. */
  async view(doc) {
    const out = { _id: doc._id };
    for (const [name, f] of Object.entries(this.fields)) {
      if (f.kind === 'rename') out[name] = doc[f.from];
      else if (f.kind === 'readonly') out[name] = await f.get(doc);
      else out[name] = await f.get(doc[f.from]);
    }
    return out;
  }

  /** Map a view field name to its base field name, for pushing sort down to
   *  the base query. Computed fields can't be evaluated in the database. */
  _baseKey(k) {
    if (k === '_id') return '_id';
    const f = this.fields[k];
    if (!f) throw new Meteor.Error('lens-field', `'${k}' is not a field of this view`);
    if (f.kind === 'rename') return f.from;
    throw new Meteor.Error('lens-option', `cannot sort on computed field '${k}' at the database layer`);
  }

  /**
   * find(viewSelector) -> { fetchAsync } over view docs.
   * Selector keys are view fields; rename fields translate to base queries,
   * computed fields are matched post-projection.
   */
  find(selector = {}, options = {}) {
    const baseSel = { ...(this.where || {}) };
    const postFilter = [];
    for (const [k, v] of Object.entries(selector)) {
      if (k === '_id') { baseSel._id = v; continue; }
      const f = this.fields[k];
      if (!f) throw new Meteor.Error('lens-field', `'${k}' is not a field of this view`); // no filtering on unexposed base fields
      if (f.kind === 'rename') baseSel[f.from] = v;
      else postFilter.push([k, v]);
    }

    const baseOptions = { ...options };
    // Translate sort keys to base field names (renames); computed fields throw.
    if (options.sort) {
      baseOptions.sort = Object.fromEntries(
        Object.entries(options.sort).map(([k, dir]) => [this._baseKey(k), dir]));
    }
    // Field projection through a lens isn't supported: the view is the projection.
    if (options.fields || options.projection) {
      throw new Meteor.Error('lens-option', 'field projection is not supported through a lens; the view definition IS the projection');
    }
    // When computed fields are post-filtered, limit/skip must be applied AFTER
    // filtering or paging is wrong — do it in JS.
    const jsSlice = postFilter.length > 0 && (options.limit != null || options.skip != null);
    if (jsSlice) { delete baseOptions.limit; delete baseOptions.skip; }

    const lens = this;
    return {
      async fetchAsync() {
        const docs = await lens.base.find(baseSel, baseOptions).fetchAsync();
        let views = await Promise.all(docs.map((d) => lens.view(d)));
        views = views.filter((vd) => postFilter.every(([k, v]) => vd[k] === v));
        if (jsSlice) {
          const skip = options.skip || 0;
          views = views.slice(skip, options.limit != null ? skip + options.limit : undefined);
        }
        return views;
      },
    };
  }

  async findOneAsync(idOrSelector) {
    const sel = typeof idOrSelector === 'string' ? { _id: idOrSelector } : idOrSelector;
    const all = await this.find(sel).fetchAsync();
    return all[0];
  }

  /**
   * updateAsync(id, { $set: {...} }) — the putback.
   * Only $set is supported on computed fields; renames pass $set through.
   * Writes outside the view's fields, to readonly fields, or that would move
   * the doc out of `where` scope (onEscape: 'forbid') are rejected.
   */
  async updateAsync(id, modifier) {
    const ctx = currentCtx();
    const ops = Object.keys(modifier);
    if (ops.length !== 1 || ops[0] !== '$set') {
      throw new Meteor.Error('lens-op', 'Lens updates support { $set } only');
    }
    const doc = await this.base.findOneAsync(id);
    if (!doc || !matchesWhere(doc, this.where)) {
      throw new Meteor.Error('lens-scope', 'Document is not in this view');
    }

    const baseSet = {};
    for (const [k, v] of Object.entries(modifier.$set)) {
      const f = this.fields[k];
      if (!f) throw new Meteor.Error('lens-field', `'${k}' is not a field of this view`);
      if (f.kind === 'readonly') throw new Meteor.Error('lens-readonly', `'${k}' is readonly`);
      if (f.kind === 'rename') baseSet[f.from] = v;
      else baseSet[f.from] = await f.set(v, { ...ctx, doc }); // set may be async
    }

    if (this.onEscape === 'forbid') {
      const after = { ...doc, ...baseSet };
      if (!matchesWhere(after, this.where)) {
        throw new Meteor.Error('lens-escape', 'Update would move the document out of the view');
      }
    }
    return this.base.updateAsync(id, { $set: baseSet });
  }

  async insertAsync(viewDoc) {
    if (!this.insertPolicy) throw new Meteor.Error('lens-insert', 'This view does not allow inserts');
    const baseDoc = await this.insertPolicy(viewDoc, currentCtx()); // create may be async
    if (this.onEscape === 'forbid' && !matchesWhere(baseDoc, this.where)) {
      throw new Meteor.Error('lens-escape', 'create() produced a document outside the view');
    }
    return this.base.insertAsync(baseDoc);
  }

  async removeAsync(id) {
    const p = this.removePolicy;
    if (p === 'forbid') throw new Meteor.Error('lens-remove', 'This view does not allow removes');
    const doc = await this.base.findOneAsync(id);
    if (!doc || !matchesWhere(doc, this.where)) {
      throw new Meteor.Error('lens-scope', 'Document is not in this view');
    }
    if (p === 'delete') return this.base.removeAsync(id);
    return this.base.updateAsync(id, p); // update-spec form, e.g. archive
  }
}

Meteor.lens = (base, config) => new Lens(base, config);

/**
 * Collection.version(n, { up, down }) — registers a bidirectional schema lens.
 * This build records the lenses and exposes doc-level converters; wire-level
 * per-client translation is left as the documented research frontier.
 */
Mongo.Collection.prototype.version = function version(n, { up, down }) {
  this._versionLenses = this._versionLenses || [];
  this._versionLenses.push({ version: n, up, down });
  this.upgradeDoc = (doc) =>
    this._versionLenses.reduce((d, l) => l.up(d), doc);
  this.downgradeDoc = (doc) =>
    [...this._versionLenses].reverse().reduce((d, l) => l.down(d), doc);
};
