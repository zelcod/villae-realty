/*
 * dc-lite.js — petit moteur de rendu pour les sites VILLAE.
 * Lit le gabarit <template id="dc-tpl"> et la classe Component
 * (<script type="text/x-dc">), puis affiche la page et la met à jour
 * à chaque changement d'état (thème, filtres, formulaires, cours…).
 */
(function () {
  'use strict';

  var root, tpl, comp, scheduled = false;

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch) {
    if (typeof patch === 'function') patch = patch(this.state, this.props);
    this.state = Object.assign({}, this.state, patch || {});
    schedule();
  };
  DCLogic.prototype.forceUpdate = function () { schedule(); };
  window.DCLogic = DCLogic;

  function schedule() {
    if (scheduled || !root) return;
    scheduled = true;
    Promise.resolve().then(function () { scheduled = false; render(); });
  }

  /* ---------- évaluation des {{ chemins }} ---------- */
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(expr, scope) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    var parts = expr.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function str(v) { return v == null ? '' : String(v); }
  function interp(text, scope) {
    return text.replace(HOLE, function (_, e) { return str(lookup(e, scope)); });
  }

  /* ---------- construction d'un arbre DOM neuf à partir du gabarit ---------- */
  function build(node, scope, out) {
    if (node.nodeType === 3) {
      out.appendChild(document.createTextNode(node.nodeValue.indexOf('{{') < 0 ? node.nodeValue : interp(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.localName;

    if (tag === 'sc-for') {
      var list = lookup((node.getAttribute('list') || '').replace(/^\s*\{\{|\}\}\s*$/g, ''), scope) || [];
      var as = node.getAttribute('as') || 'item';
      for (var i = 0; i < list.length; i++) {
        var s = Object.create(scope);
        s[as] = list[i];
        s.$index = i;
        kids(node, s, out);
      }
      return;
    }
    if (tag === 'sc-if') {
      var val = lookup((node.getAttribute('value') || '').replace(/^\s*\{\{|\}\}\s*$/g, ''), scope);
      if (val) kids(node, scope, out);
      return;
    }

    var el = node.cloneNode(false);
    var attrs = Array.prototype.slice.call(node.attributes);
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name, value = attrs[a].value;
      if (name.indexOf('hint-') === 0) { el.removeAttribute(name); continue; }
      if (/^on[a-z]+$/.test(name)) {
        el.removeAttribute(name);
        var m = WHOLE.exec(value);
        if (m) {
          el.__h = el.__h || {};
          el.__h[name.slice(2)] = lookup(m[1], scope);
        }
        continue;
      }
      if (value.indexOf('{{') >= 0) el.setAttribute(name, interp(value, scope));
    }
    bindEvents(el);
    kids(node, scope, el);
    out.appendChild(el);
  }
  function kids(node, scope, out) {
    var src = node.localName === 'template' ? node.content : node;
    for (var c = src.firstChild; c; c = c.nextSibling) build(c, scope, out);
  }

  /* ---------- évènements : un écouteur par type, la fonction change à chaque rendu ---------- */
  function bindEvents(el) {
    if (!el.__h) return;
    el.__bound = el.__bound || {};
    Object.keys(el.__h).forEach(function (type) {
      if (el.__bound[type]) return;
      el.__bound[type] = true;
      el.addEventListener(type, function (e) {
        var fn = el.__h && el.__h[type];
        if (typeof fn === 'function') fn(e);
      });
    });
  }

  /* ---------- mise à jour du DOM existant (garde animations et saisies) ---------- */
  function same(a, b) {
    return a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.namespaceURI === b.namespaceURI && a.localName === b.localName));
  }
  function patchChildren(live, fresh) {
    var lc = live.childNodes, fc = Array.prototype.slice.call(fresh.childNodes);
    for (var i = 0; i < fc.length; i++) {
      var l = lc[i], f = fc[i];
      if (!l) { live.appendChild(f); continue; }
      if (!same(l, f)) { live.replaceChild(f, l); continue; }
      if (l.nodeType === 3) { if (l.nodeValue !== f.nodeValue) l.nodeValue = f.nodeValue; continue; }
      if (l.nodeType === 1) patchEl(l, f);
    }
    while (live.childNodes.length > fc.length) live.removeChild(live.lastChild);
  }
  function patchEl(l, f) {
    var i, la = l.attributes, fa = f.attributes;
    for (i = la.length - 1; i >= 0; i--) if (!f.hasAttribute(la[i].name)) l.removeAttribute(la[i].name);
    for (i = 0; i < fa.length; i++) if (l.getAttribute(fa[i].name) !== fa[i].value) l.setAttribute(fa[i].name, fa[i].value);
    if (f.__h) { l.__h = f.__h; bindEvents(l); } else if (l.__h) { l.__h = null; }
    patchChildren(l, f);
  }

  function render() {
    var vals = comp.renderVals ? comp.renderVals() : {};
    var frag = document.createDocumentFragment();
    kids(tpl, vals, frag);
    if (!root.firstChild) root.appendChild(frag);
    else {
      var wrap = document.createElement('div');
      wrap.appendChild(frag);
      patchChildren(root, wrap);
    }
  }

  function start() {
    root = document.getElementById('dc-root');
    tpl = document.getElementById('dc-tpl');
    var script = document.querySelector('script[type="text/x-dc"]');
    if (!root || !tpl || !script) return;
    var props = {};
    try {
      var decl = JSON.parse(script.getAttribute('data-props') || '{}');
      Object.keys(decl).forEach(function (k) {
        if (k.charAt(0) !== '$' && decl[k] && 'default' in decl[k]) props[k] = decl[k].default;
      });
    } catch (e) {}
    var Component = new Function('DCLogic', script.textContent + '\nreturn Component;')(DCLogic);
    comp = new Component(props);
    comp.props = comp.props || props;
    comp.state = comp.state || {};
    render();
    if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
