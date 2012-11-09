/*
 * Oni Apollo 'surface/template' module
 * Lightweight cross-browser UI toolkit - Template substitution
 *
 * Part of the Oni Apollo Standard Module Library
 * Version: 'unstable'
 * http://onilabs.com/apollo
 *
 * (c) 2012 Oni Labs, http://onilabs.com
 *
 * This file is licensed under the terms of the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */
/**
   @module  surface/template
   @summary Lightweight cross-browser UI toolkit - Template substitution
   @home    apollo:surface/template
   @hostenv xbrowser
   @desc    Work-in-progress
*/
waitfor {
  var common = require('../common');
}
and {
  var coll   = require('../collection');
}
and {
  var surface   = require('./base');
}


//XXX remove me:
var logging = require("apollo:logging");


__js var TemplateElement = exports.TemplateElement = {};

function __toHtml(obj, ctx) {
  // calls obj.__toSurface() for objects that define it,
  // otherwise returns a html-sanitized toString()
  if(null == obj) {
    //logging.info("Htmlizing a NULL");
    obj = "";
  }

  if (obj instanceof Element) {
    return obj;
  }

  if(obj.__toHtml) {
    //logging.info("Htmlizing: ", obj);
    return obj.__toHtml(ctx);
  }
  //logging.info("Stringing: ", obj);
  return document.createTextNode(String(obj));
}


var logging = require("apollo:logging");
var templateSubstitutionRe = /(\{[-a-zA-Z_.0-9]+\})/;
var escapedBrace = /\\([{}])/g;

/**
   @function TemplateElement.init
   @summary Called by constructor function to initialize TemplateElement object
   @param {Object} [attribs] Hash with attributes. A shallow copy of this object will be passed to [::HtmlFragmentElement::init] as the result of each `render()` call.
*/
TemplateElement.init = function(attribs) {
  if (typeof attribs.content != 'string') {
    throw new Error("Template content must be a string");
  }
  this._attribs = attribs;
}

TemplateElement.__toHtml = function(ctx) {
  logging.debug("rendering sub-template: ", this._attribs, ctx);
  return __toHtml(this.render(ctx));
}

TemplateElement.render = function(values) {
  var dompeer = surface.UIElement._init_dompeer(this._attribs.content);
  this._supplant(dompeer, values);
  return surface.Html(common.mergeSettings(this._attribs, {content: dompeer}));
};

_lookup_value = function(path, values) {
  // path is a full template string, e.g "{obj.prop}"
  path = path.slice(1, -1).split(".");
  logging.debug("Lookup: " + path, values);
  var obj = values;
  if (path.length == 0) obj = "";
  for (var i=0; i<path.length; i++) {
    if(obj == undefined) {
      return "";
    }
    obj = obj[path[i]];
  }
  if(obj instanceof Function) { obj = obj(values); };
  logging.debug("resolved", path, "to", obj);
  return obj, values;
}


TemplateElement._supplantStringWithConverters = function(str, values, substitution_filter, text_filter, action) {
  // like common.supplant, but returns a list of objects which are either strings or DOM elements.
  // This is used when substitutions appear in the content of a DOM node, as it can have nested items.
  var parts = str.split(templateSubstitutionRe);
  logging.debug("got parts ", parts);
  var replaced = false;
  var replacements = coll.map(parts, function (part) {
    if(part.match(templateSubstitutionRe)) {
      logging.debug("replacing ", part);
      replaced = true;
      var value = _lookup_value(part, values);
      return substitution_filter ? substitution_filter(value) : value;
    } else {
      logging.debug("Literal: " + part);
      if(part.search(escapedBrace) != -1) {
        replaced = true;
        logging.debug("replacing escaped braces: " + part + " to: " + part.replace(escapedBrace, "$1"));
        part = part.replace(escapedBrace, "$1");
      }
      return text_filter(part);
    }
  });
  if(replaced) {
    action(replacements);
  };
};

TemplateElement._supplantString = function (str, values, action) {
  var passthru = function(t) { return t; };
  // run replacements on a string, coercing the result into a string.
  return this._supplantStringWithConverters(str, values,
    String, // replacement filter
    passthru, // literal filter
    {|parts| action(parts.join(""))});
};


TemplateElement._supplantDom = function(str, values, action) {
  return this._supplantStringWithConverters(str, values,
    {|obj| __toHtml(obj, values); }, // replacement filter
    {|t| document.createTextNode(t); }, // literal filter
    action);
};

TemplateElement._supplant = function(elem, values, parentNode) {
  logging.debug("_supplant called on " + elem.nodeName, elem);
  if (elem.nodeType == document.TEXT_NODE) {
    logging.debug("supplanting text node: " + elem.textContent);
    // we never create a top-level TEXT_NODE, so `parentNode`
    // will always be defined in this case.
    this._supplantDom(elem.nodeValue, values, {|replacements|
      coll.each(replacements, {|replacement|
        //logging.debug("Inserting replacement", replacement, "into", parentNode, "before", elem);
        parentNode.insertBefore(replacement, elem);
      });
      parentNode.removeChild(elem);
    });
    //logging.debug("post-supplantDom: ", parentNode);
    return;
  }

  // replace all attributes
  var attrs = elem.attributes;
  //logging.debug("supplanting attributes:", attrs);
  for (var i = 0; i < attrs.length; i++) {
    var attr = attrs[i];
    logging.debug("supplanting attr: ", attr, attr.value);
    this._supplantString(attr.value, values, {|r| elem.setAttribute(attr.name, r)});
  }

  // apply supplant on all child nodes
  logging.debug("supplanting children of: " + elem.nodeName);
  coll.each(Array.prototype.slice.call(elem.childNodes), function(child) {
    if(child.nodeType == document.TEXT_NODE || child.nodeType == document.ELEMENT_NODE) {
      logging.debug("supplanting child: ", child);
      this._supplant(child, values, elem);
    } else {
      logging.debug("ignoring child: ", child);
    }
  }, this);
};

exports.Template = function(attribs) {
  if (typeof attribs != 'object')
    attribs = { content: attribs }
  var obj = Object.create(TemplateElement);
  obj.init(attribs);
  return obj;
}
